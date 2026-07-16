import { createWriteStream, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ApiError, type DocumentSummary, type MageClient } from '../../client'
import { buildContext, CliError } from '../../context'
import * as output from '../../output'
import { resolveDocument } from './rm'

// Download in bounded parallel batches, mirroring upload — a data room is
// hundreds of files. Each file is two hops: mint a presigned URL (audited
// server-side), then stream the bytes straight to disk.
const CONCURRENCY = 5

interface DownloadItem {
  doc: DocumentSummary
  /** Where the file lands locally, relative to the destination root. */
  relPath: string
}

interface DownloadResult {
  item: DownloadItem
  ok: boolean
  error?: string
}

/** A local-safe relative path from the room's folder tree + document name.

    The server stores folder paths and names as the user typed them — strip
    anything that could walk out of the destination directory ('..' segments,
    absolute prefixes, backslashes, drive colons) before touching the disk. */
export function safeLocalPath(folderPath: string | null, name: string): string {
  const parts: string[] = []
  for (const segment of (folderPath ?? '').split('/')) {
    const cleaned = segment.trim().replace(/^\.+/, '').replaceAll('\\', '_').replaceAll(':', '_')
    if (cleaned && cleaned !== '..') parts.push(cleaned)
  }
  const rawName = basename((name || '').replaceAll('\\', '/')).replace(/^\.+/, '')
  parts.push(rawName || 'document')
  return join(...parts)
}

/** De-collide identical local paths ("a.pdf" → "a (2).pdf") so parallel writes
    of same-named docs in one folder can't clobber each other. */
function dedupe(seen: Set<string>, path: string): string {
  if (!seen.has(path)) {
    seen.add(path)
    return path
  }
  const dot = basename(path).lastIndexOf('.')
  const dir = dirname(path)
  const base = basename(path)
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = join(dir === '.' ? '' : dir, `${stem} (${n})${ext}`)
    if (!seen.has(candidate)) {
      seen.add(candidate)
      return candidate
    }
  }
}

/** Translate the structured 403s into actions the user can take. */
function friendlyDownloadError(err: unknown): CliError | null {
  if (!(err instanceof ApiError) || err.status !== 403) return null
  if (err.message.includes('missing_permission')) {
    return new CliError(
      "This key can't download documents. Re-mint it with Download enabled " +
        '(Settings → API keys in the data room), or run `mage login` again to get a fresh key.',
    )
  }
  if (err.message.includes('nda_required')) {
    return new CliError(
      'This room requires accepting its NDA first — open the room in your browser to sign it.',
    )
  }
  return null
}

async function fetchToFile(client: MageClient, roomId: string, item: DownloadItem, destRoot: string) {
  const { url } = await client.getDocumentUrl(roomId, item.doc.id)
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`file fetch failed (HTTP ${res.status})`)
  }
  const target = join(destRoot, item.relPath)
  mkdirSync(dirname(target), { recursive: true })
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(target))
}

/**
 * `mage download [target] [dest]` — the inverse of `upload`.
 *
 * No target: the whole room, mirrored into `./<room-name>/`. A folder target
 * uses the same prefix semantics as `ls` and recurses. Anything else resolves
 * like `rm`'s target (id, name, or folder/name) and downloads one file.
 */
export async function downloadCommand(
  target: string | undefined,
  dest: string | undefined,
  opts: { apiUrl?: string; json?: boolean },
): Promise<void> {
  const { client, roomId } = await buildContext(opts)
  const docs = await client.listDocuments(roomId)

  let selected: DocumentSummary[]
  let defaultDest: string
  let stripPrefix: string | null = null

  // `.` (or `/`) is the explicit whole-room target — the only way to say
  // "everything, into THIS dest", since a bare dest arg would parse as target.
  const normalized = target?.replace(/^\/+|\/+$/g, '').trim()
  const root = normalized === '.' ? '' : normalized
  if (!root) {
    // Whole room → a directory named after the room.
    const context = await client.getContext()
    selected = docs
    defaultDest = safeLocalPath(null, context.roomName || 'data-room')
  } else {
    const inFolder = docs.filter((d) => {
      const f = d.folderPath ?? ''
      return f === root || f.startsWith(root + '/')
    })
    if (inFolder.length > 0) {
      // Folder target → recurse; paths inside dest are relative to the folder.
      selected = inFolder
      stripPrefix = root
      defaultDest = safeLocalPath(null, root.split('/').at(-1)!)
    } else {
      // Single document (id, bare name, or folder/name).
      const doc = resolveDocument(docs, root)
      selected = [doc]
      stripPrefix = doc.folderPath ?? null
      defaultDest = '.'
    }
  }

  if (selected.length === 0) {
    throw new CliError('Nothing to download — the room has no documents here.')
  }

  const destRoot = resolve(dest ?? defaultDest)
  const seen = new Set<string>()
  const items: DownloadItem[] = selected.map((doc) => {
    let folder = doc.folderPath ?? null
    if (stripPrefix && folder) {
      folder = folder === stripPrefix ? null : folder.slice(stripPrefix.length + 1)
    }
    return { doc, relPath: dedupe(seen, safeLocalPath(folder, doc.name)) }
  })

  output.info(`Downloading ${items.length} file${items.length === 1 ? '' : 's'} to ${destRoot}…`)

  const results: DownloadResult[] = []
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map((item) => fetchToFile(client, roomId, item, destRoot)),
    )
    for (const [idx, settledItem] of settled.entries()) {
      const item = batch[idx]!
      if (settledItem.status === 'fulfilled') {
        results.push({ item, ok: true })
        output.success(item.relPath)
      } else {
        // A permission/NDA 403 will fail every file the same way — surface the
        // actionable message once instead of N identical failure lines.
        const friendly = friendlyDownloadError(settledItem.reason)
        if (friendly) throw friendly
        const error =
          settledItem.reason instanceof Error
            ? settledItem.reason.message
            : String(settledItem.reason)
        results.push({ item, ok: false, error })
        output.failure(`${item.relPath}  (${error})`)
      }
    }
  }

  const downloaded = results.filter((r) => r.ok).length
  const failed = results.length - downloaded
  if (!opts.json) {
    output.info(`\nDownloaded ${downloaded}/${results.length}${failed ? `, ${failed} failed` : ''}.`)
  }
  if (opts.json) {
    output.printJson({
      downloaded,
      failed,
      dest: destRoot,
      results: results.map((r) => ({
        documentId: r.item.doc.id,
        path: r.item.relPath,
        ok: r.ok,
        error: r.error,
      })),
    })
  }
  if (failed) process.exitCode = 1
}
