import { beforeEach, expect, test } from 'bun:test'
import type { MageConfig, ResolvedSettings, StoredOAuth } from '../config'
import { getSession, loginSession } from '../session'
import type { TokenGrant } from '../workos'
import { OAuthError } from '../workos'

const SETTINGS: ResolvedSettings = { baseUrl: 'https://api.example.com' }

/** A JWT whose only meaningful claim is `exp` (epoch seconds). */
function jwtWithExp(exp: number): string {
  return `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`
}

const GRANT: TokenGrant = {
  access_token: 'at-new',
  refresh_token: 'rt-new',
  user: { email: 'founder@example.com' },
}

let persisted: StoredOAuth[]
let config: MageConfig

beforeEach(() => {
  persisted = []
  config = {}
  delete process.env.MAGE_OAUTH_CLIENT_ID
})

const baseHooks = {
  load: () => config,
  persist: (o: StoredOAuth) => {
    persisted.push(o)
    config = { ...config, oauth: o }
  },
  now: () => 1_000_000_000_000, // epoch ms; exp checks compare against this
}

test('a fresh cached session is returned without any network call', async () => {
  const freshExp = 1_000_000_000 + 3600 // an hour past `now`
  config.oauth = { accessToken: jwtWithExp(freshExp), refreshToken: 'rt1', clientId: 'c1' }

  const session = await getSession(SETTINGS, {
    ...baseHooks,
    refresh: () => {
      throw new Error('must not refresh a fresh token')
    },
    deviceFlow: () => {
      throw new Error('must not run the device flow')
    },
  })

  expect(session.refreshToken).toBe('rt1')
  expect(persisted).toEqual([])
})

test('a stale session refreshes and PERSISTS the rotated refresh token', async () => {
  const staleExp = 1_000_000_000 + 30 // inside the 60s buffer
  config.oauth = { accessToken: jwtWithExp(staleExp), refreshToken: 'rt-old', clientId: 'c1' }
  const refreshCalls: string[] = []

  const session = await getSession(SETTINGS, {
    ...baseHooks,
    refresh: async (_clientId, refreshToken) => {
      refreshCalls.push(refreshToken)
      return GRANT
    },
  })

  expect(refreshCalls).toEqual(['rt-old'])
  expect(session.accessToken).toBe('at-new')
  // The single-use token was rotated — the replacement must hit disk.
  expect(persisted).toHaveLength(1)
  expect(persisted[0]!.refreshToken).toBe('rt-new')
  expect(persisted[0]!.clientId).toBe('c1')
})

test('a garbled access token is treated as stale, not a crash', async () => {
  config.oauth = { accessToken: 'not-a-jwt', refreshToken: 'rt-old', clientId: 'c1' }

  const session = await getSession(SETTINGS, { ...baseHooks, refresh: async () => GRANT })

  expect(session.refreshToken).toBe('rt-new')
})

test('a dead refresh token falls back to the interactive device flow', async () => {
  config.oauth = { accessToken: jwtWithExp(1), refreshToken: 'rt-dead', clientId: 'c1' }
  let flowRuns = 0

  const session = await getSession(SETTINGS, {
    ...baseHooks,
    isInteractive: true,
    refresh: async () => {
      throw new OAuthError('invalid_grant')
    },
    fetchConfig: async () => ({ clientId: 'c-discovered' }),
    deviceFlow: async (clientId) => {
      flowRuns += 1
      expect(clientId).toBe('c-discovered')
      return GRANT
    },
  })

  expect(flowRuns).toBe(1)
  expect(session.refreshToken).toBe('rt-new')
  expect(persisted).toHaveLength(1)
})

test('a dead session without a TTY says to run mage login instead of hanging', async () => {
  config.oauth = { accessToken: jwtWithExp(1), refreshToken: 'rt-dead', clientId: 'c1' }

  expect(
    getSession(SETTINGS, {
      ...baseHooks,
      isInteractive: false,
      refresh: async () => {
        throw new OAuthError('invalid_grant')
      },
    }),
  ).rejects.toThrow('Run `mage login`')
})

test('network trouble during refresh surfaces as itself, not a re-login', async () => {
  config.oauth = { accessToken: jwtWithExp(1), refreshToken: 'rt1', clientId: 'c1' }

  expect(
    getSession(SETTINGS, {
      ...baseHooks,
      isInteractive: true,
      refresh: async () => {
        throw new Error('socket hang up')
      },
    }),
  ).rejects.toThrow('socket hang up')
})

test('a 404 from auth-config discovery explains the deployment is behind, not "Not Found"', async () => {
  const { ApiError } = await import('../client')
  const { resolveClientId } = await import('../session')

  expect(
    resolveClientId(SETTINGS, {
      fetchConfig: async () => {
        throw new ApiError(404, 'Not Found')
      },
    }),
  ).rejects.toThrow('Browser login isn’t enabled on this deployment yet')
})

test('loginSession always runs the flow, honors MAGE_OAUTH_CLIENT_ID, and persists', async () => {
  process.env.MAGE_OAUTH_CLIENT_ID = 'c-env'
  config.oauth = { accessToken: jwtWithExp(999_999_999_999), refreshToken: 'rt-alive', clientId: 'c1' }
  const flowClients: string[] = []

  const session = await loginSession(SETTINGS, {
    ...baseHooks,
    deviceFlow: async (clientId) => {
      flowClients.push(clientId)
      return GRANT
    },
    fetchConfig: () => {
      throw new Error('env override must skip discovery')
    },
  })

  expect(flowClients).toEqual(['c-env']) // ran even though a live session was cached
  expect(session.email).toBe('founder@example.com')
  expect(persisted).toHaveLength(1)
})
