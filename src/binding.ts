/**
 * Binding the CLI to a room: choose one, mint the CLI's own key for it, retire
 * the key it replaces. Shared by `login` (first bind) and `use` (re-bind).
 *
 * The mint is what makes browser login LONG-LASTING: the WorkOS session is a
 * short-lived handshake, but the key it mints never expires — it works until
 * someone revokes it (Settings → API keys, where it stays visible with
 * last-used stamps).
 */
import { hostname } from 'node:os'
import type { LiteRoom, MageClient, MintedApiKey } from './client'
import { ApiError } from './client'
import { loadConfig, updateConfig } from './config'
import { CliError } from './context'
import * as output from './output'
import { promptSelect } from './prompt'

/**
 * Resolve which room to bind: an explicit selector (exact id, else
 * case-insensitive exact name), the only room, or an interactive pick.
 */
export async function chooseRoom(rooms: LiteRoom[], selector: string | undefined): Promise<LiteRoom> {
  if (rooms.length === 0) {
    throw new CliError('Your organization has no data rooms yet. Create one in the Mage web app, then run `mage use <room>`.')
  }

  if (selector) {
    const wanted = selector.trim()
    const byId = rooms.find((r) => r.id === wanted)
    if (byId) return byId
    const byName = rooms.filter((r) => r.name.toLowerCase() === wanted.toLowerCase())
    if (byName.length === 1) return byName[0]!
    if (byName.length > 1) {
      throw new CliError(`Several rooms are named "${wanted}" — pick one by id:\n${roomLines(rooms, undefined)}`)
    }
    throw new CliError(`No room matches "${wanted}". Your rooms:\n${roomLines(rooms, undefined)}`)
  }

  if (rooms.length === 1) return rooms[0]!

  process.stderr.write(`Your organization has ${rooms.length} rooms:\n`)
  rooms.forEach((r, i) => {
    process.stderr.write(`  ${i + 1}. ${r.name}  ${output.colors.dim(`(${docCount(r)})`)}\n`)
  })
  const picked = await promptSelect('Select a room', rooms.length)
  return rooms[picked - 1]!
}

/**
 * Mint the CLI's key for `room`, retire the CLI-minted key it replaces
 * (best-effort — only keys we minted carry an id), and persist the binding.
 */
export async function bindRoom(bearer: MageClient, room: LiteRoom, baseUrl: string): Promise<MintedApiKey> {
  const previous = loadConfig()

  let minted: MintedApiKey
  try {
    minted = await bearer.mintApiKey(room.id, `CLI — ${hostname()}`)
  } catch (err) {
    // The admin gate answers 404 to non-admins (deliberately indistinguishable
    // from a missing room). For someone who just picked the room off the list,
    // "you are not an owner/admin" is the overwhelmingly likely meaning.
    if (err instanceof ApiError && err.status === 404) {
      throw new CliError(
        `Browser login needs an owner or admin of "${room.name}" — your account is a member.\n` +
          `Send your admin this link to mint you a key: ${webAppUrl(baseUrl)}/settings/api-keys\n` +
          'Then run `mage login <key>`.',
      )
    }
    throw err
  }

  if (previous.apiKey && previous.apiKeyId && previous.roomId) {
    try {
      await bearer.revokeApiKey(previous.roomId, previous.apiKeyId)
    } catch {
      // Best-effort hygiene; a key we can no longer revoke (role changed, room
      // gone) is still visible in that room's Settings → API keys.
    }
  }

  updateConfig((cfg) => {
    cfg.apiKey = minted.key
    cfg.apiKeyId = minted.id
    cfg.roomId = room.id
    cfg.roomName = room.name
    cfg.baseUrl = baseUrl
  })
  return minted
}

export function docCount(room: LiteRoom): string {
  return `${room.documentCount} document${room.documentCount === 1 ? '' : 's'}`
}

/**
 * The web app that fronts this API host: the lite deployments pair
 * `api-dataroom.X` with `dataroom.X` (prod, staging, and previews alike).
 * Anything unrecognizable falls back to production.
 */
export function webAppUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).host
    if (host.startsWith('api-dataroom.')) return `https://${host.replace(/^api-/, '')}`
  } catch {
    // Fall through to the production default.
  }
  return 'https://dataroom.magelegal.com'
}

/** "24 documents in 6 folders" / "empty and ready" — the post-bind proof-of-life. */
export function roomSnapshot(docs: Array<{ folderPath: string | null }>): string {
  if (docs.length === 0) return 'empty and ready'
  const folders = new Set(docs.map((d) => d.folderPath ?? 'Unsorted'))
  const docPart = `${docs.length} document${docs.length === 1 ? '' : 's'}`
  return `${docPart} in ${folders.size} folder${folders.size === 1 ? '' : 's'}`
}

/** One line per room, for lists inside error messages and `mage rooms`. */
export function roomLines(rooms: LiteRoom[], boundRoomId: string | undefined): string {
  return rooms
    .map((r) => {
      const marker = r.id === boundRoomId ? '*' : ' '
      const nda = r.teamNdaRequired && !r.teamNdaAccepted ? '  (team NDA pending)' : ''
      return ` ${marker} ${r.name}  ${output.colors.dim(`${docCount(r)} · id ${r.id}`)}${nda}`
    })
    .join('\n')
}
