import { buildContext, CliError } from '../../context'
import * as output from '../../output'
import { joinFolder } from '../../walk'

/**
 * Create an empty folder. Uploading into a folder already creates it implicitly;
 * this is for laying out structure ahead of files. Idempotent server-side.
 */
export async function mkdirCommand(
  folder: string,
  opts: { apiUrl?: string; json?: boolean },
): Promise<void> {
  const path = joinFolder(folder)
  if (!path) throw new CliError('A folder name is required.')

  const { client, roomId } = await buildContext(opts)
  const res = await client.createFolder(roomId, path)

  if (opts.json) output.printJson(res)
  else output.success(`Created folder "${path}".`)
}
