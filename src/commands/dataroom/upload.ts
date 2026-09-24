import { buildContext, CliError } from '../../context'
import * as output from '../../output'
import { collectUploads, joinFolder, type UploadItem } from '../../walk'
import { attachToItem, report as reportAttachment } from './readiness'
import { uploadFile, wasAlreadyThere } from './transport'

// Upload files in bounded parallel batches — never one-at-a-time (a data room
// is hundreds of files). Bytes move direct to storage, part by part, and a part
// storage never answers goes through the API instead — see `transport.ts`.
const CONCURRENCY = 5

interface UploadResult {
  item: UploadItem
  ok: boolean
  documentId?: string
  alreadyThere?: boolean
  error?: string
}

/** The last line of a run that found files already in the room, or null.
 *  Running the same upload again is safe: those files are left as they are. */
export function alreadyThereLine(count: number): string | null {
  if (count === 0) return null
  return count === 1 ? '1 file was already there.' : `${count} files were already there.`
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
    const settled = await Promise.allSettled(batch.map((item) => uploadFile(client, roomId, item)))
    settled.forEach((settledItem, idx) => {
      const item = batch[idx]!
      if (settledItem.status === 'fulfilled') {
        results.push({
          item,
          ok: true,
          documentId: settledItem.value.id,
          alreadyThere: wasAlreadyThere(settledItem.value),
        })
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
  const alreadyThere = results.filter((r) => r.alreadyThere).length
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

  // Last, after the checklist line, so a re-run reads its answer at the end.
  const line = opts.json ? null : alreadyThereLine(alreadyThere)
  if (line) output.info(line)

  if (opts.json) {
    output.printJson({
      uploaded,
      failed,
      alreadyThere,
      ...(attachment ? { attachedToItem: attachment } : {}),
      results: results.map((r) => ({
        file: r.item.absPath,
        folder: r.item.folderPath,
        ok: r.ok,
        documentId: r.documentId,
        alreadyThere: r.alreadyThere,
        error: r.error,
      })),
    })
  }
  if (failed) process.exitCode = 1
}
