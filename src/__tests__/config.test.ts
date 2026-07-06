import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredOAuth } from '../config'
import {
  DEFAULT_BASE_URL,
  clearAuth,
  configPath,
  loadConfig,
  resolveSettings,
  saveConfig,
  updateConfig,
} from '../config'

let tmp: string
const envBackup = { ...process.env }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mage-cli-cfg-'))
  process.env.XDG_CONFIG_HOME = tmp
  delete process.env.MAGE_API_KEY
  delete process.env.MAGE_API_URL
  delete process.env.MAGE_ROOM_ID
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  process.env = { ...envBackup }
})

test('save then load round-trips the stored config', () => {
  saveConfig({ apiKey: 'k1', roomId: 'r1', roomName: 'Room', baseUrl: 'https://x' })
  expect(loadConfig()).toMatchObject({ apiKey: 'k1', roomId: 'r1', roomName: 'Room' })
})

test('the environment overrides the file for the API key', () => {
  saveConfig({ apiKey: 'file-key', baseUrl: 'https://file' })
  process.env.MAGE_API_KEY = 'env-key'
  const s = resolveSettings()
  expect(s.apiKey).toBe('env-key')
  // baseUrl still comes from the file (no env / flag set).
  expect(s.baseUrl).toBe('https://file')
})

test('--api-url beats both env and file, trailing slash stripped', () => {
  process.env.MAGE_API_URL = 'https://env'
  expect(resolveSettings({ apiUrl: 'https://flag/' }).baseUrl).toBe('https://flag')
})

test('baseUrl falls back to the built-in default', () => {
  expect(resolveSettings().baseUrl).toBe(DEFAULT_BASE_URL)
})

test('clearAuth removes the key + room but keeps non-secret settings', () => {
  saveConfig({ apiKey: 'k', roomId: 'r', roomName: 'Room', baseUrl: 'https://x' })
  clearAuth()
  const c = loadConfig()
  expect(c.apiKey).toBeUndefined()
  expect(c.roomId).toBeUndefined()
  expect(c.baseUrl).toBe('https://x')
})

const OAUTH: StoredOAuth = {
  accessToken: 'at1',
  refreshToken: 'rt1',
  clientId: 'client_x',
  email: 'founder@example.com',
}

test('oauth session + apiKeyId round-trip and resolve from the file', () => {
  saveConfig({ apiKey: 'k1', apiKeyId: 'key_1', oauth: OAUTH })
  expect(loadConfig().oauth).toEqual(OAUTH)
  const s = resolveSettings()
  expect(s.apiKeyId).toBe('key_1')
  expect(s.oauth).toEqual(OAUTH)
})

test('a legacy config file (no oauth fields) still resolves as a key login', () => {
  saveConfig({}) // create the dir + file
  writeFileSync(
    configPath(),
    JSON.stringify({ apiKey: 'mk_live_old', roomId: 'r1', roomName: 'Room', baseUrl: 'https://x' }),
  )
  const s = resolveSettings()
  expect(s.apiKey).toBe('mk_live_old')
  expect(s.apiKeyId).toBeUndefined()
  expect(s.oauth).toBeUndefined()
})

test('the env key wins and withholds the file apiKeyId (it belongs to the file key)', () => {
  saveConfig({ apiKey: 'file-key', apiKeyId: 'key_1' })
  process.env.MAGE_API_KEY = 'env-key'
  const s = resolveSettings()
  expect(s.apiKey).toBe('env-key')
  expect(s.apiKeyId).toBeUndefined()
})

test('updateConfig deletes fields atomically and keeps the file parseable + 0600', () => {
  saveConfig({ apiKey: 'k', apiKeyId: 'key_1', oauth: OAUTH, baseUrl: 'https://x' })
  updateConfig((cfg) => {
    delete cfg.oauth
    delete cfg.apiKeyId
  })
  const raw = readFileSync(configPath(), 'utf8')
  expect(JSON.parse(raw)).toEqual({ apiKey: 'k', baseUrl: 'https://x' })
  expect(statSync(configPath()).mode & 0o777).toBe(0o600)
})

test('clearAuth also drops the oauth session and apiKeyId', () => {
  saveConfig({ apiKey: 'k', apiKeyId: 'key_1', roomId: 'r', oauth: OAUTH, baseUrl: 'https://x' })
  clearAuth()
  const c = loadConfig()
  expect(c.oauth).toBeUndefined()
  expect(c.apiKeyId).toBeUndefined()
  expect(c.baseUrl).toBe('https://x')
})
