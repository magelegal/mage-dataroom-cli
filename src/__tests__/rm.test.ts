import { expect, test } from 'bun:test'
import type { DocumentSummary } from '../client'
import { resolveDocument } from '../commands/dataroom/rm'

function doc(partial: Partial<DocumentSummary> & { id: string; name: string }): DocumentSummary {
  return {
    status: 'ready',
    processingPhase: null,
    folderPath: null,
    litePageCount: null,
    liteCategory: null,
    indexNumber: null,
    version: 1,
    externalSource: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

const docs: DocumentSummary[] = [
  doc({ id: 'a1', name: 'charter.pdf', folderPath: 'Legal' }),
  doc({ id: 'a2', name: 'charter.pdf', folderPath: 'Corp' }),
  doc({ id: 'a3', name: 'unique.pdf', folderPath: null }),
]

test('resolves by exact id first', () => {
  expect(resolveDocument(docs, 'a2').id).toBe('a2')
})

test('resolves a unique name without a folder', () => {
  expect(resolveDocument(docs, 'unique.pdf').id).toBe('a3')
})

test('disambiguates a duplicate name by folder/name', () => {
  expect(resolveDocument(docs, 'Corp/charter.pdf').id).toBe('a2')
})

test('throws on an ambiguous bare name', () => {
  expect(() => resolveDocument(docs, 'charter.pdf')).toThrow(/matches 2 documents/)
})

test('throws when nothing matches', () => {
  expect(() => resolveDocument(docs, 'nope.pdf')).toThrow(/No document matches/)
})
