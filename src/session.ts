/**
 * The control-plane session: acting as the signed-in USER (not a room key).
 *
 * Only three commands need this — `login`, `rooms`, and `use` — to list the
 * org's rooms and mint/revoke the CLI's room key. Data commands run on the
 * long-lived key and never touch any of it.
 *
 * The session is a cached WorkOS token pair in the config file. Access tokens
 * live ~5 minutes; refresh tokens are SINGLE-USE (each refresh rotates in a
 * replacement), so every rotation is persisted immediately and config writes
 * are atomic. When the session is dead (revoked / expired), we fall back to a
 * fresh browser device flow — with a live AuthKit session in the browser
 * that's a quick re-approve, not a full sign-in.
 */
import { spawn } from 'node:child_process'
import { ApiError, fetchAuthConfig } from './client'
import type { ResolvedSettings, StoredOAuth } from './config'
import { loadConfig, updateConfig } from './config'
import { CliError } from './context'
import type { TokenGrant } from './workos'
import {
  OAuthError,
  decodeJwtExp,
  pollForTokens,
  refreshTokenGrant,
  startDeviceAuthorization,
} from './workos'

/** Injectable seams for tests; every default is the real thing. */
export interface SessionHooks {
  refresh?: typeof refreshTokenGrant
  /** Runs the full interactive device flow (prints instructions, polls). */
  deviceFlow?: (clientId: string) => Promise<TokenGrant>
  fetchConfig?: typeof fetchAuthConfig
  load?: typeof loadConfig
  persist?: (oauth: StoredOAuth) => void
  now?: () => number
  /** Whether a human is present to complete a browser flow. */
  isInteractive?: boolean
  /** Print the approval URL without launching a browser (`--no-browser`). */
  noBrowser?: boolean
}

function persistGrant(clientId: string, grant: TokenGrant, hooks: SessionHooks): StoredOAuth {
  const oauth: StoredOAuth = {
    accessToken: grant.access_token,
    refreshToken: grant.refresh_token,
    clientId,
    email: grant.user?.email,
  }
  const persist = hooks.persist ?? ((o: StoredOAuth) => updateConfig((cfg) => (cfg.oauth = o)))
  persist(oauth)
  return oauth
}

/**
 * The deployment's public client id: an env override for edge cases, else
 * discovery from whatever API host the CLI is pointed at.
 */
export async function resolveClientId(settings: ResolvedSettings, hooks: SessionHooks = {}): Promise<string> {
  const fromEnv = process.env.MAGE_OAUTH_CLIENT_ID?.trim()
  if (fromEnv) return fromEnv
  try {
    return (await (hooks.fetchConfig ?? fetchAuthConfig)(settings.baseUrl)).clientId
  } catch (err) {
    // A 404 means this deployment predates the auth-config endpoint (a freshly
    // published CLI can be ahead of a not-yet-promoted API). Say so plainly
    // instead of surfacing a bare "Not Found".
    if (err instanceof ApiError && err.status === 404) {
      throw new CliError(
        'Browser login isn’t enabled on this deployment yet. Use `mage login <key>` meanwhile.',
      )
    }
    throw err
  }
}

/** The platform's open-a-URL command, or null when there isn't a sane one. */
export function browserCommand(url: string, platform: NodeJS.Platform): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: [url] }
  if (platform === 'linux') return { cmd: 'xdg-open', args: [url] }
  // `start` is a cmd built-in; the empty string is the window title so a URL
  // containing separators is never mistaken for one.
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] }
  return null
}

/** Best-effort `open <url>`; a browser that won't open is never fatal — the URL is printed. */
function tryOpenBrowser(url: string): void {
  const opener = browserCommand(url, process.platform)
  if (!opener) return
  try {
    const child = spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Ignore — the printed URL is the fallback.
  }
}

/** Over SSH there is no local browser to open — print the URL and stand back. */
function isRemoteShell(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY)
}

/**
 * The interactive browser login. Instructions go straight to stderr — even in
 * `--json` mode — because the flow cannot complete unless a human sees them;
 * stdout stays clean for machine output.
 */
async function runInteractiveDeviceFlow(clientId: string, opts: { noBrowser?: boolean } = {}): Promise<TokenGrant> {
  const device = await startDeviceAuthorization(clientId)
  const openBrowser = !opts.noBrowser && !isRemoteShell()
  process.stderr.write(
    `\n  First, confirm this code matches your browser: ${device.user_code}\n\n` +
      (openBrowser
        ? `  Opening ${device.verification_uri_complete}\n  (if the browser didn't open, visit that URL yourself)\n\n`
        : `  Visit ${device.verification_uri_complete}\n  (on any device — your phone works too)\n\n`) +
      `  Waiting for approval…`,
  )
  if (openBrowser) tryOpenBrowser(device.verification_uri_complete)
  try {
    // A dim dot per poll so the wait visibly breathes.
    return await pollForTokens(clientId, device, { onPoll: () => process.stderr.write('.') })
  } finally {
    process.stderr.write('\n\n')
  }
}

/**
 * Run the browser device flow and persist the resulting session. `mage login`
 * calls this unconditionally — logging in should always mean a fresh approval,
 * never silently reusing whoever was cached.
 */
export async function loginSession(settings: ResolvedSettings, hooks: SessionHooks = {}): Promise<StoredOAuth> {
  const clientId = await resolveClientId(settings, hooks)
  const grant = hooks.deviceFlow
    ? await hooks.deviceFlow(clientId)
    : await runInteractiveDeviceFlow(clientId, { noBrowser: hooks.noBrowser })
  return persistGrant(clientId, grant, hooks)
}

/**
 * A working session for `rooms` / `use`: the cached one when fresh, a silent
 * refresh when stale, a browser re-approve when dead. Non-interactive callers
 * with a dead session get a clear "run `mage login`" instead of a hung poll.
 */
export async function getSession(settings: ResolvedSettings, hooks: SessionHooks = {}): Promise<StoredOAuth> {
  const now = hooks.now ?? Date.now
  // Read from disk, not from the settings snapshot — another invocation may
  // have rotated the refresh token since this process resolved its settings.
  const stored = (hooks.load ?? loadConfig)().oauth

  if (stored) {
    const exp = decodeJwtExp(stored.accessToken)
    if (exp !== null && exp * 1000 - now() > 60_000) return stored

    try {
      const grant = await (hooks.refresh ?? refreshTokenGrant)(stored.clientId, stored.refreshToken)
      return persistGrant(stored.clientId, grant, hooks)
    } catch (err) {
      // Only a dead token falls through to a fresh login; network trouble etc.
      // should surface as itself.
      if (!(err instanceof OAuthError && err.code === 'invalid_grant')) throw err
    }
  }

  const interactive = hooks.isInteractive ?? Boolean(process.stderr.isTTY)
  if (!interactive) {
    throw new CliError('Your Mage session has expired or was revoked. Run `mage login` to sign in again.')
  }
  return loginSession(settings, hooks)
}
