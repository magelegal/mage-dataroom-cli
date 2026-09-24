import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
import { type Coverage, type DocumentSummary, MageClient } from '../client'
import type { RunContext } from '../context'
import { McpServer, type McpTool } from '../mcp'
import { buildTools } from '../commands/dataroom/mcp'
import { isRelayPinned, resetRelayPin } from '../commands/dataroom/transport'

// ── Protocol layer ────────────────────────────────────────────────────────────

const ECHO_TOOL: McpTool = {
  name: 'echo',
  description: 'Echo the arguments back',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  handler: async (args) => ({ echoed: args.value }),
}

const FAILING_TOOL: McpTool = {
  name: 'always_fails',
  description: 'Always throws',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    throw new Error('the room is unreachable')
  },
}

function server(tools: McpTool[] = [ECHO_TOOL, FAILING_TOOL]): McpServer {
  return new McpServer({ name: 'test-server', version: '0.0.0' }, tools)
}

async function roundTrip(srv: McpServer, message: unknown): Promise<Record<string, unknown> | null> {
  const raw = await srv.handleLine(JSON.stringify(message))
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)
}

test('initialize echoes a supported protocol version and advertises tools', async () => {
  const res = await roundTrip(server(), {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
  })
  const result = res!.result as { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } }
  expect(result.protocolVersion).toBe('2025-03-26')
  expect(result.capabilities.tools).toBeDefined()
  expect(result.serverInfo.name).toBe('test-server')
})

