import { readFileSync } from 'node:fs'
import { buildContext, CliError } from '../../context'
import * as output from '../../output'
import { collectUploads, formatBytes, joinFolder, type UploadItem } from '../../walk'
import { attachToItem, report as reportAttachment } from './readiness'

// Upload files in bounded parallel batches — never one-at-a-time (a data room is
// hundreds of files). The proxied endpoint buffers each file, so we also warn
// past a size where that path gets slow; the direct-to-S3 path is a follow-up.
const CONCURRENCY = 5
const LARGE_FILE_WARN = 100 * 1024 * 1024

interface UploadResult {
  item: UploadItem
  ok: boolean
  documentId?: string
  error?: string
}

function label(item: UploadItem): string {
  return item.folderPath ? `${item.folderPath}/${item.filename}` : item.filename
}

export async function uploadCommand(
  paths: string[],
  opts: { to?: string; forItem?: string; apiUrl?: string; json?: boolean },
): Promise<void> {
  const { client, roomId } = await buildContext(opts)
  const toFolder = joinFolder(opts.to)

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
  if (opts.forItem) {
    const coverage = await client.getCoverage(roomId)
    if (coverage.computed && !coverage.items.some((i) => i.itemId === opts.forItem)) {
      throw new CliError(
        `No checklist item "${opts.forItem}". Run \`mage readiness\` to see the item ids.`,
      )
    }
  }

  output.info(`Uploading ${items.length} file${items.length === 1 ? '' : 's'}…`)

  const results: UploadResult[] = []
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async (item) => {
        const content = readFileSync(item.absPath)
        if (content.byteLength > LARGE_FILE_WARN) {
          output.warn(`${item.filename} is large (${formatBytes(content.byteLength)}); this may be slow.`)
        }
        return client.uploadDocument(roomId, {
          filename: item.filename,
          content,
          folderPath: item.folderPath,
        })
      }),
    )
    settled.forEach((settledItem, idx) => {
      const item = batch[idx]!
      if (settledItem.status === 'fulfilled') {
        results.push({ item, ok: true, documentId: settledItem.value.id })
        output.success(`${label(item)}  →  ${item.folderPath ?? 'Unsorted'}`)
      } else {
        const error =
          settledItem.reason instanceof Error ? settledItem.reason.message : String(settledItem.reason)
        results.push({ item, ok: false, error })
        output.failure(`${label(item)}  (${error})`)
      }
    })
  }

  const uploaded = results.filter((r) => r.ok).length
  const failed = results.length - uploaded
  if (!opts.json) {
    output.info(`\nUploaded ${uploaded}/${results.length}${failed ? `, ${failed} failed` : ''}.`)
  }

  // Link everything that landed to the checklist item, in one write.
  const uploadedIds = results.filter((r) => r.ok).map((r) => r.documentId!)
  let attachment: { itemId: string; status: string | null } | undefined
  if (opts.forItem && uploadedIds.length > 0) {
    const coverage = await attachToItem(client, roomId, opts.forItem, uploadedIds)
    if (!opts.json) reportAttachment(coverage, opts.forItem, uploadedIds, opts)
    attachment = {
      itemId: opts.forItem,
      status: coverage.items.find((i) => i.itemId === opts.forItem)?.status ?? null,
    }
  }

  if (opts.json) {
    output.printJson({
      uploaded,
      failed,
      ...(attachment ? { attachedToItem: attachment } : {}),
      results: results.map((r) => ({
        file: r.item.absPath,
        folder: r.item.folderPath,
        ok: r.ok,
        documentId: r.documentId,
        error: r.error,
      })),
    })
  }
  if (failed) process.exitCode = 1
}
