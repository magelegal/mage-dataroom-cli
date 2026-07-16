import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DocumentSummary } from '../../../client'
import { downloadCommand, safeLocalPath } from '../download'

// ── safeLocalPath: nothing the server stores may escape the dest root ───────

test('safeLocalPath strips traversal, absolute prefixes, and drive letters', () => {
  expect(safeLocalPath(null, 'a.pdf')).toBe('a.pdf')
  expect(safeLocalPath('Corporate/Charters', 'b.pdf')).toBe(join('Corporate', 'Charters', 'b.pdf'))
  expect(safeLocalPath('../../etc', 'passwd')).toBe(join('etc', 'passwd'))
  expect(safeLocalPath('/abs/path', 'leak.txt')).toBe(join('abs', 'path', 'leak.txt'))
  expect(safeLocalPath('C:\\evil', 'f.txt')).toBe(join('C__evil', 'f.txt'))
  expect(safeLocalPath('Folder', '..bad')).toBe(join('Folder', 'bad'))
  expect(safeLocalPath('Folder', '')).toBe(join('Folder', 'document'))
})

// ── downloadCommand against a faked client + faked S3 fetch ─────────────────

const DOCS: DocumentSummary[] = [
  { id: 'd1', name: 'Charter.pdf', folderPath: 'Corporate' },
  { id: 'd2', name: 'Minutes.pdf', folderPath: 'Corporate/Minutes' },
  { id: 'd3', name: 'Notes.txt', folderPath: null },
] as DocumentSummary[]

let dest: string
const realFetch = globalThis.fetch

const fakeClient = {
  listDocuments: mock(async () => DOCS),
  getContext: mock(async () => ({ roomId: 'room1', roomName: 'ExampleCo Raise', keyName: 'k' })),
  getDocumentUrl: mock(async (_roomId: string, docId: string) => ({
    url: `https://s3/presigned/${docId}`,
    isPdfDerivative: false,
  })),
}

mock.module('../../../context', () => ({
  buildContext: async () => ({ client: fakeClient, roomId: 'room1' }),
  CliError: class CliError extends Error {},
}))

beforeEach(() => {
  dest = mkdtempSync(join(tmpdir(), 'mage-download-'))
  fakeClient.getDocumentUrl.mockClear()
  globalThis.fetch = (async (url: unknown) => {
    const docId = String(url).split('/').at(-1)
    return new Response(`bytes-of-${docId}`, { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(dest, { recursive: true, force: true })
  process.exitCode = 0
})

test('no target downloads the whole room, mirroring the folder tree', async () => {
  await downloadCommand(undefined, dest, { json: true })

  expect(readFileSync(join(dest, 'Corporate', 'Charter.pdf'), 'utf8')).toBe('bytes-of-d1')
})

test("'.' is the explicit whole-room target (whole room into a chosen dest)", async () => {
  await downloadCommand('.', dest, { json: true })

  expect(readFileSync(join(dest, 'Corporate', 'Charter.pdf'), 'utf8')).toBe('bytes-of-d1')
  expect(readFileSync(join(dest, 'Corporate', 'Minutes', 'Minutes.pdf'), 'utf8')).toBe('bytes-of-d2')
  expect(readFileSync(join(dest, 'Notes.txt'), 'utf8')).toBe('bytes-of-d3')
  expect(fakeClient.getDocumentUrl).toHaveBeenCalledTimes(3)
})

test('a folder target recurses with ls prefix semantics, relative to the folder', async () => {
  await downloadCommand('Corporate', dest, { json: true })

  // Paths inside dest are relative to the requested folder — not re-nested.
  expect(readFileSync(join(dest, 'Charter.pdf'), 'utf8')).toBe('bytes-of-d1')
  expect(readFileSync(join(dest, 'Minutes', 'Minutes.pdf'), 'utf8')).toBe('bytes-of-d2')
  expect(existsSync(join(dest, 'Notes.txt'))).toBe(false)
})

test('a folder/name target downloads exactly one document', async () => {
  await downloadCommand('Corporate/Charter.pdf', dest, { json: true })

  expect(readFileSync(join(dest, 'Charter.pdf'), 'utf8')).toBe('bytes-of-d1')
  expect(fakeClient.getDocumentUrl).toHaveBeenCalledTimes(1)
})

test('a partial failure downloads the rest and sets the exit code', async () => {
  globalThis.fetch = (async (url: unknown) => {
    const docId = String(url).split('/').at(-1)
    if (docId === 'd2') return new Response('nope', { status: 500 })
    return new Response(`bytes-of-${docId}`, { status: 200 })
  }) as typeof fetch

  await downloadCommand(undefined, dest, { json: true })

  expect(readFileSync(join(dest, 'Corporate', 'Charter.pdf'), 'utf8')).toBe('bytes-of-d1')
  expect(existsSync(join(dest, 'Corporate', 'Minutes', 'Minutes.pdf'))).toBe(false)
  expect(process.exitCode).toBe(1)
})

test('a key minted without room:download surfaces the re-mint message once', async () => {
  const { ApiError } = await import('../../../client')
  fakeClient.getDocumentUrl.mockImplementation(async () => {
    throw new ApiError(403, '{"code":"missing_permission","permission":"room:download"}')
  })

  await expect(downloadCommand(undefined, dest, { json: true })).rejects.toThrow(
    /re-mint it with download enabled/i,
  )
  fakeClient.getDocumentUrl.mockImplementation(async (_roomId: string, docId: string) => ({
    url: `https://s3/presigned/${docId}`,
    isPdfDerivative: false,
  }))
})
