import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError, MageClient } from '../client'
import {
  bothRoadsFailedMessage,
  isRelayPinned,
  resetRelayPin,
  setRetryPause,
  uploadFile,
  uploadFileDirect,
} from '../commands/dataroom/transport'

const API = 'https://api.example.com'
const STORAGE = 'https://storage.example'

interface Call {
  url: string
  method?: string
  body?: unknown
}

let calls: Call[]
/** URL-routed fetch mock: `routes` maps a substring to its handler. */
let routes: Array<[string, (call: Call) => Response | Promise<Response>]>
const realFetch = globalThis.fetch

let dir: string
let filePath: string
/** Each pause the transport asked for between attempts, in order. Recorded,
    never slept: the tests assert the schedule, not the clock. */
let pauses: number[]
const FILE_CONTENT = Buffer.from('0123456789') // 10 bytes → 3 parts at chunkSize 4
const FILE_SHA256 = createHash('sha256').update(FILE_CONTENT).digest('hex')

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    uploadId: 'u1',
    s3Key: 'rooms/room1/x.pdf',
    chunkSize: 4,
    totalParts: 3,
    presignedUrls: {
      '1': `${STORAGE}/part/1`,
      '2': `${STORAGE}/part/2`,
      '3': `${STORAGE}/part/3`,
    },
    expiresIn: 3600,
    ...overrides,
  }
}

beforeEach(() => {
  resetRelayPin()
  pauses = []
  setRetryPause(async (ms) => {
    pauses.push(ms)
  })
  calls = []
  routes = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const call: Call = { url: String(url), method: init?.method, body: init?.body }
    calls.push(call)
    for (const [match, handler] of routes) {
      if (call.url.includes(match)) return handler(call)
    }
    throw new Error(`unrouted fetch: ${call.url}`)
  }) as typeof fetch
  dir = mkdtempSync(join(tmpdir(), 'mage-transport-'))
  filePath = join(dir, 'x.pdf')
  writeFileSync(filePath, FILE_CONTENT)
})

afterEach(() => {
  globalThis.fetch = realFetch
  resetRelayPin()
  setRetryPause()
  rmSync(dir, { recursive: true, force: true })
})

const item = () => ({ absPath: filePath, filename: 'x.pdf', folderPath: 'Legal' })

test('uploadFileDirect slices per the plan, strips ETag quotes, and completes with hash + folder', async () => {
  const putBodies: Buffer[] = []
  routes = [
    ['/documents/initiate', () => json(plan())],
    [
      `${STORAGE}/part/`,
      (call) => {
        putBodies.push(Buffer.from(call.body as Uint8Array))
        return new Response(null, { status: 200, headers: { etag: `"etag-${putBodies.length}"` } })
      },
    ],
    ['/documents/u1/complete', () => json({ id: 'd1', name: 'x.pdf', status: 'processing' }, 201)],
  ]
  const client = new MageClient(API, 'k')

  const doc = await uploadFileDirect(client, 'room1', item())

  expect(doc.id).toBe('d1')
  expect(putBodies.map((b) => b.toString())).toEqual(['0123', '4567', '89'])
  const complete = calls.find((c) => c.url.includes('/complete'))!
  expect(JSON.parse(complete.body as string)).toEqual({
    parts: [
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
      { partNumber: 3, etag: 'etag-3' },
    ],
    fileHash: FILE_SHA256,
    folderPath: 'Legal',
  })
})

test('an expired part URL re-signs and retries instead of failing the file', async () => {
  let firstPut = true
  routes = [
    ['/documents/initiate', () => json(plan({ totalParts: 1, presignedUrls: { '1': `${STORAGE}/part/stale` } }))],
    [
      `${STORAGE}/part/stale`,
      () => {
        firstPut = false
        return new Response(null, { status: 403 })
      },
    ],
    [`${STORAGE}/part/fresh`, () => new Response(null, { status: 200, headers: { etag: '"e1"' } })],
    ['/sign-part', () => json({ presignedUrl: `${STORAGE}/part/fresh`, expiresIn: 3600 })],
    ['/documents/u1/complete', () => json({ id: 'd1', name: 'x.pdf', status: 'processing' }, 201)],
  ]
  const client = new MageClient(API, 'k')

  const doc = await uploadFileDirect(client, 'room1', item())

  expect(doc.id).toBe('d1')
  expect(firstPut).toBe(false)
  expect(calls.some((c) => c.url.includes('/sign-part'))).toBe(true)
  // A 403 is storage answering, so the part stays on the direct road.
  expect(calls.some((c) => c.url.includes('/documents/u1/part/'))).toBe(false)
  expect(isRelayPinned()).toBe(false)
  // A fresh URL fixes an expired one; there is nothing to wait out.
  expect(pauses).toEqual([])
})

