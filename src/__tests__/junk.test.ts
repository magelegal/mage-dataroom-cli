import { expect, test } from 'bun:test'
import { isJunkSegment } from '../junk'

/**
 * Snapshot of the junk vocabulary.
 *
 * The list below is spelled out separately from the one in `src/junk.ts` so
 * that changing the vocabulary takes two edits and is therefore deliberate.
 * The service drops the same names when a file reaches it by any other route,
 * so a name that the CLI walks past but the service accepts — or the reverse —
 * would mean the room you see after `mage upload` is not the folder you
 * uploaded.
 */
const EXPECTED_SEGMENTS = ['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini', 'Desktop.ini']

/** Order is part of the snapshot. */
const EXPECTED_PREFIXES = ['._', '~$']

test('the exact segment names are junk', () => {
  for (const segment of EXPECTED_SEGMENTS) {
    expect(isJunkSegment(segment)).toBe(true)
  }
})

test('the prefix rules are junk', () => {
  for (const prefix of EXPECTED_PREFIXES) {
    expect(isJunkSegment(`${prefix}anything`)).toBe(true)
  }
})

test('nothing outside the snapshot is junk', () => {
  // The half a snapshot alone would miss: a wider rule would still pass every
  // assertion above. These are the names most likely to be swept up by one.
  for (const name of [
    'Contract.pdf',
    'thumbs.db',
    'MACOSX',
    'desktop.initiative.docx',
    'report._final.pdf',
    'budget~$1.xlsx',
  ]) {
    expect(isJunkSegment(name)).toBe(false)
  }
})

test('a dotfile you made on purpose is NOT junk', () => {
  // The half that is easiest to get wrong. A leading `.` is not the test:
  // these are visible to anyone who looks, and are sometimes the item under
  // diligence themselves. A bare-dot rule would walk past them.
  for (const name of ['.env', '.gitignore', '.htaccess', '.git', 'README.md', 'a.pdf']) {
    expect(isJunkSegment(name)).toBe(false)
  }
})

test('an empty segment is not junk', () => {
  expect(isJunkSegment('')).toBe(false)
})
