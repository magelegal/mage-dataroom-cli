/**
 * Output routing.
 *
 * Data (the thing you'd pipe — `ls` rows, `--json` payloads) goes to stdout.
 * Human chatter (progress, confirmations, success ticks) goes to stderr, so a
 * pipe stays clean. `--json` mode silences the chatter entirely.
 */
import pc from 'picocolors'

let jsonMode = false

export function setJsonMode(on: boolean): void {
  jsonMode = on
}

/** stderr chatter — suppressed in --json mode. */
export function info(msg: string): void {
  if (!jsonMode) process.stderr.write(msg + '\n')
}

export function success(msg: string): void {
  if (!jsonMode) process.stderr.write(`${pc.green('✓')} ${msg}\n`)
}

export function warn(msg: string): void {
  if (!jsonMode) process.stderr.write(`${pc.yellow('!')} ${msg}\n`)
}

export function failure(msg: string): void {
  if (!jsonMode) process.stderr.write(`${pc.red('✗')} ${msg}\n`)
}

/** Errors always print (even in --json mode), always to stderr. */
export function printError(msg: string): void {
  process.stderr.write(`${pc.red('✗')} ${msg}\n`)
}

/** stdout data. */
export function out(msg: string): void {
  process.stdout.write(msg + '\n')
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

export const colors = pc