test('initialize falls back to the latest version for an unknown revision', async () => {
  const res = await roundTrip(server(), {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  })
  expect((res!.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18')
})

test('notifications get no response', async () => {
  const raw = await server().handleLine(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  )
  expect(raw).toBeNull()
})

test('tools/list returns name, description, and inputSchema', async () => {
  const res = await roundTrip(server(), { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = (res!.result as { tools: { name: string; inputSchema: object }[] }).tools
  expect(tools.map((t) => t.name)).toEqual(['echo', 'always_fails'])
  expect(tools[0]!.inputSchema).toBeDefined()
})

test('tools/call runs the handler and wraps the result as text content', async () => {
  const res = await roundTrip(server(), {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'echo', arguments: { value: 'hello' } },
  })
  const result = res!.result as { content: { type: string; text: string }[]; isError?: boolean }
  expect(result.isError).toBeUndefined()
  expect(JSON.parse(result.content[0]!.text)).toEqual({ echoed: 'hello' })
})

test('a throwing tool becomes an isError result, not a protocol error', async () => {
  const res = await roundTrip(server(), {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'always_fails', arguments: {} },
  })
  expect(res!.error).toBeUndefined()
  const result = res!.result as { content: { text: string }[]; isError: boolean }
  expect(result.isError).toBe(true)
  expect(result.content[0]!.text).toContain('unreachable')
})

test('unknown tool and unknown method are JSON-RPC errors', async () => {
  const unknownTool = await roundTrip(server(), {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  })
  expect((unknownTool!.error as { code: number }).code).toBe(-32602)

  const unknownMethod = await roundTrip(server(), { jsonrpc: '2.0', id: 6, method: 'resources/list' })
  expect((unknownMethod!.error as { code: number }).code).toBe(-32601)
})

test('a non-JSON line is a parse error with a null id', async () => {
  const res = await roundTrip(server(), undefined as never).catch(() => null)
  const raw = await server().handleLine('this is not json')
  const parsed = JSON.parse(raw!) as { id: null; error: { code: number } }
  expect(parsed.id).toBeNull()
  expect(parsed.error.code).toBe(-32700)
  expect(res).toBeNull()
})

// ── Data room tools over a stubbed client ────────────────────────────────────

const DOCS: DocumentSummary[] = [
  {
    id: 'doc-1',
    name: 'Charter.pdf',
    status: 'ready',
    processingPhase: null,
    folderPath: '01-Corporate',
    litePageCount: 3,
    liteCategory: 'corporate',
    indexNumber: '1.1',
    version: 1,
    externalSource: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'doc-2',
    name: 'Cap Table.xlsx',
    status: 'ready',
    processingPhase: null,
    folderPath: '02-Equity',
    litePageCount: 1,
    liteCategory: 'equity',
    indexNumber: '2.1',
    version: 1,
    externalSource: null,
    createdAt: '2026-01-02T00:00:00Z',
  },
]

const COVERAGE: Coverage = {
  roomId: 'room-1',
  computed: true,
  missingRequiredCount: 1,
  computedAt: '2026-01-03T00:00:00Z',
  items: [
    {
      itemId: 'charter',
      label: 'Certificate of incorporation',
      requirementLevel: 'required',
      status: 'present',
      matchedDocumentIds: ['doc-1'],
      completed: false,
      section: 'Corporate',
      expectedScope: 'one',
      founderHint: '',
      multiDoc: false,
    },
  ],
}

function stubContext(overrides: Partial<Record<string, unknown>> = {}): RunContext {
  const client = {
    listDocuments: async () => DOCS,
    getCoverage: async () => COVERAGE,
    setCoverageItem: async (_room: string, _item: string, ids: string[]) => ({
      ...COVERAGE,
      items: [{ ...COVERAGE.items[0]!, matchedDocumentIds: ids, status: 'present' }],
    }),
    createFolder: async (_room: string, folderPath: string) => ({ folders: [folderPath] }),
    ...overrides,
  }
  return { client, roomId: 'room-1', baseUrl: 'https://api.example.com' } as unknown as RunContext
}

function toolByName(tools: McpTool[], name: string): McpTool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

test('list_documents summarizes rows and filters by folder', async () => {
  const tools = buildTools({}, async () => stubContext())
  const all = (await toolByName(tools, 'list_documents').handler({})) as { count: number }
  expect(all.count).toBe(2)

  const scoped = (await toolByName(tools, 'list_documents').handler({ folder: '01-Corporate' })) as {
    count: number
    documents: { id: string; category: string | null }[]
  }
  expect(scoped.count).toBe(1)
  expect(scoped.documents[0]!.id).toBe('doc-1')
  expect(scoped.documents[0]!.category).toBe('corporate')
})

test('attach_to_checklist_item resolves names to ids and merges attachments', async () => {
  let putIds: string[] = []
  const tools = buildTools(
    {},
    async () =>
      stubContext({
        setCoverageItem: async (_room: string, _item: string, ids: string[]) => {
          putIds = ids
          return {
            ...COVERAGE,
            missingRequiredCount: 0,
            items: [{ ...COVERAGE.items[0]!, matchedDocumentIds: ids }],
          }
        },
      }),
  )
  const result = (await toolByName(tools, 'attach_to_checklist_item').handler({
    itemId: 'charter',
    documents: ['Cap Table.xlsx'],
  })) as { attached: string[]; missingRequiredCount: number }
  // Merge: keeps doc-1 (already attached) and adds doc-2, resolved by name.
  expect(putIds.sort()).toEqual(['doc-1', 'doc-2'])
  expect(result.attached).toEqual(['doc-2'])
  expect(result.missingRequiredCount).toBe(0)
})

test('get_readiness returns the coverage verbatim', async () => {
  const tools = buildTools({}, async () => stubContext())
  const result = (await toolByName(tools, 'get_readiness').handler({})) as Coverage
  expect(result.roomId).toBe('room-1')
  expect(result.items[0]!.itemId).toBe('charter')
})

test('create_folder normalizes the path and requires one', async () => {
  const tools = buildTools({}, async () => stubContext())
  const created = (await toolByName(tools, 'create_folder').handler({
    folderPath: ' 01-Corporate / Charters ',
  })) as { folders: string[] }
  expect(created.folders).toEqual(['01-Corporate/Charters'])

  await expect(toolByName(tools, 'create_folder').handler({})).rejects.toThrow('`folderPath` is required')
})

test('upload_documents validates paths before resolving the room', async () => {
  let resolved = false
  const tools = buildTools({}, async () => {
    resolved = true
    return stubContext()
  })
  await expect(toolByName(tools, 'upload_documents').handler({ paths: [] })).rejects.toThrow(
    'non-empty array',
  )
  expect(resolved).toBe(false)
})

// ── upload_documents transport ───────────────────────────────────────────────
// The agent's upload rides the same part-by-part road as `mage upload`: a
// whole-file POST is held to the edge's body cap on a network that blocks
// storage, and a part sent through the API relay is not.

const API = 'https://api.example.com'
const STORAGE = 'https://storage.example'

interface RoutedCall {
  url: string
  method?: string
  body?: unknown
}

interface UploadToolResult {
  uploaded: number
  failed: number
  alreadyThere: number
  results: { documentId?: string; folder: string | null; ok: boolean; alreadyThere?: boolean; error?: string }[]
}

/** Run upload_documents on one 10-byte file in a 4-byte-part plan, with
    storage PUTs answered by `storage`. `placement` is what the server says at
    complete (omitted: a server that predates the field). Returns every fetch
    the tool made. */
async function uploadThroughRoutes(
  storage: () => Response,
  placement?: 'created' | 'existing',
): Promise<{
  calls: RoutedCall[]
  result: UploadToolResult
}> {
  const root = mkdtempSync(join(tmpdir(), 'mage-mcp-upload-'))
  const calls: RoutedCall[] = []
  const previousFetch = globalThis.fetch
  resetRelayPin()
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const call: RoutedCall = { url: String(url), method: init?.method, body: init?.body }
    calls.push(call)
    if (call.url.includes('/documents/initiate')) {
      return Response.json({
        uploadId: 'u1',
        s3Key: 'rooms/room-1/x.pdf',
        chunkSize: 4,
        totalParts: 3,
        presignedUrls: { '1': `${STORAGE}/part/1`, '2': `${STORAGE}/part/2`, '3': `${STORAGE}/part/3` },
        expiresIn: 3600,
      })
    }
    if (call.url.startsWith(STORAGE)) return storage()
    if (call.url.includes('/documents/u1/part/')) {
      const n = call.url.split('/').pop()
      return new Response(null, { status: 200, headers: { etag: `"relay-${n}"` } })
    }
    if (call.url.includes('/documents/u1/complete')) {
      return Response.json(
        { id: 'd1', name: 'x.pdf', status: 'processing', ...(placement ? { placement } : {}) },
        { status: 201 },
      )
    }
    throw new Error(`unrouted fetch: ${call.url}`)
  }) as typeof fetch
  try {
    mkdirSync(join(root, 'Legal'))
    writeFileSync(join(root, 'Legal', 'x.pdf'), '0123456789')
    const context = {
      client: new MageClient(API, 'k'),
      roomId: 'room-1',
      baseUrl: API,
    } as unknown as RunContext
    const tools = buildTools({}, async () => context)
    const result = (await toolByName(tools, 'upload_documents').handler({
      paths: [join(root, 'Legal')],
    })) as UploadToolResult
    return { calls, result }
  } finally {
    globalThis.fetch = previousFetch
    rmSync(root, { recursive: true, force: true })
  }
}

