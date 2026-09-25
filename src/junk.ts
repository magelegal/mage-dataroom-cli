/**
 * The files your operating system writes for itself and hides from you.
 *
 * A data room mirrors what you see in your own folders. Your computer drops
 * bookkeeping files beside your documents — `.DS_Store` on macOS, `Thumbs.db`
 * and `desktop.ini` on Windows, the `._` resource-fork stubs inside a
 * Finder-made zip, the `~$` lock file and `~WRL` temp file Word leaves while
 * a document is open, a macOS volume's `.Spotlight-V100` index and `.Trashes`
 * folder, a Synology NAS's `@eaDir` thumbnails — and shows you none of them.
 * Uploading them would put numbered rows in a data room for files you never
 * knew existed, so `mage upload` walks past them.
 *
 * NO BARE-DOT RULE, deliberately. A leading `.` is not the test: `.env`,
 * `.gitignore` and `.htaccess` are visible to anyone who looks, and are
 * sometimes the item under diligence themselves. Only `._`, `~$` and `~WRL`
 * are junk prefixes; the dot-folders above are named exactly.
 *
 * Case does not matter. Windows and macOS disks do not tell `thumbs.db` from
 * `Thumbs.db` by default, so either spelling is the same hidden file.
 *
 * Everything else uploads — an empty file, a program, a format nothing can
 * read. You can see those in your own folder, so the room shows them too.
 */

/** Names the OS writes for itself, matched exactly but for case. */
const SEGMENT_SEEN_BY_NOBODY: ReadonlySet<string> = new Set([
  '__MACOSX',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.Spotlight-V100',
  '.Trashes',
  '@eaDir',
])

/** AppleDouble resource forks, Office lock files, and Word temp files. */
const PREFIX_SEEN_BY_NOBODY: readonly string[] = ['._', '~$', '~WRL']

const SEGMENTS_FOLDED: ReadonlySet<string> = new Set(
  [...SEGMENT_SEEN_BY_NOBODY].map((segment) => segment.toLowerCase()),
)
const PREFIXES_FOLDED: readonly string[] = PREFIX_SEEN_BY_NOBODY.map((prefix) =>
  prefix.toLowerCase(),
)

/**
 * True if this path segment names OS bookkeeping.
 *
 * Takes ONE segment — a file or directory name, never a whole path — so the
 * walk can test a directory before it descends.
 *
 * The service applies the same list to anything that reaches it by another
 * route, so a name walked past here and accepted there — or the reverse —
 * would mean the room does not match the folder you uploaded.
 * `src/__tests__/junk.test.ts` snapshots the vocabulary so a change to it is
 * deliberate.
 */
export function isJunkSegment(segment: string): boolean {
  if (!segment) return false
  const folded = segment.toLowerCase()
  if (SEGMENTS_FOLDED.has(folded)) return true
  return PREFIXES_FOLDED.some((prefix) => folded.startsWith(prefix))
}