test('a part whose storage PUT gets no response is relayed through the API, and the run pins', async () => {
  const relayed: Array<{ url: string; body: string }> = []
  routes = [
    ['/documents/initiate', () => json(plan())],
    [
      `${STORAGE}/part/`,
      () => {
        throw new TypeError('fetch failed')
      },
    ],
    [
      '/rooms/room1/documents/u1/part/',
      (call) => {
        relayed.push({ url: call.url, body: Buffer.from(call.body as Uint8Array).toString() })
        return new Response(null, { status: 200, headers: { etag: `"relay-${relayed.length}"` } })
      },
    ],
    ['/documents/u1/complete', () => json({ id: 'd1', name: 'x.pdf', status: 'processing' }, 201)],
  ]
  const client = new MageClient(API, 'k')

  const doc = await uploadFile(client, 'room1', item())

  expect(doc.id).toBe('d1')
  expect(isRelayPinned()).toBe(true)
  // Only part 1 ever tried storage: its silence pinned the run, so parts 2
  // and 3 went straight to the relay.
  expect(calls.filter((c) => c.url.startsWith(STORAGE)).map((c) => c.url)).toEqual([
    `${STORAGE}/part/1`,
  ])
  expect(relayed).toEqual([
    { url: `${API}/api/v1/lite/rooms/room1/documents/u1/part/1`, body: '0123' },
    { url: `${API}/api/v1/lite/rooms/room1/documents/u1/part/2`, body: '4567' },
    { url: `${API}/api/v1/lite/rooms/room1/documents/u1/part/3`, body: '89' },
  ])
  const complete = calls.find((c) => c.url.includes('/complete'))!
  expect(JSON.parse(complete.body as string).parts).toEqual([
    { partNumber: 1, etag: 'relay-1' },
    { partNumber: 2, etag: 'relay-2' },
    { partNumber: 3, etag: 'relay-3' },
  ])
})

test('a relayed part that also gets no response unpins and tries storage again', async () => {
  let relayAttempts = 0
  routes = [
    ['/documents/initiate', () => json(plan({ totalParts: 1, presignedUrls: { '1': `${STORAGE}/part/1` } }))],
    [
      `${STORAGE}/part/1`,
      () => {
        // Storage is silent once, then answers: an offline blip, not a firewall.
        if (calls.filter((c) => c.url.startsWith(STORAGE)).length === 1) {
          throw new TypeError('fetch failed')
        }
        return new Response(null, { status: 200, headers: { etag: '"direct-1"' } })
      },
    ],
    [
      '/rooms/room1/documents/u1/part/',
      () => {
        relayAttempts += 1
        throw new TypeError('fetch failed')
      },
    ],
    ['/documents/u1/complete', () => json({ id: 'd1', name: 'x.pdf', status: 'processing' }, 201)],
  ]
  const client = new MageClient(API, 'k')

  const doc = await uploadFile(client, 'room1', item())

  expect(doc.id).toBe('d1')
  expect(relayAttempts).toBe(1)
  expect(isRelayPinned()).toBe(false)
})

test('an API-side failure propagates', async () => {
  routes = [['/documents/initiate', () => json({ detail: 'File size exceeds the limit' }, 422)]]
  const client = new MageClient(API, 'k')

  try {
    await uploadFile(client, 'room1', item())
    throw new Error('expected a rejection')
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(422)
  }
  expect(calls).toHaveLength(1)
})

test('a relay the API refuses fails the file with the API verdict', async () => {
  routes = [
    ['/documents/initiate', () => json(plan({ totalParts: 1, presignedUrls: { '1': `${STORAGE}/part/1` } }))],
    [
      `${STORAGE}/part/1`,
      () => {
        throw new TypeError('fetch failed')
      },
    ],
    ['/rooms/room1/documents/u1/part/', () => json({ detail: 'Upload session is gone' }, 410)],
  ]
  const client = new MageClient(API, 'k')

  try {
    await uploadFile(client, 'room1', item())
    throw new Error('expected a rejection')
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(410)
  }
})

