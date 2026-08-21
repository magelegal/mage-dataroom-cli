import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ApiError, MageClient, fetchAuthConfig } from '../client'

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

test('listDocuments hits the room path with the X-API-Key header', async () => {
  responder = () =>
    new Response(JSON.stringify([{ id: 'd1', name: 'a.pdf', status: 'ready' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const client = new MageClient('https://api.example.com', 'mk_live_x')

  const docs = await client.listDocuments('room1')

  expect(docs[0]!.id).toBe('d1')
  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/rooms/room1/documents')
  expect(calls[0]!.init.method).toBe('GET')
  expect(calls[0]!.init.headers!['X-API-Key']).toBe('mk_live_x')
})

test('uploadDocument posts multipart with the file and folder_path field', async () => {
  let captured: Call['init'] | undefined
  responder = () =>
    new Response(JSON.stringify({ id: 'd9', name: 'x.pdf', status: 'processing' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    captured = init as Call['init']
    return responder()
  }) as typeof fetch

  const client = new MageClient('https://api.example.com', 'k')
  const doc = await client.uploadDocument('room1', {
    filename: 'x.pdf',
    content: new TextEncoder().encode('hi'),
    folderPath: 'Legal',
  })

  expect(doc.id).toBe('d9')
  expect(captured!.method).toBe('POST')
  const body = captured!.body as FormData
  expect(body).toBeInstanceOf(FormData)
  expect(body.get('folder_path')).toBe('Legal')
  expect(body.get('file')).toBeInstanceOf(Blob)
})

test('createFolder sends folderPath as a JSON body', async () => {
  let captured: Call['init'] | undefined
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    captured = init as Call['init']
    return new Response(JSON.stringify({ folders: ['Legal'] }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const client = new MageClient('https://api.example.com', 'k')
  const res = await client.createFolder('room1', 'Legal')

  expect(res.folders).toEqual(['Legal'])
  expect(JSON.parse(captured!.body as string)).toEqual({ folderPath: 'Legal' })
  expect(captured!.headers!['Content-Type']).toBe('application/json')
})

test('deleteDocument resolves on a 204 with no body', async () => {
  responder = () => new Response(null, { status: 204 })
  const client = new MageClient('https://api.example.com', 'k')

  await client.deleteDocument('room1', 'd1') // must not throw on empty body

  expect(calls[0]!.init.method).toBe('DELETE')
})

test('bearer auth sends Authorization instead of X-API-Key', async () => {
  const client = new MageClient('https://api.example.com', { kind: 'bearer', token: 'jwt-1' })

  await client.listRooms()

  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/rooms')
  expect(calls[0]!.init.headers!.Authorization).toBe('Bearer jwt-1')
  expect(calls[0]!.init.headers!['X-API-Key']).toBeUndefined()
})

test('mintApiKey posts the key name + explicit permissions; revokeApiKey hits the revoke path', async () => {
  responder = () =>
    new Response(
      JSON.stringify({ id: 'key_1', name: 'CLI — laptop', keyPrefix: 'mk_live_ab', key: 'mk_live_secret' }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  const client = new MageClient('https://api.example.com', { kind: 'bearer', token: 'jwt-1' })

  const minted = await client.mintApiKey('room1', 'CLI — laptop')
  expect(minted.key).toBe('mk_live_secret')
  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/rooms/room1/api-keys')
  // Permissions are explicit so the CLI's contract is pinned here: read +
  // download + organize, never room management.
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
    name: 'CLI — laptop',
    permissions: ['room:view', 'room:download', 'room:edit'],
  })

  responder = () => new Response('{"ok":true}', { status: 200 })
  await client.revokeApiKey('room1', 'key_1')
  expect(calls[1]!.url).toBe('https://api.example.com/api/v1/lite/rooms/room1/api-keys/key_1/revoke')
  expect(calls[1]!.init.method).toBe('POST')
})

test('fetchAuthConfig is unauthenticated and reads the camelCase clientId', async () => {
  responder = () =>
    new Response('{"clientId":"client_x"}', { status: 200, headers: { 'content-type': 'application/json' } })

  const cfg = await fetchAuthConfig('https://api.example.com')

  expect(cfg.clientId).toBe('client_x')
  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/cli/auth-config')
  expect(calls[0]!.init.headers!['X-API-Key']).toBeUndefined()
  expect(calls[0]!.init.headers!.Authorization).toBeUndefined()
})

test('a JSON error body becomes an ApiError carrying status + detail', async () => {
  responder = () =>
    new Response(JSON.stringify({ detail: 'Room not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  const client = new MageClient('https://api.example.com', 'k')

  try {
    await client.listDocuments('room1')
    throw new Error('expected a rejection')
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(404)
    expect((err as ApiError).detail).toBe('Room not found')
  }
})

test('a connection that never establishes reports "Could not reach"', async () => {
  responder = () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
        code: 'ECONNREFUSED',
      }),
    })
  }
  const client = new MageClient('https://api.example.com', 'k')

  try {
    await client.listDocuments('room1')
    throw new Error('expected a rejection')
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).detail).toContain('Could not reach https://api.example.com')
    expect((err as ApiError).detail).toContain('ECONNREFUSED')
  }
})

test('a connection dropped mid-request does not claim the API is unreachable', async () => {
  // undici's shape when the server (or a hop in between) tears the connection
  // down while the request body is still in flight — the failure large uploads
  // hit on unstable network paths. The API answered the dial, so "could not
  // reach" would be a lie that sends the user to a status page.
  responder = () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    })
  }
  const client = new MageClient('https://api.example.com', 'k')

  try {
    await client.listDocuments('room1')
    throw new Error('expected a rejection')
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).detail).not.toContain('Could not reach')
    expect((err as ApiError).detail).toContain('interrupted')
    expect((err as ApiError).detail).toContain('https://api.example.com')
    expect((err as ApiError).detail).toContain('other side closed')
  }
})

