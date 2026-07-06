/**
 * Turn the local paths a user passes to `mage upload` into a flat list of files,
 * each tagged with the room folder it should land in — so a directory upload
 * mirrors its tree into the data room.
 *
 * A directory argument uploads its *contents* under `--to` (the wrapper dir name
 * is not repeated), matching how people think about "put this folder's files in
 * the room". Dotfiles (`.DS_Store`, `.git`, …) are skipped.
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface UploadItem {
  absPath: string
  filename: string
  folderPath: string | null
}

/** Join folder segments into one normalized path; empty → null (room root). */
export function joinFolder(...parts: (string | null | undefined)[]): string | null {
  const segs = parts
    .flatMap((p) => (p ?? '').split('/'))
    .map((s) => s.trim())
    .filter(Boolean)
  return segs.length ? segs.join('/') : null
}

/**
 * Expand one input path (file or directory) into upload items. Files land in
 * `toFolder`; a directory's files mirror its subtree beneath `toFolder`.
 */
export function collectUploads(inputPath: string, toFolder: string | null): UploadItem[] {
  const st = statSync(inputPath) // ENOENT here surfaces as a clear per-path error upstream

  if (st.isFile()) {
    return [{ absPath: inputPath, filename: basename(inputPath), folderPath: joinFolder(toFolder) }]
  }
  if (!st.isDirectory()) return []

  const items: UploadItem[] = []
  const walk = (dir: string, relFolder: string | null): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue // skip dotfiles / dot-dirs
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs, joinFolder(relFolder, entry.name))
      } else if (entry.isFile()) {
        items.push({ absPath: abs, filename: entry.name, folderPath: joinFolder(toFolder, relFolder) })
      }
    }
  }
  walk(inputPath, null)
  return items
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
