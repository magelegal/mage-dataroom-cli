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

test('collectUploads mirrors a directory tree under --to and skips dotfiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'mage-walk-'))
  writeFileSync(join(root, 'a.pdf'), 'a')
  mkdirSync(join(root, 'Corp'))
  writeFileSync(join(root, 'Corp', 'b.pdf'), 'b')
  writeFileSync(join(root, '.DS_Store'), 'junk')

  const items = collectUploads(root, 'Legal').sort((x, y) => x.filename.localeCompare(y.filename))
  rmSync(root, { recursive: true, force: true })

  expect(items.map((i) => [i.filename, i.folderPath])).toEqual([
    ['a.pdf', 'Legal'],
    ['b.pdf', 'Legal/Corp'],
  ])
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