test('initiateDocumentUpload posts the camelCase plan request and reads the plan', async () => {
  responder = () =>
    new Response(
      JSON.stringify({
        uploadId: 'u1',
        s3Key: 'rooms/room1/x.pdf',
        chunkSize: 5,
        totalParts: 2,
        presignedUrls: { '1': 'https://storage.example/p1', '2': 'https://storage.example/p2' },
        expiresIn: 3600,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  const client = new MageClient('https://api.example.com', 'k')

  const plan = await client.initiateDocumentUpload('room1', { filename: 'x.pdf', fileSize: 10 })

  expect(plan.uploadId).toBe('u1')
  expect(plan.presignedUrls['2']).toBe('https://storage.example/p2')
  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/rooms/room1/documents/initiate')
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
    filename: 'x.pdf',
    fileSize: 10,
    contentType: 'application/octet-stream',
  })
})

test('completeDocumentUpload posts parts + hash + folder and reads the document', async () => {
  responder = () =>
    new Response(JSON.stringify({ id: 'd2', name: 'x.pdf', status: 'processing' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  const client = new MageClient('https://api.example.com', 'k')

  const doc = await client.completeDocumentUpload('room1', 'u1', {
    parts: [{ partNumber: 1, etag: 'abc' }],
    fileHash: 'deadbeef',
    folderPath: 'Legal',
  })

  expect(doc.id).toBe('d2')
  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/rooms/room1/documents/u1/complete')
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
    parts: [{ partNumber: 1, etag: 'abc' }],
    fileHash: 'deadbeef',
    folderPath: 'Legal',
  })
})

test('signDocumentUploadPart posts the part number and reads the fresh URL', async () => {
  responder = () =>
    new Response(JSON.stringify({ presignedUrl: 'https://storage.example/fresh', expiresIn: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const client = new MageClient('https://api.example.com', 'k')

  const signed = await client.signDocumentUploadPart('room1', 'u1', 3)

  expect(signed.presignedUrl).toBe('https://storage.example/fresh')
  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/rooms/room1/documents/u1/sign-part')
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ partNumber: 3 })
})

test('getUploadProbe mints the connectivity probe target', async () => {
  responder = () =>
    new Response(
      JSON.stringify({ url: 'https://storage.example/probe', key: 'probes/x', expiresIn: 60, byteLength: 8 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  const client = new MageClient('https://api.example.com', 'k')

  const probe = await client.getUploadProbe('room1')

  expect(probe.byteLength).toBe(8)
  expect(calls[0]!.url).toBe('https://api.example.com/api/v1/lite/rooms/room1/documents/upload-probe')
  expect(calls[0]!.init.method).toBe('POST')
})

test('getDocumentUrl mints an audited download URL for one document', async () => {
  responder = () =>
    new Response(JSON.stringify({ url: 'https://s3/presigned', isPdfDerivative: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const client = new MageClient('https://api.example.com', 'mk_live_key')

  const result = await client.getDocumentUrl('room1', 'doc1')
  expect(result.url).toBe('https://s3/presigned')
  expect(calls[0]!.url).toBe(
    'https://api.example.com/api/v1/lite/rooms/room1/documents/doc1/url?download=true&intent=open',
  )
  expect(calls[0]!.init.headers!['X-API-Key']).toBe('mk_live_key')
})