test('upload_documents sends each part straight to storage, never the whole file to the API', async () => {
  let n = 0
  const { calls, result } = await uploadThroughRoutes(() => {
    n += 1
    return new Response(null, { status: 200, headers: { etag: `"direct-${n}"` } })
  })

  expect(result.uploaded).toBe(1)
  expect(result.failed).toBe(0)
  expect(result.results[0]!.documentId).toBe('d1')
  expect(calls.filter((c) => c.url.startsWith(STORAGE)).map((c) => c.url)).toEqual([
    `${STORAGE}/part/1`,
    `${STORAGE}/part/2`,
    `${STORAGE}/part/3`,
  ])
  // The retired whole-file road: a POST to the room's bare documents route.
  expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/rooms/room-1/documents'))).toBe(false)
  const complete = calls.find((c) => c.url.includes('/complete'))!
  expect(JSON.parse(complete.body as string).parts).toEqual([
    { partNumber: 1, etag: 'direct-1' },
    { partNumber: 2, etag: 'direct-2' },
    { partNumber: 3, etag: 'direct-3' },
  ])
})

test('upload_documents relays a part through the API when storage never answers', async () => {
  const { calls, result } = await uploadThroughRoutes(() => {
    throw new TypeError('fetch failed')
  })

  expect(result.uploaded).toBe(1)
  expect(isRelayPinned()).toBe(true)
  resetRelayPin()
  expect(
    calls
      .filter((c) => c.url.includes('/documents/u1/part/'))
      .map((c) => [c.url, Buffer.from(c.body as Uint8Array).toString()]),
  ).toEqual([
    [`${API}/api/v1/lite/rooms/room-1/documents/u1/part/1`, '0123'],
    [`${API}/api/v1/lite/rooms/room-1/documents/u1/part/2`, '4567'],
    [`${API}/api/v1/lite/rooms/room-1/documents/u1/part/3`, '89'],
  ])
  expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/rooms/room-1/documents'))).toBe(false)
})