test('exhausted part retries fail the file with the last storage verdict', async () => {
  routes = [
    ['/documents/initiate', () => json(plan({ totalParts: 1, presignedUrls: { '1': `${STORAGE}/part/1` } }))],
    [`${STORAGE}/part/1`, () => new Response(null, { status: 500 })],
  ]
  const client = new MageClient(API, 'k')

  await expect(uploadFileDirect(client, 'room1', item())).rejects.toThrow(
    'storage rejected part 1 (HTTP 500)',
  )
  // Three tries at the same road, with a growing pause before each retry.
  expect(pauses).toEqual([500, 1000])
})

// ── Both roads fail ──────────────────────────────────────────────────────────
// Storage and the relay both get no response: the file fails with a sentence
// that says what happened and what to do, never the raw "fetch failed" of the
// last try, and the tries do not fire back to back.

/** A thrown fetch the way undici throws one: a bare TypeError wrapping the
    socket error that says why. */
function refused(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED 192.0.2.1:443'), { code: 'ECONNREFUSED' })
  return new TypeError('fetch failed', { cause })
}

test('when storage and the relay both get no response, the file fails in plain words', async () => {
  routes = [
    ['/documents/initiate', () => json(plan({ totalParts: 1, presignedUrls: { '1': `${STORAGE}/part/1` } }))],
    [
      `${STORAGE}/part/1`,
      () => {
        throw new TypeError('fetch failed')
      },
    ],
    [
      '/rooms/room1/documents/u1/part/',
      () => {
        throw refused()
      },
    ],
  ]
  const client = new MageClient(API, 'k')

  let message = ''
  try {
    await uploadFile(client, 'room1', item())
    throw new Error('expected a rejection')
  } catch (err) {
    message = (err as Error).message
  }

  expect(message).toBe(bothRoadsFailedMessage('connect ECONNREFUSED 192.0.2.1:443'))
  expect(message).toContain('run the same upload again')
  expect(message).not.toContain('fetch failed')
  // Storage, then the relay at once (a different road), then storage again
  // after a pause.
  expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual([
    `${STORAGE}/part/1`,
    `${API}/api/v1/lite/rooms/room1/documents/u1/part/1`,
    `${STORAGE}/part/1`,
  ])
  expect(pauses).toEqual([500])
  // Nothing was assembled from a part that never landed.
  expect(calls.some((c) => c.url.includes('/complete'))).toBe(false)
})

test('a storage answer outlives a later try that got no response at all', async () => {
  let storageCalls = 0
  routes = [
    [
      '/documents/initiate',
      () => json(plan({ totalParts: 1, presignedUrls: { '1': `${STORAGE}/part/1` } })),
    ],
    [
      `${STORAGE}/part/1`,
      () => {
        storageCalls += 1
        // Storage answers twice with an error, then goes silent on the last try.
        if (storageCalls < 3) return new Response(null, { status: 500 })
        throw new TypeError('fetch failed')
      },
    ],
  ]
  const client = new MageClient(API, 'k')

  await expect(uploadFile(client, 'room1', item())).rejects.toThrow('storage rejected part 1 (HTTP 500)')
  expect(storageCalls).toBe(3)
  expect(pauses).toEqual([500, 1000])
})

test('a relay server error that never clears fails with the relay sentence', async () => {
  routes = [
    [
      '/documents/initiate',
      () => json(plan({ totalParts: 1, presignedUrls: { '1': `${STORAGE}/part/1` } })),
    ],
    [
      `${STORAGE}/part/1`,
      () => {
        throw new TypeError('fetch failed')
      },
    ],
    ['/rooms/room1/documents/u1/part/', () => json({ detail: 'The relay is busy. Try again soon.' }, 503)],
  ]
  const client = new MageClient(API, 'k')

  await expect(uploadFile(client, 'room1', item())).rejects.toThrow('The relay is busy. Try again soon.')
  // The switch to the relay is immediate; the relay's own retry waits.
  expect(pauses).toEqual([500])
})

test('an empty file fails with a clear message before any request', async () => {
  writeFileSync(filePath, '')
  const client = new MageClient(API, 'k')

  expect(uploadFile(client, 'room1', item())).rejects.toThrow('x.pdf is empty.')
  expect(calls).toHaveLength(0)
})
