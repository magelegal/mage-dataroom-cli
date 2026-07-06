import { afterEach, beforeEach, expect, test } from 'bun:test'
import { CliError } from '../context'
import type { DeviceAuthorization } from '../workos'
import { OAuthError, decodeJwtExp, pollForTokens, refreshTokenGrant, startDeviceAuthorization } from '../workos'

interface Call {
  url: string
  body: URLSearchParams
}

let calls: Call[]
/** Queue of responses; the last entry repeats. */
let responses: Array<() => Response>
const realFetch = globalThis.fetch

function oauthError(code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
}

function grant(): Response {
  return new Response(
    JSON.stringify({ access_token: 'at1', refresh_token: 'rt1', user: { email: 'founder@example.com' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

beforeEach(() => {
  calls = []
  responses = []
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const body = new URLSearchParams(String((init as { body?: unknown }).body ?? ''))
    calls.push({ url: String(url), body })
    const next = responses.length > 1 ? responses.shift()! : responses[0]!
    return next()
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const DEVICE: DeviceAuthorization = {
  device_code: 'dev_1',
  user_code: 'BCDF-GHJK',
  verification_uri: 'https://auth.example.com/device',
  verification_uri_complete: 'https://auth.example.com/device?user_code=BCDF-GHJK',
  expires_in: 300,
  interval: 5,
}

/** Instant sleeps that record the requested delays; a fake clock advanced by them. */
function fakeTime() {
  const sleeps: number[] = []
  let clock = 0
  return {
    sleeps,
    hooks: {
      sleep: async (ms: number) => {
        sleeps.push(ms)
        clock += ms
      },
      now: () => clock,
    },
  }
}

test('startDeviceAuthorization posts the client id form-encoded', async () => {
  responses = [
    () =>
      new Response(JSON.stringify(DEVICE), { status: 200, headers: { 'content-type': 'application/json' } }),
  ]
  const device = await startDeviceAuthorization('client_x')

  expect(device.user_code).toBe('BCDF-GHJK')
  expect(calls[0]!.url).toBe('https://api.workos.com/user_management/authorize/device')
  expect(calls[0]!.body.get('client_id')).toBe('client_x')
})

test('pollForTokens keeps polling through authorization_pending, then returns the grant', async () => {
  responses = [() => oauthError('authorization_pending'), () => oauthError('authorization_pending'), grant]
  const time = fakeTime()

  const tokens = await pollForTokens('client_x', DEVICE, time.hooks)

  expect(tokens.access_token).toBe('at1')
  expect(time.sleeps).toEqual([5000, 5000, 5000]) // one sleep before every poll
  const poll = calls[0]!
  expect(poll.url).toBe('https://api.workos.com/user_management/authenticate')
  expect(poll.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
  expect(poll.body.get('device_code')).toBe('dev_1')
})

test('slow_down stretches the polling interval by 5s each time', async () => {
  responses = [() => oauthError('slow_down'), () => oauthError('slow_down'), grant]
  const time = fakeTime()

  await pollForTokens('client_x', DEVICE, time.hooks)

  expect(time.sleeps).toEqual([5000, 10000, 15000])
})

test('access_denied and the device-code deadline become clean CliErrors', async () => {
  responses = [() => oauthError('access_denied')]
  expect(pollForTokens('client_x', DEVICE, fakeTime().hooks)).rejects.toThrow('denied in the browser')

  responses = [() => oauthError('authorization_pending')]
  const short = { ...DEVICE, expires_in: 12 } // dies after two 5s polls
  expect(pollForTokens('client_x', short, fakeTime().hooks)).rejects.toThrow('expired before it was approved')
})

test('refreshTokenGrant spends the refresh token; invalid_grant surfaces as OAuthError', async () => {
  responses = [grant]
  const tokens = await refreshTokenGrant('client_x', 'rt_old')
  expect(tokens.refresh_token).toBe('rt1')
  expect(calls[0]!.body.get('grant_type')).toBe('refresh_token')
  expect(calls[0]!.body.get('refresh_token')).toBe('rt_old')

  responses = [() => oauthError('invalid_grant')]
  try {
    await refreshTokenGrant('client_x', 'rt_dead')
    throw new Error('expected a rejection')
  } catch (err) {
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('invalid_grant')
  }
})

test('a network failure names the sign-in host, not the Mage API', async () => {
  globalThis.fetch = (async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  }) as unknown as typeof fetch
  try {
    await startDeviceAuthorization('client_x')
    throw new Error('expected a rejection')
  } catch (err) {
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toContain('api.workos.com')
  }
})

test('decodeJwtExp reads exp from a real payload and returns null on garbage', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'user_1', exp: 1_900_000_000 })).toString('base64url')
  expect(decodeJwtExp(`header.${payload}.sig`)).toBe(1_900_000_000)
  expect(decodeJwtExp('not-a-jwt')).toBeNull()
  expect(decodeJwtExp('a.%%%.c')).toBeNull()
  const noExp = Buffer.from(JSON.stringify({ sub: 'user_1' })).toString('base64url')
  expect(decodeJwtExp(`h.${noExp}.s`)).toBeNull()
})
