import { bindRoom, chooseRoom, roomSnapshot } from '../../binding'
import { MageClient } from '../../client'
import { resolveSettings } from '../../config'
import * as output from '../../output'
import { getSession } from '../../session'

/**
 * Re-bind this machine to another of the org's rooms without a full re-login.
 * Uses the cached browser session to mint a fresh key for the target room (and
 * retire the one it replaces); if the session is gone, it's a quick browser
 * re-approve — never a hand-minted key.
 */
export async function useCommand(
  selector: string,
  opts: { apiUrl?: string; json?: boolean },
): Promise<void> {
  const settings = resolveSettings(opts)
  const session = await getSession(settings)
  const bearer = new MageClient(settings.baseUrl, { kind: 'bearer', token: session.accessToken })

  const rooms = await bearer.listRooms()
  const room = await chooseRoom(rooms, selector)
  if (room.id === settings.roomId) {
    if (opts.json) {
      output.printJson({ roomId: room.id, roomName: room.name, changed: false })
      return
    }
    output.info(`Already using "${room.name}".`)
    return
  }

  const minted = await bindRoom(bearer, room, settings.baseUrl)
  const snapshot = roomSnapshot(await new MageClient(settings.baseUrl, minted.key).listDocuments(room.id))

  if (opts.json) {
    output.printJson({ roomId: room.id, roomName: room.name, keyName: minted.name, changed: true })
    return
  }
  output.success(`Now using "${room.name}" — ${snapshot}.`)
}
