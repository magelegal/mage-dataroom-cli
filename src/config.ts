/**
 * Local credential + settings store.
 *
 * The CLI persists its credentials at `~/.config/mage/config.json`
 * (XDG-respecting), written `0600` so only its owner can read it. Two kinds of
 * credential live there:
 *
 *  - `apiKey` — the long-lived, room-scoped key every data command uses. A
 *    browser `mage login` mints one automatically (and records its `apiKeyId`
 *    so a later login can revoke the key it replaces); `mage login <key>`
 *    stores a hand-minted one.
 *  - `oauth` — a cached WorkOS session used ONLY by the control-plane commands
 *    (`login` / `rooms` / `use`) to act as the signed-in user. Its refresh
 *    token is SINGLE-USE: WorkOS rotates it on every refresh, so writes must be
 *    atomic (tmp + rename) — a torn config would strand the only valid token.
 *
 * Every value can also come from the environment, which wins over the file —
 * that is the headless path: an AI agent or CI job sets `MAGE_API_KEY` and
 * never runs `mage login`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The lite data-room API. Override with `MAGE_API_URL` or `--api-url`. */
export const DEFAULT_BASE_URL = 'https://api-dataroom.magelegal.com'

/** A cached WorkOS session (control-plane only — data commands never read it). */
export interface StoredOAuth {
  /** Short-lived (~5 min) RS256 access JWT. */
  accessToken: string
  /** Single-use: rotated by WorkOS on every refresh. Persist replacements immediately. */
  refreshToken: string
  /** The deployment's public WorkOS client id — needed for every refresh. */
  clientId: string
  /** Display only. */
  email?: string
}

export interface MageConfig {
  apiKey?: string
  /** Set only for CLI-minted keys, so a re-login can revoke the key it replaces. */
  apiKeyId?: string
  roomId?: string
  roomName?: string
  baseUrl?: string
  oauth?: StoredOAuth
}

export interface ResolvedSettings {
  apiKey?: string
  apiKeyId?: string
  roomId?: string
  roomName?: string
  baseUrl: string
  oauth?: StoredOAuth
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(base, 'mage')
}

export function configPath(): string {
  return join(configDir(), 'config.json')
}

export function loadConfig(): MageConfig {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MageConfig
  } catch {
    // A corrupt config should never wedge the CLI — treat it as empty.
    return {}
  }
}

function writeConfig(cfg: MageConfig): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  // Atomic replace: a crash mid-write or a concurrent reader must never see a
  // torn file — with a rotated (single-use) refresh token inside, a torn write
  // would destroy the only valid credential.
  const tmp = join(configDir(), `.config.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  // writeFile's mode passes through the umask; re-assert 0600 explicitly.
  chmodSync(tmp, 0o600)
  renameSync(tmp, configPath())
}

export function saveConfig(patch: Partial<MageConfig>): MageConfig {
  const next = { ...loadConfig(), ...patch }
  writeConfig(next)
  return next
}

/**
 * Read-modify-write in one atomic step. Call sites that switch auth methods or
 * drop fields say exactly what they mean (`delete cfg.oauth`) instead of
 * routing through bespoke helpers.
 */
export function updateConfig(mutate: (cfg: MageConfig) => void): MageConfig {
  const cfg = loadConfig()
  mutate(cfg)
  writeConfig(cfg)
  return cfg
}

/** Drop every stored credential + the room binding; keep non-secret preferences. */
export function clearAuth(): void {
  updateConfig((cfg) => {
    delete cfg.apiKey
    delete cfg.apiKeyId
    delete cfg.roomId
    delete cfg.roomName
    delete cfg.oauth
  })
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Merge env, file, and CLI flags into the effective settings. Precedence
 * (highest first): explicit `--api-url`, environment, config file, built-in
 * default. The API key and room id likewise prefer the environment so a
 * headless run needs no `mage login`. When the env key wins, the file's
 * `apiKeyId` is withheld — it describes the file's key, not the env's.
 */
export function resolveSettings(opts: { apiUrl?: string } = {}): ResolvedSettings {
  const file = loadConfig()
  const envKey = process.env.MAGE_API_KEY?.trim()
  return {
    apiKey: envKey || file.apiKey,
    apiKeyId: envKey ? undefined : file.apiKeyId,
    roomId: process.env.MAGE_ROOM_ID?.trim() || file.roomId,
    roomName: file.roomName,
    oauth: file.oauth,
    baseUrl: stripTrailingSlash(
      opts.apiUrl?.trim() ||
        process.env.MAGE_API_URL?.trim() ||
        file.baseUrl ||
        DEFAULT_BASE_URL,
    ),
  }
}
