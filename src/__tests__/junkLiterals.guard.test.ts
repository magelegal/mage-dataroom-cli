import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

/**
 * ONE DOOR: no module under `src/` may spell an OS-junk name of its own.
 *
 * `src/junk.ts` holds the whole list, and `junk.test.ts` pins that list
 * against the source it copies. This pins the other half: that there is only
 * one list. Two lists is how a walk starts skipping a name the uploader
 * sends, or sending one the server refuses.
 *
 * Comments are free — `walk.ts` explains what it skips by naming the files,
 * and prose is not a matcher. Each candidate file is run through
 * `Bun.Transpiler`, which strips comments and keeps string literals, before
 * it is judged. Tests are skipped: a `.DS_Store` in a fixture is data.
 */

const SRC_ROOT = resolve(import.meta.dir, '..')

/** The one door. Named as a path so a move reds here rather than silently. */
const DOOR = resolve(SRC_ROOT, 'junk.ts')

const BANNED_NAMES = [
  '__MACOSX',
  '.DS_Store',
  'Thumbs.db',
  'ehthumbs.db',
  'desktop.ini',
  'Desktop.ini',
  '$RECYCLE.BIN',
  'System Volume Information',
]

/** Prefix matchers, banned only as a WHOLE literal. */
const BANNED_PREFIX_LITERALS = ['._', '~$', '~WRL']

const QUOTE = /['"`]/

function offendingTokens(code: string): string[] {
  const found = new Set<string>()
  for (const name of BANNED_NAMES) {
    if (code.includes(name)) found.add(name)
  }
  for (const prefix of BANNED_PREFIX_LITERALS) {
    for (let at = code.indexOf(prefix); at !== -1; at = code.indexOf(prefix, at + 1)) {
      const before = code[at - 1]
      const after = code[at + prefix.length]
      if (before && after && QUOTE.test(before) && before === after) {
        found.add(prefix)
        break
      }
    }
  }
  return [...found]
}

test('the door is where this guard thinks it is', () => {
  // A guard that reads its subject by path passes on absence.
  expect(existsSync(DOOR)).toBe(true)
  expect(readFileSync(DOOR, 'utf8')).toContain('SEGMENT_SEEN_BY_NOBODY')
})

test('no OS-junk name is spelled outside it', () => {
  const glob = new Bun.Glob('**/*.ts')
  const files = [...glob.scanSync({ cwd: SRC_ROOT, onlyFiles: true })].filter(
    (rel) => !rel.includes('__tests__/'),
  )
  // The sweep is worthless if the glob resolved to nothing.
  expect(files.length).toBeGreaterThan(5)

  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const offenders: string[] = []
  for (const rel of files) {
    const file = resolve(SRC_ROOT, rel)
    if (file === DOOR) continue
    const raw = readFileSync(file, 'utf8')
    if (offendingTokens(raw).length === 0) continue
    let code: string
    try {
      code = transpiler.transformSync(raw)
    } catch {
      code = raw
    }
    const tokens = offendingTokens(code)
    if (tokens.length > 0) offenders.push(`${relative(SRC_ROOT, file)} → ${tokens.join(', ')}`)
  }

  expect(
    offenders,
    'An OS-junk name is spelled in code outside `src/junk.ts`. Ask ' +
      `\`isJunkSegment\` instead. Offenders:\n  ${offenders.join('\n  ')}`,
  ).toEqual([])
})
