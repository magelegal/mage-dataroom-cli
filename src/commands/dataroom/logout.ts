import { MageClient } from '../../client'
import { clearAuth, loadConfig, resolveSettings } from '../../config'
import * as output from '../../output'
import { getSession } from '../../session'

/**
 * Sign this machine out. A key the CLI minted for itself is revoked
 * server-side too (best-effort, using the cached browser session — never by
 * launching a new one); a hand-minted key is the user's to manage, so it is
 * only removed locally.
 */
export async function logoutCommand(opts: { apiUrl?: string; json?: boolean }): Promise<void> {
  const cfg = loadConfig()
  const hadCredentials = Boolean(cfg.apiKey || cfg.oauth)

  let revoked = false
  if (cfg.apiKey && cfg.apiKeyId && cfg.roomId && cfg.oauth) {
    try {
      const settings = resolveSettings(opts)
      const session = await getSession(settings, { isInteractive: false })
      const client = new MageClient(settings.baseUrl, { kind: 'bearer', token: session.accessToken })
      await client.revokeApiKey(cfg.roomId, cfg.apiKeyId)
      revoked = true
    } catch {
      // Best-effort: a dead session or lost role must never block a logout.
    }
  }
  clearAuth()

  if (opts.json) {
    output.printJson({ loggedOut: true, hadCredentials, keyRevoked: revoked })
    return
  }
  if (!hadCredentials) {
    output.success('No stored credentials to remove.')
    return
  }
  output.success(
    revoked
      ? 'Logged out — the CLI’s key was revoked and removed from this machine.'
      : 'Logged out — the credentials were removed from this machine.',
  )
  if (!revoked && cfg.apiKey) {
    output.info('To fully revoke a key, delete it in your data room under Settings → API keys.')
  }
}
