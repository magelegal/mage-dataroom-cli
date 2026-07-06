import type { DocumentSummary } from '../../client'
import { buildContext } from '../../context'
import * as output from '../../output'

const UNSORTED = 'Unsorted'

/**
 * List the room's documents grouped by folder — the agent's read-before-write
 * surface. `--json` emits the raw document array for programmatic use.
 */
export async function lsCommand(
  folder: string | undefined,
  opts: { apiUrl?: string; json?: boolean },
): Promise<void> {
  const { client, roomId } = await buildContext(opts)
  let docs = await client.listDocuments(roomId)

  const root = folder?.replace(/^\/+|\/+$/g, '').trim()
  if (root) {
    docs = docs.filter((d) => {
      const f = d.folderPath ?? ''
      return f === root || f.startsWith(root + '/')
    })
  }

  if (opts.json) {
    output.printJson(docs)
    return
  }

  if (docs.length === 0) {
    output.info(root ? `No documents under "${root}".` : 'This room has no documents yet.')
    return
  }

  const byFolder = new Map<string, DocumentSummary[]>()
  for (const d of docs) {
    const key = d.folderPath ?? UNSORTED
    const list = byFolder.get(key) ?? []
    list.push(d)
    byFolder.set(key, list)
  }

  // Folders alphabetically; Unsorted always last.
  const folders = [...byFolder.keys()].sort((a, b) => {
    if (a === UNSORTED) return 1
    if (b === UNSORTED) return -1
    return a.localeCompare(b)
  })

  for (const f of folders) {
    output.out(output.colors.bold(f === UNSORTED ? UNSORTED : `${f}/`))
    const rows = byFolder
      .get(f)!
      .sort(
        (a, b) =>
          (a.indexNumber ?? '').localeCompare(b.indexNumber ?? '', undefined, { numeric: true }) ||
          a.name.localeCompare(b.name),
      )
    for (const d of rows) {
      const idx = (d.indexNumber ?? '—').padEnd(7)
      output.out(`  ${output.colors.dim(idx)}${d.name}  ${statusLabel(d)}`)
    }
  }
}

function statusLabel(d: DocumentSummary): string {
  const text = d.status || 'unknown'
  // 'processing' is the known in-flight state; anything else is treated as done.
  return text === 'processing' ? output.colors.yellow(text) : output.colors.green(text)
}
