import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindRoom, chooseRoom } from '../binding'
import type { LiteRoom } from '../client'
import { MageClient } from '../client'
import { loadConfig, saveConfig } from '../config'
import { CliError } from '../context'

function room(overrides: Partial<LiteRoom>): LiteRoom {
  return {
    id: 'room_a',
    name: 'Seed Round',
    companyName: null,
    fundingStage: null,
    documentCount: 3,
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    teamNdaRequired: false,
    teamNdaAccepted: true,
    ...overrides,
  }
}

const ROOMS = [room({}), room({ id: 'room_b', name: 'Series A' })]

// ── chooseRoom (selector resolution; the interactive picker needs a TTY) ────

test('chooseRoom matches an exact id, then a case-insensitive exact name', async () => {
  expect((await chooseRoom(ROOMS, 'room_b')).name).toBe('Series A')
  expect((await chooseRoom(ROOMS, 'series a')).id).toBe('room_b')
})

test('chooseRoom rejects an unknown selector, an ambiguous name, and an empty org', async () => {
  expect(chooseRoom(ROOMS, 'Bridge')).rejects.toThrow('No room matches "Bridge"')
  const dupes = [...ROOMS, room({ id: 'room_c', name: 'series a' })]
  expect(chooseRoom(dupes, 'Series A')).rejects.toThrow('Several rooms are named')
  expect(chooseRoom([], undefined)).rejects.toThrow('no data rooms yet')
})

test('chooseRoom auto-picks the only room without prompting', async () => {
  expect((await chooseRoom([ROOMS[0]!], undefined)).id).toBe('room_a')
})

// ── bindRoom (mint + retire + persist; fetch mocked, config in a tmp dir) ───

let tmp: string
let requests: Array<{ url: string; body?: string }>
let mintResponse: () => Response
const realFetch = globalThis.fetch
const envBackup = { ...process.env }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mage-cli-bind-'))
  process.env.XDG_CONFIG_HOME = tmp
  requests = []
  mintResponse = () =>
    new Response(
      JSON.stringify({ id: 'key_new', name: 'CLI — host', keyPrefix: 'mk_live_ab', key: 'mk_live_new' }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const request = { url: String(url), body: (init as { body?: string }).body }
    requests.push(request)
    if (request.url.endsWith('/revoke')) return new Response('{"ok":true}', { status: 200 })
    return mintResponse()
  }) as typeof fetch
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  globalThis.fetch = realFetch
  process.env = { ...envBackup }
})

const bearer = () => new MageClient('https://api.example.com', { kind: 'bearer', token: 'jwt' })

test('bindRoom mints a key, retires the CLI-minted key it replaces, and persists the binding', async () => {
  saveConfig({ apiKey: 'mk_live_old', apiKeyId: 'key_old', roomId: 'room_old', baseUrl: 'https://api.example.com' })

  const minted = await bindRoom(bearer(), ROOMS[1]!, 'https://api.example.com')

  expect(minted.key).toBe('mk_live_new')
  expect(requests[0]!.url).toContain('/rooms/room_b/api-keys')
  expect(requests[1]!.url).toContain('/rooms/room_old/api-keys/key_old/revoke')
  const cfg = loadConfig()
  expect(cfg).toMatchObject({ apiKey: 'mk_live_new', apiKeyId: 'key_new', roomId: 'room_b', roomName: 'Series A' })
})

test('bindRoom never revokes a hand-minted key (no stored id) and survives a failed revoke', async () => {
  saveConfig({ apiKey: 'mk_live_manual', roomId: 'room_old' }) // no apiKeyId — hand-minted
  await bindRoom(bearer(), ROOMS[0]!, 'https://api.example.com')
  expect(requests.some((r) => r.url.includes('/revoke'))).toBe(false)

  // A revoke that 404s (role changed, room gone) must not break the bind.
  saveConfig({ apiKey: 'mk_live_cli', apiKeyId: 'key_x', roomId: 'room_gone' })
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith('/revoke')) return new Response('{"detail":"API key not found"}', { status: 404 })
    return mintResponse()
  }) as typeof fetch
  await bindRoom(bearer(), ROOMS[1]!, 'https://api.example.com')
  expect(loadConfig().apiKey).toBe('mk_live_new')
})

test('a 404 on mint (the admin gate) becomes the owner/admin guidance, not "room not found"', async () => {
  mintResponse = () =>
    new Response('{"detail":"Room not found"}', { status: 404, headers: { 'content-type': 'application/json' } })

  try {
    await bindRoom(bearer(), ROOMS[0]!, 'https://api.example.com')
    throw new Error('expected a rejection')
  } catch (err) {
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toContain('owner or admin')
    expect((err as CliError).message).toContain('mage login <key>')
  }
})
