#!/usr/bin/env node
/**
 * `mage` — one binary, product-scoped command groups.
 *
 * Mage is two products: the data room (dataroom.magelegal.com) and the
 * diligence platform. Everything this CLI does today is the DATA ROOM product
 * — its commands live in `src/commands/dataroom/` and render under the
 * "Data room:" help group. When diligence commands exist they get their own
 * `src/commands/diligence/` + help group; nothing data-room-specific may leak
 * into the shared seams (client/config/output/prompt).
 */
import { Command } from 'commander'
import { ApiError } from './client'
import { downloadCommand } from './commands/dataroom/download'
import { lsCommand } from './commands/dataroom/ls'
import { loginCommand } from './commands/dataroom/login'
import { logoutCommand } from './commands/dataroom/logout'
import { mkdirCommand } from './commands/dataroom/mkdir'
import { readinessAttachCommand, readinessCommand } from './commands/dataroom/readiness'
import { rmCommand } from './commands/dataroom/rm'
import { roomsCommand } from './commands/dataroom/rooms'
import { uploadCommand } from './commands/dataroom/upload'
import { useCommand } from './commands/dataroom/use'
import { CliError } from './context'
import * as output from './output'

// Replaced at build time by tsup's `define` (see tsup.config.ts).
declare const __VERSION__: string

/** Run a command body, turning known failures into clean one-line messages. */
async function run(fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    output.printError(messageFor(err))
    process.exitCode = 1
  }
}

function messageFor(err: unknown): string {
  if (err instanceof CliError) return err.message
  if (err instanceof ApiError) {
    if (err.status === 0) return err.detail
    if (err.status === 401) {
      return `Unauthorized: ${err.detail}. The key may have been revoked — run \`mage login\` again, or check MAGE_API_KEY.`
    }
    if (err.status === 404) {
      return `Not found: ${err.detail}. The key may be for a different room, or the item no longer exists.`
    }
    if (err.status === 503) {
      // Key validation rides on an upstream service; a brief outage must never
      // read as "your key is dead".
      return 'Mage’s key service is briefly unavailable — your key is fine, try again in a minute.'
    }
    return `API error ${err.status}: ${err.detail}`
  }
  return err instanceof Error ? err.message : String(err)
}

const program = new Command()

program
  .name('mage')
  .description('Upload and organize a Mage data room, for humans and AI agents.')
  .version(__VERSION__, '-v, --version', 'Print the CLI version')
  .option('--json', 'Machine-readable JSON output', false)
  .option('--api-url <url>', 'Override the Mage API base URL')
  .addHelpText(
    'before',
    `Quickstart:
  mage login                   sign in via your browser
  mage upload ./diligence      mirror a folder into your room
  mage ls                      see what's there
  mage readiness               see what investors still expect
`,
  )

// Set output mode before any command body runs.
program.hook('preAction', (_program, action) => {
  output.setJsonMode(Boolean(action.optsWithGlobals().json))
})

program
  .command('version')
  .helpGroup('General:')
  .description('Print the CLI version')
  .action(() => output.out(__VERSION__))

// The implicit `help` command, re-declared only so it joins the General group
// instead of stranding a third heading.
program.addHelpCommand(
  new Command('help').argument('[command]').helpGroup('General:').description('Display help for a command'),
)

program
  .command('login')
  .helpGroup('Data room:')
  .argument('[key]', 'API key — skips the browser flow (also read from MAGE_API_KEY)')
  .option('--room <room>', 'Bind to this room (id or name) without prompting')
  .option('--with-key', 'Paste an API key at a hidden prompt (keeps it out of shell history)')
  .option('--no-browser', 'Print the approval URL instead of opening a browser')
  .description('Sign in via your browser (or store an API key) and bind this machine to a room')
  .action((key, _opts, cmd) => {
    const opts = cmd.optsWithGlobals()
    // commander models `--no-browser` as `browser: false`.
    return run(() => loginCommand(key, { ...opts, noBrowser: opts.browser === false }))
  })

program
  .command('logout')
  .helpGroup('Data room:')
  .description('Sign out: revoke the CLI’s key where possible and clear this machine')
  .action((_opts, cmd) => run(() => logoutCommand(cmd.optsWithGlobals())))

program
  .command('rooms')
  .helpGroup('Data room:')
  .description("List your organization's data rooms (browser login)")
  .action((_opts, cmd) => run(() => roomsCommand(cmd.optsWithGlobals())))

program
  .command('use')
  .helpGroup('Data room:')
  .argument('<room>', 'Room id or name to bind this machine to')
  .description('Switch which room this machine is bound to (browser login)')
  .action((room, _opts, cmd) => run(() => useCommand(room, cmd.optsWithGlobals())))

program
  .command('upload')
  .helpGroup('Data room:')
  .argument('<paths...>', 'Files or directories to upload')
  .option('--to <folder>', 'Destination folder in the room (created as needed)')
  .option('--for-item <itemId>', 'Attach the uploads to this readiness checklist item (see `mage readiness`)')
  .description('Upload files or whole folders, mirroring their structure')
  .action((paths, _opts, cmd) => run(() => uploadCommand(paths, cmd.optsWithGlobals())))

const readiness = program
  .command('readiness')
  .helpGroup('Data room:')
  .description("Show the room's readiness checklist: what's present, partial, and missing")
  .action((_opts, cmd) => run(() => readinessCommand(cmd.optsWithGlobals())))

readiness
  .command('attach')
  .argument('<itemId>', 'Checklist item id (from `mage readiness`)')
  .argument('<documents...>', 'Documents to attach — by id, name, or folder/name')
  .description('Attach already-uploaded documents to a checklist item')
  .action((itemId, documents, _opts, cmd) =>
    run(() => readinessAttachCommand(itemId, documents, cmd.optsWithGlobals())),
  )

program
  .command('ls')
  .helpGroup('Data room:')
  .argument('[folder]', 'Limit the listing to this folder and its subfolders')
  .description('List the documents in the room, grouped by folder')
  .action((folder, _opts, cmd) => run(() => lsCommand(folder, cmd.optsWithGlobals())))

program
  .command('download')
  .helpGroup('Data room:')
  .argument('[target]', "A folder (recursive), a document (id, name, or folder/name), or '.'/nothing for the whole room")
  .argument('[dest]', 'Local destination directory (defaults to ./<room-or-folder-name>)')
  .description('Download documents, mirroring the room folder structure locally')
  .action((target, dest, _opts, cmd) => run(() => downloadCommand(target, dest, cmd.optsWithGlobals())))

program
  .command('mkdir')
  .helpGroup('Data room:')
  .argument('<folder>', 'Folder path to create (e.g. 01-Corporate/Charters)')
  .description('Create an empty folder in the room')
  .action((folder, _opts, cmd) => run(() => mkdirCommand(folder, cmd.optsWithGlobals())))

program
  .command('rm')
  .helpGroup('Data room:')
  .argument('<target>', 'Document name, folder/name, or id — or a folder with --folder')
  .option('-r, --folder', 'Delete a folder (its documents move to Unsorted)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .description('Delete a document, or a folder with --folder')
  .action((target, _opts, cmd) => run(() => rmCommand(target, cmd.optsWithGlobals())))

program.parseAsync(process.argv).catch((err) => {
  output.printError(messageFor(err))
  process.exitCode = 1
})
