/**
 * Resolve a ready-to-use client + room id for the commands that act on a room.
 *
 * A room-scoped key does not carry its room id, so when none is configured we
 * ask the API which room the key belongs to (`/cli/context`). That makes
 * `MAGE_API_KEY` alone sufficient for a headless agent — no room id to wire up.
 */
import { MageClient } from './client'
import { resolveSettings } from './config'

/** A user-facing error: printed as a clean message, no stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

export interface RunContext {
  client: MageClient
  roomId: string
  baseUrl: string
}

export async function buildContext(opts: { apiUrl?: string }): Promise<RunContext> {
  const settings = resolveSettings(opts)
  if (!settings.apiKey) {
    // A browser login with zero rooms leaves a session but no key yet.
    throw new CliError(
      settings.oauth
        ? 'No room is bound yet. Run `mage use <room>` (see `mage rooms`).'
        : 'Not logged in. Run `mage login`, or set MAGE_API_KEY for headless use.',
    )
  }
  const client = new MageClient(settings.baseUrl, settings.apiKey)
  let roomId = settings.roomId
  if (!roomId) {
    // Key-only auth (e.g. an agent with just MAGE_API_KEY): discover the room.
    roomId = (await client.getContext()).roomId
  }
  return { client, roomId, baseUrl: settings.baseUrl }
}
