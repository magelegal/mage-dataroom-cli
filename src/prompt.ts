/** Interactive prompts (confirmation + masked secret entry). */
import readline from 'node:readline'
import { CliError } from './context'

/**
 * Block a destructive action until confirmed. With `--yes`, proceed silently.
 * In a non-interactive shell (no TTY) we refuse rather than hang or guess — the
 * caller must pass `--yes`, which is the headless/agent path.
 */
export async function confirm(message: string, assumeYes: boolean | undefined): Promise<void> {
  if (assumeYes) return
  if (!process.stdin.isTTY) {
    throw new CliError(`${message}\nRefusing in a non-interactive shell. Re-run with --yes to confirm.`)
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((resolve) => rl.question(`${message} [y/N] `, resolve))
  rl.close()
  if (!/^y(es)?$/i.test(answer.trim())) throw new CliError('Aborted.')
}

/** Ask for a short free-text value; re-asks until non-empty. TTY only. */
export async function promptText(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError('Cannot prompt in a non-interactive shell.')
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    while (true) {
      const answer = (await new Promise<string>((resolve) => rl.question(`${question}: `, resolve))).trim()
      if (answer) return answer
      process.stderr.write('Please enter a value.\n')
    }
  } finally {
    rl.close()
  }
}

/** Pick one of `count` numbered options; re-asks until the answer is valid. */
export async function promptSelect(question: string, count: number): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new CliError('Cannot prompt in a non-interactive shell. Pass --room <id or name>.')
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => rl.question(`${question} [1-${count}]: `, resolve))
      const n = Number(answer.trim())
      if (Number.isInteger(n) && n >= 1 && n <= count) return n
      process.stderr.write(`Enter a number between 1 and ${count}.\n`)
    }
  } finally {
    rl.close()
  }
}

/** Read a secret with the terminal echo muted, so a pasted key never renders. */
export async function promptHidden(query: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError('Provide the API key as an argument or via MAGE_API_KEY.')
  }
  return new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    const mutable = rl as unknown as {
      _writeToOutput?: (s: string) => void
      output: NodeJS.WritableStream
    }
    let muted = false
    // The query itself prints; keystrokes after it are swallowed.
    mutable._writeToOutput = (s: string): void => {
      if (!muted) mutable.output.write(s)
    }
    rl.question(query, (answer) => {
      mutable.output.write('\n')
      rl.close()
      resolve(answer)
    })
    muted = true
  })
}
