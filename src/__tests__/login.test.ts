import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginCommand } from '../commands/dataroom/login'
import { loadConfig, saveConfig } from '../config'

let tmp: string
let requests: string[]
const realFetch = globalThis.fetch
const envBackup = { ...process.env }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mage-cli-login-'))
  process.env.XDG_CONFIG_HOME = tmp
  delete process.env.MAGE_API_KEY
  requests = []
  globalThis.fetch = (async (url: unknown) => {
    requests.push(String(url))
    return new Response(JSON.stringify({ roomId: 'room_1', roomName: 'Seed Round', keyName: 'CI uploader' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  globalThis.fetch = realFetch
  process.env = { ...envBackup }
})

test('key login still resolves the room via /cli/context and stores the key', async () => {
  await loginCommand('mk_live_pasted', { apiUrl: 'https://api.example.com', json: true })

  expect(requests[0]).toBe('https://api.example.com/api/v1/lite/cli/context')
  expect(loadConfig()).toMatchObject({ apiKey: 'mk_live_pasted', roomId: 'room_1', roomName: 'Seed Round' })
})

test('key login replaces a previous browser login wholesale (no stale session or key id)', async () => {
  saveConfig({
    apiKey: 'mk_live_cli_minted',
    apiKeyId: 'key_1',
    oauth: { accessToken: 'at', refreshToken: 'rt', clientId: 'c1' },
  })

  await loginCommand('mk_live_pasted', { apiUrl: 'https://api.example.com', json: true })

  const cfg = loadConfig()
  expect(cfg.apiKey).toBe('mk_live_pasted')
  expect(cfg.apiKeyId).toBeUndefined()
  expect(cfg.oauth).toBeUndefined()
})

test('MAGE_API_KEY forces the key path — no browser flow starts', async () => {
  process.env.MAGE_API_KEY = 'mk_live_env'

  await loginCommand(undefined, { apiUrl: 'https://api.example.com', json: true })

  // Only the context probe ran; nothing touched WorkOS.
  expect(requests).toHaveLength(1)
  expect(requests[0]).toContain('/cli/context')
  expect(loadConfig().apiKey).toBe('mk_live_env')
})

test('zero-room browser login without a TTY warns and never creates a room', async () => {
  // Bare login in --json (non-interactive): the whole device flow runs against
  // the mocked fetch, the org has no rooms, and the CLI must NOT invent one.
  process.env.MAGE_OAUTH_CLIENT_ID = 'client_test'
  const jwt = `h.${Buffer.from(JSON.stringify({ exp: 9_999_999_999 })).toString('base64url')}.s`
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const u = String(url)
    requests.push(`${(init as { method?: string })?.method ?? 'GET'} ${u}`)
    if (u.endsWith('/authorize/device')) {
      return Response.json({
        device_code: 'dev',
        user_code: 'CODE',
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete: 'https://auth.example.com/device?user_code=CODE',
        expires_in: 60,
        interval: 0, // pollForTokens clamps to a 1s sleep — keeps the test quick
      })
    }
    if (u.endsWith('/user_management/authenticate')) {
      return Response.json({ access_token: jwt, refresh_token: 'rt', user: { email: 'founder@example.com' } })
    }
    if (u.endsWith('/me')) return Response.json({ userId: 'u1', email: 'founder@example.com', orgId: 'org1' })
    if (u.endsWith('/rooms')) return Response.json([])
    throw new Error(`unexpected request: ${u}`)
  }) as typeof fetch

  await loginCommand(undefined, { apiUrl: 'https://api.example.com', json: true, noBrowser: true })

  expect(requests.some((r) => r.startsWith('POST') && r.endsWith('/rooms'))).toBe(false)
  expect(loadConfig().oauth?.refreshToken).toBe('rt') // session still saved for `mage use` later
  expect(loadConfig().apiKey).toBeUndefined()
}, 10_000)
