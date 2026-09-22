import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Coverage, DocumentSummary } from '../client'
import { alreadyThereLine, uploadCommand } from '../commands/dataroom/upload'

test('says how many files were already there, plural', () => {
  expect(alreadyThereLine(2)).toBe('2 files were already there.')
  expect(alreadyThereLine(10)).toBe('10 files were already there.')
})

test('says it in the singular for one file', () => {
  expect(alreadyThereLine(1)).toBe('1 file was already there.')
})

test('says nothing when every file was new', () => {
  expect(alreadyThereLine(0)).toBeNull()
})

// ── The whole command against a stubbed API ────────────────────────────────
//
// The room answers `old.pdf` as already there and `new.pdf` as created.

const ENV_KEYS = ['MAGE_API_KEY', 'MAGE_ROOM_ID', 'MAGE_API_URL', 'XDG_CONFIG_HOME']
const savedEnv: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch
let dir: string
let stderr: string[]
let stdout: string[]
let stderrSpy: ReturnType<typeof spyOn>
let stdoutSpy: ReturnType<typeof spyOn>

function landed(name: string): DocumentSummary {
  return {
    id: `doc-${name}`,
    name,
    status: 'processing',
    processingPhase: 'uploaded',
    folderPath: null,
    litePageCount: null,
    liteCategory: null,
    indexNumber: null,
    version: 1,
    externalSource: null,
    createdAt: '2026-01-01T00:00:00Z',
    placement: name === 'old.pdf' ? 'existing' : 'created',
  }
}

const coverage: Coverage = {
  roomId: 'room1',
  computed: true,
  missingRequiredCount: 0,
  computedAt: '2026-01-01T00:00:00Z',
  items: [
    {
      itemId: 'item-1',
      label: 'Charter',
      requirementLevel: 'required',
      status: 'present',
      matchedDocumentIds: [],
      completed: true,
      section: 'Corporate',
      expectedScope: 'The charter.',
      founderHint: 'Check your records.',
      multiDoc: true,
    },
  ],
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mage-upload-test-'))
  writeFileSync(join(dir, 'old.pdf'), 'old')
  writeFileSync(join(dir, 'new.pdf'), 'new')
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.MAGE_API_KEY = 'mk_test'
  process.env.MAGE_ROOM_ID = 'room1'
  process.env.MAGE_API_URL = 'https://api.example.com'
  process.env.XDG_CONFIG_HOME = dir
  // The direct multipart road: each file's upload id is its name, so the
  // complete call knows which file it assembles.
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(url)
    if (path.endsWith('/rooms/room1/documents/initiate') && init?.method === 'POST') {
      const { filename } = JSON.parse(String(init.body)) as { filename: string }
      return json({
        uploadId: filename,
        s3Key: `rooms/room1/${filename}`,
        chunkSize: 1024,
        totalParts: 1,
        presignedUrls: { '1': `https://storage.example/${filename}` },
        expiresIn: 3600,
      })
    }
    if (path.startsWith('https://storage.example/') && init?.method === 'PUT') {
      return new Response(null, { status: 200, headers: { etag: '"e1"' } })
    }
    const complete = path.match(/\/rooms\/room1\/documents\/([^/]+)\/complete$/)
    if (complete && init?.method === 'POST') {
      const uploadId = complete[1]
      if (uploadId === undefined) throw new Error(`complete path carries no upload id: ${path}`)
      return json(landed(uploadId))
    }
    if (path.includes('/rooms/room1/coverage')) return json(coverage)
    throw new Error(`unexpected request ${init?.method} ${path}`)
  }) as typeof fetch
  stderr = []
  stdout = []
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
})

afterEach(() => {
  stderrSpy.mockRestore()
  stdoutSpy.mockRestore()
  globalThis.fetch = realFetch
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

function lines(): string[] {
  return stderr.join('').split('\n').filter((line) => line.trim() !== '')
}

test('the already-there count is the last line, after the checklist line', async () => {
  await uploadCommand([dir], { forItem: 'item-1' })

  const printed = lines()
  expect(printed.at(-1)).toBe('1 file was already there.')
  expect(printed.some((line) => line.includes('Attached 2 documents to "Charter"'))).toBe(true)
})

test('--json names each file the room already held, and the count', async () => {
  await uploadCommand([dir], { json: true })

  const payload = JSON.parse(stdout.join('')) as {
    alreadyThere: number
    results: { file: string; alreadyThere: boolean }[]
  }
  expect(payload.alreadyThere).toBe(1)
  const byFile = Object.fromEntries(payload.results.map((r) => [r.file, r.alreadyThere]))
  expect(byFile).toEqual({ [join(dir, 'old.pdf')]: true, [join(dir, 'new.pdf')]: false })
  expect(lines().some((line) => line.includes('already there'))).toBe(false)
})
