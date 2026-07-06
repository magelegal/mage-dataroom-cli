import { roomLines } from '../../binding'
import { MageClient } from '../../client'
import { resolveSettings } from '../../config'
import * as output from '../../output'
import { getSession } from '../../session'

/**
 * List every room in the signed-in user's organization, marking the one this
 * machine is bound to. Runs as the user (browser session), not the room key —
 * a key is deliberately blind to every room but its own. Signed out? The
 * session helper walks you through a browser re-approve on the spot.
 */
export async function roomsCommand(opts: { apiUrl?: string; json?: boolean }): Promise<void> {
  const settings = resolveSettings(opts)
  const session = await getSession(settings)
  const client = new MageClient(settings.baseUrl, { kind: 'bearer', token: session.accessToken })
  const rooms = await client.listRooms()

  if (opts.json) {
    output.printJson(rooms)
    return
  }
  if (rooms.length === 0) {
    output.info('Your organization has no data rooms yet. Create one in the Mage web app.')
    return
  }
  output.out(roomLines(rooms, settings.roomId))
  if (settings.roomId) output.info('\n* = the room this machine is bound to. Switch with `mage use <room>`.')
}