// ── upload_documents: a re-run reads as a re-run ──────────────────────────────
// The agent learns a file was already in the room the same way `mage upload
// --json` says it: per file and as a count, from the server's answer at
// complete. Without it a second run looks exactly like a fresh upload.

const storageOk = () => {
  let n = 0
  return () => {
    n += 1
    return new Response(null, { status: 200, headers: { etag: `"direct-${n}"` } })
  }
}

test('upload_documents says a file the room already held was already there', async () => {
  const { result } = await uploadThroughRoutes(storageOk(), 'existing')

  expect(result.uploaded).toBe(1)
  expect(result.failed).toBe(0)
  expect(result.alreadyThere).toBe(1)
  expect(result.results[0]!.alreadyThere).toBe(true)
  expect(result.results[0]!.documentId).toBe('d1')
})

test('upload_documents counts a new file as new, not already there', async () => {
  const { result } = await uploadThroughRoutes(storageOk(), 'created')

  expect(result.alreadyThere).toBe(0)
  expect(result.results[0]!.alreadyThere).toBe(false)
})

test('upload_documents treats a server that never says placement as a new upload', async () => {
  const { result } = await uploadThroughRoutes(storageOk())

  expect(result.uploaded).toBe(1)
  expect(result.alreadyThere).toBe(0)
  expect(result.results[0]!.alreadyThere).toBe(false)
})

test('upload_documents never counts a failed file as already there', async () => {
  const { result } = await uploadThroughRoutes(() => new Response(null, { status: 400 }), 'existing')

  expect(result.uploaded).toBe(0)
  expect(result.failed).toBe(1)
  expect(result.alreadyThere).toBe(0)
  expect(result.results[0]!.ok).toBe(false)
  expect(result.results[0]!.alreadyThere).toBeUndefined()
})

// ── download_document containment ────────────────────────────────────────────
// A document's name comes from whoever put it in the room, and a name the
// server stores may hold path separators or an absolute prefix. Every download
// lands inside the folder the caller asked for.

const DOWNLOAD_BODY = 'the bytes'

/** Run `download_document` for a document with this name, into this folder. */
async function downloadInto(name: string, destDir: string): Promise<string> {
  const tools = buildTools({}, async () =>
    stubContext({
      listDocuments: async () => [{ ...DOCS[0]!, id: 'doc-9', name, folderPath: null }],
      getDocumentUrl: async () => ({ url: 'https://files.example.com/doc-9', isPdfDerivative: false }),
    }),
  )
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(DOWNLOAD_BODY)) as unknown as typeof fetch
  try {
    const result = (await toolByName(tools, 'download_document').handler({
      document: 'doc-9',
      destDir,
    })) as { savedTo: string }
    return result.savedTo
  } finally {
    globalThis.fetch = previousFetch
  }
}

test('download_document saves a plain name into the chosen folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mage-mcp-download-'))
  try {
    const dest = join(root, 'a', 'b')
    const savedTo = await downloadInto('Charter.pdf', dest)
    expect(resolvePath(savedTo)).toBe(join(resolvePath(dest), 'Charter.pdf'))
    expect(readFileSync(savedTo, 'utf8')).toBe(DOWNLOAD_BODY)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('download_document keeps a traversing name inside the chosen folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mage-mcp-download-'))
  try {
    const dest = join(root, 'a', 'b')
    const savedTo = await downloadInto('../../escaped.txt', dest)
    expect(resolvePath(savedTo).startsWith(resolvePath(dest) + sep)).toBe(true)
    expect(existsSync(join(dest, 'escaped.txt'))).toBe(true)
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('download_document keeps an absolute name inside the chosen folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mage-mcp-download-'))
  try {
    const dest = join(root, 'dest')
    const savedTo = await downloadInto(join(root, 'absolute.txt'), dest)
    expect(resolvePath(savedTo)).toBe(join(resolvePath(dest), 'absolute.txt'))
    expect(existsSync(join(root, 'absolute.txt'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the room context is resolved once and cached across tool calls', async () => {
  let resolutions = 0
  const tools = buildTools({}, async () => {
    resolutions += 1
    return stubContext()
  })
  await toolByName(tools, 'get_readiness').handler({})
  await toolByName(tools, 'list_documents').handler({})
  expect(resolutions).toBe(1)
})
