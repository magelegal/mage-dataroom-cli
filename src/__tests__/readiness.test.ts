import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Coverage, CoverageItem } from '../client'
import { MageClient } from '../client'
import { attachToItem } from '../commands/dataroom/readiness'
import { CliError } from '../context'

function item(partial: Partial<CoverageItem> & { itemId: string }): CoverageItem {
  return {
    label: 'Example item',
    requirementLevel: 'required',
    status: 'missing',
    matchedDocumentIds: [],
    completed: false,
    section: 'Corporate',
    expectedScope: 'Everything investors expect for this item.',
    founderHint: 'Check your records.',
    multiDoc: true,
    ...partial,
  }
}

function coverage(items: CoverageItem[], computed = true): Coverage {
  return {
    roomId: 'room1',
    computed,
    missingRequiredCount: items.filter(
      (i) => i.status === 'missing' && i.requirementLevel === 'required',
    ).length,
    computedAt: computed ? '2026-01-01T00:00:00Z' : null,
    items,
  }
}

// ── Client methods (wire contract) ─────────────────────────────────────────

interface Call {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: unknown }
}

let calls: Call[]
let responder: () => Response
const realFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  responder = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as Call['init'] })
    return responder()
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

test('getCoverage hits the room coverage path with the X-API-Key header', async () => {
  responder = () =>
    new Response(JSON.stringify(coverage([item({ itemId: 'item-1' })])), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const client = new MageClient('https://api.example.com', 'mk_live_x')

  const cov = await client.getCoverage('room1')

  expect(cov.items[0]!.itemId).toBe('item-1')
  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/rooms/room1/coverage')
  expect(calls[0]!.init.method).toBe('GET')
  expect(calls[0]!.init.headers!['X-API-Key']).toBe('mk_live_x')
})

test('setCoverageItem PUTs the full documentIds set as camelCase JSON', async () => {
  responder = () =>
    new Response(JSON.stringify(coverage([item({ itemId: 'item-1', status: 'partial' })])), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const client = new MageClient('https://api.example.com', 'k')

  await client.setCoverageItem('room1', 'item-1', ['d1', 'd2'])

  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/rooms/room1/coverage/items/item-1')
  expect(calls[0]!.init.method).toBe('PUT')
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ documentIds: ['d1', 'd2'] })
})

// ── attachToItem (the additive-link semantics both attach paths share) ──────

/** A stub client capturing setCoverageItem writes over a fixed coverage read. */
function stubClient(cov: Coverage) {
  const writes: { itemId: string; documentIds: string[] }[] = []
  const client = {
    getCoverage: async () => cov,
    setCoverageItem: async (_room: string, itemId: string, documentIds: string[]) => {
      writes.push({ itemId, documentIds })
      return cov
    },
  } as unknown as MageClient
  return { client, writes }
}

test('attachToItem merges new documents with what is already attached', async () => {
  const cov = coverage([item({ itemId: 'item-1', matchedDocumentIds: ['d1'] })])
  const { client, writes } = stubClient(cov)

  await attachToItem(client, 'room1', 'item-1', ['d2', 'd1'])

  // Existing attachment kept, addition appended, duplicate collapsed — the PUT
  // takes the FULL desired set, so dropping d1 here would detach it.
  expect(writes).toEqual([{ itemId: 'item-1', documentIds: ['d1', 'd2'] }])
})

test('attachToItem rejects an unknown item id with a pointer to `mage readiness`', async () => {
  const { client, writes } = stubClient(coverage([item({ itemId: 'item-1' })]))

  await expect(attachToItem(client, 'room1', 'no-such-item', ['d1'])).rejects.toThrow(CliError)
  expect(writes).toEqual([])
})

test('attachToItem before the first analysis defers item validation to the server', async () => {
  // computed=false → no items yet locally; the server still validates the id.
  const { client, writes } = stubClient(coverage([], false))

  await attachToItem(client, 'room1', 'item-1', ['d1'])

  expect(writes).toEqual([{ itemId: 'item-1', documentIds: ['d1'] }])
})
