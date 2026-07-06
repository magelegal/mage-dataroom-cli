/**
 * WorkOS device-authorization flow (OAuth 2.0 Device Authorization Grant).
 *
 * Browser-based `mage login` runs against WorkOS AuthKit as a PUBLIC client:
 * no client secret, no redirect URI — just the deployment's public client id.
 * The CLI asks WorkOS for a device code, shows the user a short code + URL,
 * and polls the token endpoint until the user approves in the browser.
 *
 * Refresh tokens are SINGLE-USE: every refresh returns a replacement and kills
 * the one just spent. Callers must persist the new pair immediately (see
 * `session.ts`, which owns that lifecycle).
 */
import { CliError } from './context'

const WORKOS_BASE = 'https://api.workos.com'

export interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  /** Seconds until the device code dies. */
  expires_in: number
  /** Seconds to wait between polls. */
  interval: number
}

export interface TokenGrant {
  access_token: string
  refresh_token: string
  user?: { email?: string }
}

/** A structured error from the WorkOS token endpoint (`error` field). */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail || code)
    this.name = 'OAuthError'
  }
}

interface Hooks {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Called before each token poll — lets the caller show a heartbeat. */
  onPoll?: () => void
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function postForm<T>(path: string, form: Record<string, string>): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${WORKOS_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    })
  } catch (err) {
    // Name the host: "the sign-in service is unreachable" is a different fix
    // than "the Mage API is down".
    throw new CliError(`Could not reach the sign-in service at ${WORKOS_BASE} (${(err as Error).message})`)
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const code = typeof data.error === 'string' ? data.error : `http_${res.status}`
    const detail = typeof data.error_description === 'string' ? data.error_description : undefined
    throw new OAuthError(code, detail)
  }
  return data as T
}

/** Ask WorkOS for a device code the user can approve in their browser. */
export function startDeviceAuthorization(clientId: string): Promise<DeviceAuthorization> {
  return postForm<DeviceAuthorization>('/user_management/authorize/device', { client_id: clientId })
}

/**
 * Poll the token endpoint until the browser approval lands. Respects the
 * server-directed `interval`, backs off on `slow_down`, and enforces the
 * device code's own deadline so a wedged approval can't spin forever.
 */
export async function pollForTokens(
  clientId: string,
  device: DeviceAuthorization,
  hooks: Hooks = {},
): Promise<TokenGrant> {
  const sleep = hooks.sleep ?? realSleep
  const now = hooks.now ?? Date.now
  const deadline = now() + device.expires_in * 1000
  let intervalMs = Math.max(device.interval, 1) * 1000

  while (true) {
    if (now() >= deadline) {
      throw new CliError('The login code expired before it was approved. Run `mage login` to try again.')
    }
    await sleep(intervalMs)
    hooks.onPoll?.()
    try {
      return await postForm<TokenGrant>('/user_management/authenticate', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: clientId,
      })
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err
      if (err.code === 'authorization_pending') continue
      if (err.code === 'slow_down') {
        intervalMs += 5000
        continue
      }
      if (err.code === 'access_denied') {
        throw new CliError('Login was denied in the browser.')
      }
      if (err.code === 'expired_token') {
        throw new CliError('The login code expired before it was approved. Run `mage login` to try again.')
      }
      throw new CliError(`Sign-in failed (${err.code}${err.message !== err.code ? `: ${err.message}` : ''}).`)
    }
  }
}

/**
 * Spend a refresh token for a fresh access + refresh pair. Throws
 * `OAuthError('invalid_grant')` when the token is dead (revoked, expired
 * session, or already spent) — the caller decides whether to fall back to a
 * fresh device flow.
 */
export function refreshTokenGrant(clientId: string, refreshToken: string): Promise<TokenGrant> {
  return postForm<TokenGrant>('/user_management/authenticate', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })
}

/**
 * A JWT's `exp` (epoch seconds) WITHOUT verifying the signature — this is an
 * expiry pre-check for tokens we already trust, not validation (the API
 * verifies every token server-side). `null` on anything malformed, which
 * callers treat as "refresh now".
 */
export function decodeJwtExp(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof claims.exp === 'number' ? claims.exp : null
  } catch {
    return null
  }
}
