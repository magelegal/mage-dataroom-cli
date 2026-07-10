import type { Coverage, CoverageItem, MageClient } from '../../client'
import { buildContext, CliError } from '../../context'
import * as output from '../../output'
import { resolveDocument } from './rm'

/**
 * `mage readiness` — the room's checklist of what investors expect, with a
 * per-item status. This is the read half of the agent loop: see what's
 * missing, go get it, upload it against the item.
 *
 * `mage readiness attach <item> <doc…>` is the link half: it attaches
 * already-uploaded documents to a checklist item (additive — existing
 * attachments are kept).
 */

export async function readinessCommand(opts: {
  apiUrl?: string
  json?: boolean
}): Promise<void> {
  const { client, roomId } = await buildContext(opts)
  const coverage = await client.getCoverage(roomId)

  if (opts.json) {
    output.printJson(coverage)
    return
  }

  if (!coverage.computed) {
    output.info(
      'Readiness has not been analyzed yet — it runs after your first documents arrive. Upload something and check back.',
    )
    return
  }

  // Group by section (server order preserved within a section).
  const bySection = new Map<string, CoverageItem[]>()
  for (const item of coverage.items) {
    const list = bySection.get(item.section) ?? []
    list.push(item)
    bySection.set(item.section, list)
  }

  for (const [section, items] of bySection) {
    output.out(output.colors.bold(section))
    for (const item of items) {
      const docs = item.matchedDocumentIds.length
      const docNote = docs > 0 ? output.colors.dim(` (${docs} doc${docs === 1 ? '' : 's'})`) : ''
      output.out(`  ${statusGlyph(item.status)} ${item.label}${docNote}  ${output.colors.dim(item.itemId)}`)
    }
  }

  const missingRequired = coverage.items.filter(
    (i) => i.status === 'missing' && i.requirementLevel === 'required',
  )
  output.out('')
  if (coverage.missingRequiredCount === 0) {
    output.out(`${output.colors.green('✓')} No required items are missing.`)
  } else {
    output.out(
      output.colors.bold(
        `${coverage.missingRequiredCount} required item${coverage.missingRequiredCount === 1 ? '' : 's'} still missing:`,
      ),
    )
    for (const item of missingRequired) {
      output.out(`  ${output.colors.red('•')} ${item.label}  ${output.colors.dim(item.itemId)}`)
      if (item.founderHint) output.out(`    ${output.colors.dim(item.founderHint)}`)
    }
    output.out('')
    output.out(output.colors.dim('Fill one with: mage upload <file> --for-item <itemId>'))
  }
}

export async function readinessAttachCommand(
  itemId: string,
  docTargets: string[],
  opts: { apiUrl?: string; json?: boolean },
): Promise<void> {
  const { client, roomId } = await buildContext(opts)
  const docs = await client.listDocuments(roomId)
  // Targets may be document ids, names, or folder/name paths.
  const documentIds = docTargets.map((t) => resolveDocument(docs, t).id)
  const coverage = await attachToItem(client, roomId, itemId, documentIds)
  report(coverage, itemId, documentIds, opts)
}

/**
 * Attach documents to a checklist item, keeping what is already attached.
 * The PUT takes the FULL desired set, so merge before writing. Returns the
 * refreshed coverage the server hands back.
 */
export async function attachToItem(
  client: MageClient,
  roomId: string,
  itemId: string,
  documentIds: string[],
): Promise<Coverage> {
  const coverage = await client.getCoverage(roomId)
  const item = coverage.items.find((i) => i.itemId === itemId)
  if (!item && coverage.computed) {
    throw new CliError(
      `No checklist item "${itemId}". Run \`mage readiness\` to see the item ids.`,
    )
  }
  // Pre-analysis rooms have no items yet; the server still validates the id.
  const existing = item?.matchedDocumentIds ?? []
  const merged = [...new Set([...existing, ...documentIds])]
  return client.setCoverageItem(roomId, itemId, merged)
}

/** Shared result line for `readiness attach` and `upload --for-item`. */
export function report(
  coverage: Coverage,
  itemId: string,
  attachedIds: string[],
  opts: { json?: boolean },
): void {
  const item = coverage.items.find((i) => i.itemId === itemId)
  if (opts.json) {
    output.printJson({
      itemId,
      attached: attachedIds,
      status: item?.status ?? null,
      missingRequiredCount: coverage.missingRequiredCount,
    })
    return
  }
  const label = item?.label ?? itemId
  const status = item ? ` — now ${item.status.replace('_', ' ')}` : ''
  output.success(
    `Attached ${attachedIds.length} document${attachedIds.length === 1 ? '' : 's'} to "${label}"${status}.`,
  )
  if (coverage.missingRequiredCount > 0) {
    output.info(
      `${coverage.missingRequiredCount} required item${coverage.missingRequiredCount === 1 ? '' : 's'} still missing — see \`mage readiness\`.`,
    )
  }
}

function statusGlyph(status: string): string {
  switch (status) {
    case 'present':
      return output.colors.green('✓')
    case 'partial':
      return output.colors.yellow('◐')
    case 'missing':
      return output.colors.red('✗')
    case 'not_applicable':
      return output.colors.dim('–')
    default:
      return ' '
  }
}
