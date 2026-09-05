/**
 * `mage mcp` — expose the data room to AI agents as an MCP server.
 *
 * Any MCP client (Claude, Cursor, or an agent framework) configured with
 * `mage mcp` and a `MAGE_API_KEY` can list, upload, organize, and read
 * documents in its room, and work the readiness checklist — the same
 * key-scoped surface the CLI commands use.
 *
 * Deliberately excluded: deletion. An agent's job in a data room is to fill
 * it, organize it, and read it; removing deal documents stays a human
 * decision in the CLI (`mage rm`) or the web app.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath, sep } from 'node:path'
import type { DocumentSummary } from '../../client'
import { buildContext, CliError, type RunContext } from '../../context'
import { McpServer, type McpTool } from '../../mcp'
import { collectUploads, joinFolder, type UploadItem } from '../../walk'
import { safeLocalPath } from './download'
import { attachToItem } from './readiness'
import { resolveDocument } from './rm'

// Matches the CLI upload path: bounded parallelism, never one-at-a-time.
const CONCURRENCY = 5

// Baked in at build time (tsup `define`); undefined under the test runner.
declare const __VERSION__: string
const VERSION = typeof __VERSION__ === 'undefined' ? '0.0.0-dev' : __VERSION__

/** Trim a document row to what an agent needs to act on it. */
function summarize(doc: DocumentSummary) {
  return {
    id: doc.id,
    name: doc.name,
    folderPath: doc.folderPath,
    status: doc.status,
    category: doc.liteCategory,
    indexNumber: doc.indexNumber,
  }
}

/**
 * Build the tool set over a lazily-resolved room context. Resolution is
 * deferred to the first tool call (and cached) so the MCP handshake succeeds
 * even when the key is missing — the agent then gets a clean, actionable
 * message from the tool result instead of a dead server at startup.
 */
