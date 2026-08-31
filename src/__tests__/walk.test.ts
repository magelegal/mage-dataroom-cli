import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectUploads, formatBytes, joinFolder } from '../walk'

test('joinFolder normalizes slashes and drops empties', () => {
  expect(joinFolder('A', null, 'B')).toBe('A/B')
  expect(joinFolder('/A/', 'B/')).toBe('A/B')
  expect(joinFolder('', null, undefined)).toBeNull()
})

test('collectUploads mirrors a directory tree under --to, skipping OS junk', () => {
  // The room holds what you see in the folder (#5465). Your computer writes
  // `.DS_Store` and the `__MACOSX` stubs for itself and never shows them, so
  // the walk goes past them — and past the whole `__MACOSX` tree, not just its
  // top entry. Dotfiles you made on purpose still upload: `.git/HEAD` and
  // `.hidden-note.txt` are both here on purpose.
  const root = mkdtempSync(join(tmpdir(), 'mage-walk-'))
  writeFileSync(join(root, 'a.pdf'), 'a')
  mkdirSync(join(root, 'Corp'))
  writeFileSync(join(root, 'Corp', 'b.pdf'), 'b')
  writeFileSync(join(root, '.DS_Store'), 'junk')
  mkdirSync(join(root, '__MACOSX', 'Corp'), { recursive: true })
  writeFileSync(join(root, '__MACOSX', '._a.pdf'), 'fork')
  writeFileSync(join(root, '__MACOSX', 'Corp', '._b.pdf'), 'fork')
  writeFileSync(join(root, 'Corp', '~$b.pdf'), 'lock')
  mkdirSync(join(root, '.git', 'objects'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
  writeFileSync(join(root, '.git', 'objects', 'pack-1'), 'obj')
  writeFileSync(join(root, 'Corp', '.hidden-note.txt'), 'note')

  const items = collectUploads(root, 'Legal')
  rmSync(root, { recursive: true, force: true })

  const pairs = items.map((i) => [i.filename, i.folderPath])
  expect(pairs).toHaveLength(5)
  expect(pairs).toEqual(
    expect.arrayContaining([
      ['HEAD', 'Legal/.git'],
      ['pack-1', 'Legal/.git/objects'],
      ['.hidden-note.txt', 'Legal/Corp'],
      ['a.pdf', 'Legal'],
      ['b.pdf', 'Legal/Corp'],
    ]),
  )
})

test('a file you name directly is uploaded even if it is OS junk', () => {
  // Naming a path is how you say you can see it. The skip is a WALK rule, so
  // `mage upload ./.DS_Store` still works if someone really means it.
  const root = mkdtempSync(join(tmpdir(), 'mage-walk-named-'))
  writeFileSync(join(root, '.DS_Store'), 'junk')

  const items = collectUploads(join(root, '.DS_Store'), 'Legal')
  rmSync(root, { recursive: true, force: true })

  expect(items.map((i) => [i.filename, i.folderPath])).toEqual([['.DS_Store', 'Legal']])
})

test('collectUploads of a single file files it under --to', () => {
  const root = mkdtempSync(join(tmpdir(), 'mage-walk-'))
  const file = join(root, 'x.pdf')
  writeFileSync(file, 'x')

  const items = collectUploads(file, 'Folder')
  rmSync(root, { recursive: true, force: true })

  expect(items).toEqual([{ absPath: file, filename: 'x.pdf', folderPath: 'Folder' }])
})

test('collectUploads of a single file with no --to lands in the root (null folder)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mage-walk-'))
  const file = join(root, 'x.pdf')
  writeFileSync(file, 'x')

  const items = collectUploads(file, null)
  rmSync(root, { recursive: true, force: true })

  expect(items[0]!.folderPath).toBeNull()
})

test('formatBytes renders human sizes', () => {
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(1536)).toBe('1.5 KB')
})
