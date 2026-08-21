import { expect, test } from 'bun:test'
import type { Coverage, DocumentSummary } from '../client'
import type { RunContext } from '../context'
import { McpServer, type McpTool } from '../mcp'
import { buildTools } from '../commands/dataroom/mcp'

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
