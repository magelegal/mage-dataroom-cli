import { expect, test } from 'bun:test'
import { roomSnapshot, webAppUrl } from '../binding'
import { browserCommand } from '../session'

// ── roomSnapshot: the post-bind proof-of-life line ───────────────────────────

test('roomSnapshot summarizes documents and distinct folders', () => {
  expect(roomSnapshot([])).toBe('empty and ready')
  expect(roomSnapshot([{ folderPath: 'Corporate' }])).toBe('1 document in 1 folder')
  expect(
    roomSnapshot([
      { folderPath: 'Corporate' },
      { folderPath: 'Corporate/Charters' },
      { folderPath: null }, // Unsorted counts as its own folder
      { folderPath: 'Finance' },
    ]),
  ).toBe('4 documents in 4 folders')
})

// ── webAppUrl: api host → web host, with a production fallback ──────────────

test('webAppUrl pairs api-dataroom hosts with their dataroom web app', () => {
  expect(webAppUrl('https://api-dataroom.magelegal.com')).toBe('https://dataroom.magelegal.com')
  expect(webAppUrl('https://api-dataroom.staging.magelegal.com')).toBe('https://dataroom.staging.magelegal.com')
  expect(webAppUrl('https://api-dataroom.pr-12.dataroom.preview.magelegal.com')).toBe(
    'https://dataroom.pr-12.dataroom.preview.magelegal.com',
  )
})

test('webAppUrl falls back to production for unrecognizable hosts', () => {
  expect(webAppUrl('http://localhost:8000')).toBe('https://dataroom.magelegal.com')
  expect(webAppUrl('not a url')).toBe('https://dataroom.magelegal.com')
})

// ── browserCommand: per-platform open, with Windows title-arg guard ─────────

test('browserCommand picks the right opener per platform', () => {
  const url = 'https://auth.example.com/device?user_code=BCDF-GHJK'
  expect(browserCommand(url, 'darwin')).toEqual({ cmd: 'open', args: [url] })
  expect(browserCommand(url, 'linux')).toEqual({ cmd: 'xdg-open', args: [url] })
  // The empty string is start's window-title slot — without it, a quoted URL
  // becomes the title and nothing opens.
  expect(browserCommand(url, 'win32')).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', url] })
  expect(browserCommand(url, 'freebsd')).toBeNull()
})
