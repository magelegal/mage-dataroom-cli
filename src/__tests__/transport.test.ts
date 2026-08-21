import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError, MageClient } from '../client'
import {
  DirectUploadUnavailable,
  resolveUploadMode,
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
const realMode = process.env.MAGE_UPLOAD_MODE

let dir: string
let filePath: string
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
  delete process.env.MAGE_UPLOAD_MODE
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
  if (realMode === undefined) delete process.env.MAGE_UPLOAD_MODE
  else process.env.MAGE_UPLOAD_MODE = realMode
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
})

test('a storage-leg failure falls back to the proxied POST for that file', async () => {
  routes = [
    ['/documents/initiate', () => json(plan())],
    [
      `${STORAGE}/part/`,
      () => {
        throw new TypeError('fetch failed')
      },
    ],
    [
      '/rooms/room1/documents',
      () => json({ id: 'd-proxied', name: 'x.pdf', status: 'processing' }, 201),
    ],
  ]
  const client = new MageClient(API, 'k')

  const { doc, transport } = await uploadFile(client, 'room1', item(), 'direct')

  expect(doc.id).toBe('d-proxied')
  expect(transport).toBe('proxied')
  // The fallback carried the actual bytes as multipart form data.
  const proxied = calls[calls.length - 1]!
  expect(proxied.body).toBeInstanceOf(FormData)
})

test('an API-side failure propagates instead of falling back', async () => {
  routes = [['/documents/initiate', () => json({ detail: 'File size exceeds the limit' }, 422)]]
  const client = new MageClient(API, 'k')

  try {
    await uploadFile(client, 'room1', item(), 'direct')
    throw new Error('expected a rejection')
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(422)
  }
  // Never attempted the proxied POST — the API is the same on both paths.
  expect(calls.filter((c) => c.body instanceof FormData)).toHaveLength(0)
})

test('exhausted part retries surface as DirectUploadUnavailable', async () => {
  routes = [
    ['/documents/initiate', () => json(plan({ totalParts: 1, presignedUrls: { '1': `${STORAGE}/part/1` } }))],
    [`${STORAGE}/part/1`, () => new Response(null, { status: 500 })],
  ]
  const client = new MageClient(API, 'k')

  expect(uploadFileDirect(client, 'room1', item())).rejects.toBeInstanceOf(DirectUploadUnavailable)
})

test('an empty file fails with a clear message before any request', async () => {
  writeFileSync(filePath, '')
  const client = new MageClient(API, 'k')

  expect(uploadFile(client, 'room1', item(), 'direct')).rejects.toThrow('x.pdf is empty.')
  expect(calls).toHaveLength(0)
})

test('resolveUploadMode: probe PUT success → direct, failure → proxied', async () => {
  const probe = { url: `${STORAGE}/probe`, key: 'probes/x', expiresIn: 60, byteLength: 8 }
  routes = [
    ['/upload-probe', () => json(probe)],
    [
      `${STORAGE}/probe`,
      (call) => {
        // The URL is signed for exactly byteLength bytes.
        expect((call.body as Uint8Array).byteLength).toBe(8)
        return new Response(null, { status: 200 })
      },
    ],
  ]
  const client = new MageClient(API, 'k')
  expect(await resolveUploadMode(client, 'room1')).toBe('direct')

  routes = [
    ['/upload-probe', () => json(probe)],
    [
      `${STORAGE}/probe`,
      () => {
        throw new TypeError('fetch failed')
      },
    ],
  ]
  expect(await resolveUploadMode(client, 'room1')).toBe('proxied')
})

test('resolveUploadMode: a probe-issue failure fails open to direct', async () => {
  routes = [['/upload-probe', () => json({ detail: 'nope' }, 500)]]
  const client = new MageClient(API, 'k')

  expect(await resolveUploadMode(client, 'room1')).toBe('direct')
})

test('MAGE_UPLOAD_MODE skips the probe entirely', async () => {
  process.env.MAGE_UPLOAD_MODE = 'proxied'
  const client = new MageClient(API, 'k')

  expect(await resolveUploadMode(client, 'room1')).toBe('proxied')
  expect(calls).toHaveLength(0)
})
