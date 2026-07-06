import type { DocumentSummary } from '../../client'
import { buildContext, CliError } from '../../context'
import * as output from '../../output'
import { confirm } from '../../prompt'
import { joinFolder } from '../../walk'

/**
 * Delete a document, or a folder with `--folder`.
 *
 * A document target may be its id, its name, or `folder/name` to disambiguate.
 * Folder deletes are calm: the folder's documents move to Unsorted, never gone.
 */
export async function rmCommand(
  target: string,
  opts: { folder?: boolean; yes?: boolean; apiUrl?: string; json?: boolean },
): Promise<void> {
  const { client, roomId } = await buildContext(opts)

  if (opts.folder) {
    const path = joinFolder(target)
    if (!path) throw new CliError('A folder path is required.')
    await confirm(`Delete folder "${path}"? Its documents move to Unsorted (they are not deleted).`, opts.yes)
    const res = await client.deleteFolder(roomId, path)
    if (opts.json) output.printJson(res)
    else output.success(`Deleted folder "${path}".`)
    return
  }

  const docs = await client.listDocuments(roomId)
  const match = resolveDocument(docs, target)
  await confirm(`Delete document "${match.name}"? This cannot be undone.`, opts.yes)
  await client.deleteDocument(roomId, match.id)
  if (opts.json) output.printJson({ deleted: match.id, name: match.name })
  else output.success(`Deleted "${match.name}".`)
}

/** Resolve a target (id, name, or folder/name) to exactly one document. */
export function resolveDocument(docs: DocumentSummary[], target: string): DocumentSummary {
  const byId = docs.find((d) => d.id === target)
  if (byId) return byId

  const norm = target.replace(/^\/+/, '')
  const slash = norm.lastIndexOf('/')
  const wantFolder = slash >= 0 ? norm.slice(0, slash) : null
  const wantName = slash >= 0 ? norm.slice(slash + 1) : norm

  const matches = docs.filter((d) => {
    if (d.name !== wantName) return false
    return wantFolder === null || (d.folderPath ?? '') === wantFolder
  })

  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) {
    throw new CliError(`No document matches "${target}". Run \`mage ls\` to see what's there.`)
  }
  throw new CliError(
    `"${target}" matches ${matches.length} documents. Disambiguate with a folder path (folder/name) or the id:\n` +
      matches.map((m) => `  ${m.id}  ${m.folderPath ? m.folderPath + '/' : ''}${m.name}`).join('\n'),
  )
}
