/**
 * A minimal Model Context Protocol (MCP) server over stdio.
 *
 * Implemented directly on JSON-RPC 2.0 rather than the official SDK to honor
 * this package's zero-dependency rule — it runs via `npx` on strangers'
 * machines. The stdio transport is newline-delimited JSON-RPC: one message per
 * line on stdin/stdout. stdout carries protocol frames ONLY; anything
 * human-readable goes to stderr.
 *
 * Scope: the `initialize` handshake, `ping`, `tools/list`, and `tools/call` —
 * the entire surface an agent client needs to operate a data room. Requests
 * with unknown methods get a JSON-RPC error; notifications never get a
 * response (per spec), which is also why `notifications/initialized` is
 * handled by ignoring it.
 */
import { createInterface } from 'node:readline'

/** Protocol revisions this server speaks. If the client asks for one of
 *  these, it is echoed back; anything else gets our latest. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]!

/** One callable tool: JSON Schema in, JSON-serializable result out.
 *  A thrown Error becomes an `isError` tool result (not a protocol error). */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

export class McpServer {
  constructor(
    private readonly info: { name: string; version: string },
    private readonly tools: McpTool[],
  ) {}

  /**
   * Handle one raw incoming line. Returns the serialized response frame, or
   * null when the line warrants no response (notifications, blank lines).
   */
  async handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim()
    if (!trimmed) return null

    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      return respondError(null, -32700, 'Parse error: message is not valid JSON')
    }

    // Notifications (no id) never get a response — including
    // `notifications/initialized` and `notifications/cancelled`.
    if (msg.id === undefined || msg.id === null) return null
    if (typeof msg.method !== 'string') {
      return respondError(msg.id, -32600, 'Invalid request: missing method')
    }

    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion
        const protocolVersion =
          typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : LATEST_PROTOCOL_VERSION
        return respond(msg.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
        })
      }
      case 'ping':
        return respond(msg.id, {})
      case 'tools/list':
        return respond(msg.id, {
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        })
      case 'tools/call': {
        const name = msg.params?.name
        const tool = this.tools.find((t) => t.name === name)
        if (!tool) {
          return respondError(msg.id, -32602, `Unknown tool: ${String(name)}`)
        }
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
        try {
          const result = await tool.handler(args)
          return respond(msg.id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          })
        } catch (err) {
          // Tool failures are results, not protocol errors — the agent should
          // read the message and adjust, not tear the session down.
          const message = err instanceof Error ? err.message : String(err)
          return respond(msg.id, {
            content: [{ type: 'text', text: message }],
            isError: true,
          })
        }
      }
      default:
        return respondError(msg.id, -32601, `Method not found: ${msg.method}`)
    }
  }

  /** Serve until the input stream closes (the client owns the lifecycle). */
  serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
    return new Promise((resolve) => {
      const rl = createInterface({ input, terminal: false })
      // Serialize handling so responses keep arrival order even when a tool
      // call is slow — MCP clients tolerate reordering, but ordered is simpler
      // to reason about and to test.
      let chain = Promise.resolve()
      rl.on('line', (line) => {
        chain = chain.then(async () => {
          const response = await this.handleLine(line)
          if (response !== null) output.write(`${response}\n`)
        })
      })
      rl.on('close', () => {
        void chain.then(resolve)
      })
    })
  }
}

function respond(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function respondError(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}
