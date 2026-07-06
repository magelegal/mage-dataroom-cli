import { hostname } from 'node:os'
import { bindRoom, chooseRoom, roomSnapshot } from '../../binding'
import type { LiteRoom } from '../../client'
import { ApiError, MageClient } from '../../client'
import { resolveSettings, updateConfig } from '../../config'
import { CliError } from '../../context'
import * as output from '../../output'
import { promptHidden, promptText } from '../../prompt'
import { loginSession } from '../../session'

/**
 * Sign this machine into a room.
 *
 * Two paths:
 *
 *  - **Browser (primary)** — bare `mage login` runs the WorkOS device flow:
 *    approve in the browser, pick a room, and the CLI mints its own room key
 *    (named `CLI — <hostname>`, visible under Settings → API keys). The key is
 *    what data commands use from then on — it never expires, so the login
 *    outlives any browser session.
 *
 *  - **Key (headless / member)** — `mage login <key>` (or `MAGE_API_KEY`, or
 *    `--with-key` to paste without shell history) stores a hand-minted key and
 *    resolves its room via `/cli/context`, exactly as before.
 */
export async function loginCommand(
  keyArg: string | undefined,
  opts: { apiUrl?: string; json?: boolean; room?: string; withKey?: boolean; noBrowser?: boolean },
): Promise<void> {
  const settings = resolveSettings(opts)

  let key = (keyArg ?? process.env.MAGE_API_KEY ?? '').trim()
  if (!key && opts.withKey) key = (await promptHidden('Paste your data room API key: ')).trim()
  if (key) return keyLogin(key, settings.baseUrl, opts)
  return browserLogin(settings, opts)
}

/** The pre-OAuth path, unchanged in behavior: store a hand-minted key. */
async function keyLogin(
  key: string,
  baseUrl: string,
  opts: { json?: boolean },
): Promise<void> {
  const client = new MageClient(baseUrl, key)
  let ctx
  try {
    ctx = await client.getContext()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw new CliError(
        'That API key was not accepted. Mint one in your data room under Settings → API keys.',
      )
    }
    throw err
  }

  updateConfig((cfg) => {
    cfg.apiKey = key
    cfg.roomId = ctx.roomId
    cfg.roomName = ctx.roomName
    cfg.baseUrl = baseUrl
    // A hand-minted key is the user's to manage — we don't know its id and
    // must never auto-revoke it; and any cached browser session belonged to
    // the previous login.
    delete cfg.apiKeyId
    delete cfg.oauth
  })

  if (opts.json) {
    output.printJson({ method: 'apiKey', roomId: ctx.roomId, roomName: ctx.roomName, keyName: ctx.keyName })
    return
  }
  output.success(`Logged in to "${ctx.roomName}".`)
  output.info(`  Key "${ctx.keyName}": uploads will land in this room.`)
}

/** The primary path: device flow → pick (or create) a room → mint the CLI's own key. */
async function browserLogin(
  settings: ReturnType<typeof resolveSettings>,
  opts: { json?: boolean; room?: string; noBrowser?: boolean },
): Promise<void> {
  const session = await loginSession(settings, { noBrowser: opts.noBrowser })
  const who = session.email ? ` as ${session.email}` : ''
  output.success(`Logged in${who}.`)

  const bearer = new MageClient(settings.baseUrl, { kind: 'bearer', token: session.accessToken })
  // First-login hook: provisions the user's org before we list its rooms.
  await bearer.getMe()
  const rooms = await bearer.listRooms()

  let room: LiteRoom
  if (rooms.length === 0) {
    // A brand-new account. Interactively, finish the job right here — name a
    // room and keep going; headless callers get the pointer instead.
    if (opts.json || !process.stdin.isTTY) {
      updateConfig((cfg) => (cfg.baseUrl = settings.baseUrl))
      if (opts.json) {
        output.printJson({ method: 'oauth', email: session.email ?? null, roomId: null, rooms: 0 })
        return
      }
      output.warn(
        'Your organization has no data rooms yet. Create one in the Mage web app, then run `mage use <room>`.',
      )
      return
    }
    output.info('Your organization has no data rooms yet.')
    const name = await promptText('Name your first data room')
    room = await bearer.createRoom(name)
    output.success(`Created "${room.name}".`)
  } else {
    room = await chooseRoom(rooms, opts.room)
  }

  const minted = await bindRoom(bearer, room, settings.baseUrl)
  // Proof-of-life through the data plane: the snapshot rides the minted key,
  // so a printed success means the credential the user will actually use works.
  const snapshot = roomSnapshot(await new MageClient(settings.baseUrl, minted.key).listDocuments(room.id))

  if (opts.json) {
    output.printJson({
      method: 'oauth',
      email: session.email ?? null,
      roomId: room.id,
      roomName: room.name,
      keyName: minted.name,
      rooms: rooms.length,
    })
    return
  }
  output.success(`Bound to "${room.name}" — ${snapshot}.`)
  output.info(
    `  The CLI minted its own key ("CLI — ${hostname()}") — it works until revoked in Settings → API keys.`,
  )
  if (rooms.length > 1) output.info('  Switch rooms any time with `mage use <room>`.')
  output.info('')
  output.info('  Next:  mage upload ./diligence     mirror a folder into your room')
  output.info('         mage ls                     see what’s there')
}