export function buildTools(opts: { apiUrl?: string }, resolve = buildContext): McpTool[] {
  let cached: RunContext | null = null
  const context = async (): Promise<RunContext> => {
    cached ??= await resolve(opts)
    return cached
  }

  return [
    {
      name: 'list_documents',
      description:
        'List the documents in the data room with their folder, processing status, category, and index number. Optionally scope to one folder (and its subfolders).',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Only documents in this folder path and beneath it' },
        },
      },
      handler: async (args) => {
        const { client, roomId } = await context()
        const docs = await client.listDocuments(roomId)
        const folder = typeof args.folder === 'string' ? joinFolder(args.folder) : null
        const filtered = folder
          ? docs.filter((d) => d.folderPath === folder || d.folderPath?.startsWith(`${folder}/`))
          : docs
        return { count: filtered.length, documents: filtered.map(summarize) }
      },
    },
    {
      name: 'upload_documents',
      description:
        'Upload local files or whole directories into the data room, mirroring directory structure. Optionally place them in a folder and/or attach them to a readiness checklist item.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute or relative paths to files or directories on this machine',
          },
          folder: { type: 'string', description: 'Destination folder in the room (created as needed)' },
          itemId: {
            type: 'string',
            description: 'Readiness checklist item to attach the uploads to (see get_readiness)',
          },
        },
        required: ['paths'],
      },
      handler: async (args) => {
        const paths = args.paths
        if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string')) {
          throw new CliError('`paths` must be a non-empty array of file or directory paths.')
        }
        const { client, roomId } = await context()
        const toFolder = joinFolder(typeof args.folder === 'string' ? args.folder : null)

        const items: UploadItem[] = []
        for (const p of paths) {
          try {
            items.push(...collectUploads(p, toFolder))
          } catch (err) {
            throw new CliError(`Cannot read "${p}": ${(err as Error).message}`)
          }
        }
        if (items.length === 0) throw new CliError('No files found to upload.')

        // Fail fast on a bad checklist item id — before any bytes move.
        const itemId = typeof args.itemId === 'string' ? args.itemId : undefined
        if (itemId) {
          const coverage = await client.getCoverage(roomId)
          if (coverage.computed && !coverage.items.some((i) => i.itemId === itemId)) {
            throw new CliError(`No checklist item "${itemId}". Call get_readiness to see the item ids.`)
          }
        }

        const results: { file: string; folder: string | null; ok: boolean; documentId?: string; error?: string }[] = []
        for (let i = 0; i < items.length; i += CONCURRENCY) {
          const batch = items.slice(i, i + CONCURRENCY)
          const settled = await Promise.allSettled(
            batch.map((item) =>
              client.uploadDocument(roomId, {
                filename: item.filename,
                content: readFileSync(item.absPath),
                folderPath: item.folderPath,
              }),
            ),
          )
          settled.forEach((s, idx) => {
            const item = batch[idx]!
            if (s.status === 'fulfilled') {
              results.push({ file: item.absPath, folder: item.folderPath, ok: true, documentId: s.value.id })
            } else {
              const error = s.reason instanceof Error ? s.reason.message : String(s.reason)
              results.push({ file: item.absPath, folder: item.folderPath, ok: false, error })
            }
          })
        }

        const uploadedIds = results.filter((r) => r.ok).map((r) => r.documentId!)
        let attachedToItem: { itemId: string; status: string | null } | undefined
        if (itemId && uploadedIds.length > 0) {
          const coverage = await attachToItem(client, roomId, itemId, uploadedIds)
          attachedToItem = {
            itemId,
            status: coverage.items.find((i) => i.itemId === itemId)?.status ?? null,
          }
        }

        return {
          uploaded: uploadedIds.length,
          failed: results.length - uploadedIds.length,
          ...(attachedToItem ? { attachedToItem } : {}),
          results,
        }
      },
    },
    {
      name: 'get_readiness',
      description:
        "The room's readiness checklist (gap analysis): every expected item with its status (present, partial, missing, not_applicable), attached documents, and a hint for what fills it. `computed` is false until the first documents arrive.",
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { client, roomId } = await context()
        return client.getCoverage(roomId)
      },
    },
    {
      name: 'attach_to_checklist_item',
      description:
        'Attach already-uploaded documents to a readiness checklist item (additive: existing attachments are kept). Documents may be referenced by id, name, or folder/name.',
      inputSchema: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: 'Checklist item id (from get_readiness)' },
          documents: {
            type: 'array',
            items: { type: 'string' },
            description: 'Documents to attach: by id, name, or folder/name',
          },
        },
        required: ['itemId', 'documents'],
      },
      handler: async (args) => {
        const itemId = args.itemId
        const targets = args.documents
        if (typeof itemId !== 'string' || !itemId) throw new CliError('`itemId` is required.')
        if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === 'string')) {
          throw new CliError('`documents` must be a non-empty array of ids, names, or folder/name paths.')
        }
        const { client, roomId } = await context()
        const docs = await client.listDocuments(roomId)
        const documentIds = targets.map((t) => resolveDocument(docs, t).id)
        const coverage = await attachToItem(client, roomId, itemId, documentIds)
        return {
          itemId,
          attached: documentIds,
          status: coverage.items.find((i) => i.itemId === itemId)?.status ?? null,
          missingRequiredCount: coverage.missingRequiredCount,
        }
      },
    },
    {
      name: 'create_folder',
      description: 'Create an empty folder in the room (e.g. "01-Corporate/Charters"). Idempotent.',
      inputSchema: {
        type: 'object',
        properties: {
          folderPath: { type: 'string', description: 'Folder path to create' },
        },
        required: ['folderPath'],
      },
      handler: async (args) => {
        const folderPath = joinFolder(typeof args.folderPath === 'string' ? args.folderPath : null)
        if (!folderPath) throw new CliError('`folderPath` is required.')
        const { client, roomId } = await context()
        return client.createFolder(roomId, folderPath)
      },
    },
    {
      name: 'download_document',
      description:
        'Download one document to a local directory and return the saved path. Requires the key to carry the Download permission; every download lands on the room audit trail.',
      inputSchema: {
        type: 'object',
        properties: {
          document: { type: 'string', description: 'The document: by id, name, or folder/name' },
          destDir: { type: 'string', description: 'Local directory to save into (default: current directory)' },
        },
        required: ['document'],
      },
      handler: async (args) => {
        const target = args.document
        if (typeof target !== 'string' || !target) throw new CliError('`document` is required.')
        const { client, roomId } = await context()
        const docs = await client.listDocuments(roomId)
        const doc = resolveDocument(docs, target)
        const { url } = await client.getDocumentUrl(roomId, doc.id)
        const res = await fetch(url)
        if (!res.ok) throw new CliError(`Download failed (HTTP ${res.status}).`)
        const destDir = typeof args.destDir === 'string' && args.destDir ? args.destDir : '.'
        mkdirSync(destDir, { recursive: true })
        // A document's name comes from whoever put it in the room, and a name
        // the server stores may hold path separators or an absolute prefix.
        // Strip it to a bare filename, then prove the result still sits under
        // the folder the caller chose before anything touches the disk.
        const safeName = safeLocalPath(null, doc.name) || doc.id
        const root = resolvePath(destDir)
        const savedTo = join(destDir, safeName)
        if (resolvePath(savedTo) !== root && !resolvePath(savedTo).startsWith(root + sep)) {
          throw new CliError("That document's name can't be saved inside the chosen folder.")
        }
        writeFileSync(savedTo, new Uint8Array(await res.arrayBuffer()))
        return { savedTo, documentId: doc.id, name: doc.name }
      },
    },
  ]
}

export async function mcpCommand(opts: { apiUrl?: string }): Promise<void> {
  const server = new McpServer({ name: 'mage-dataroom', version: VERSION }, buildTools(opts))
  // stdout is the protocol channel; the one human-facing line goes to stderr.
  process.stderr.write('mage MCP server listening on stdio (room resolves from MAGE_API_KEY on first tool call)\n')
  await server.serve(process.stdin, process.stdout)
}
