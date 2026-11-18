/**
 * Where the approver passphrase comes from (T23). Never from a command-line
 * argument (it would show in the process list and shell history):
 *   1. --passphrase-stdin: the first line of standard input (the Console passes
 *      it this way to the `justrunme approve` child it starts);
 *   2. JUSTRUNME_APPROVER_PASSPHRASE: for scripted runs such as the evaluation
 *      (stated as automation wherever results are reported);
 *   3. a prompt on the terminal with no echo.
 * With none of these the command fails; it never guesses.
 */

import { createInterface } from 'node:readline'

function firstLine(stream) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stream })
    let done = false
    rl.once('line', (line) => {
      done = true
      rl.close()
      resolve(line)
    })
    rl.once('close', () => {
      if (!done) resolve('')
    })
  })
}

/** Prompt on stderr and read a line from the terminal without echoing it. */
function promptHidden(text) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    process.stderr.write(text)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const finish = (fn, arg) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stderr.write('\n')
      fn(arg)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(resolve, value)
        if (ch === '\u0003') return finish(reject, new Error('cancelled'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

/**
 * @param {{ fromStdin?: boolean, env?: NodeJS.ProcessEnv, prompt?: string }} [o]
 * @returns {Promise<string | null>} null when no source is available
 */
export async function readPassphrase({ fromStdin = false, env = process.env, prompt = 'Approver passphrase: ' } = {}) {
  if (fromStdin) return (await firstLine(process.stdin)).replace(/\r$/, '')
  if (typeof env.JUSTRUNME_APPROVER_PASSPHRASE === 'string' && env.JUSTRUNME_APPROVER_PASSPHRASE.length > 0) return env.JUSTRUNME_APPROVER_PASSPHRASE
  if (process.stdin.isTTY && process.stderr.isTTY) {
    try {
      return await promptHidden(prompt)
    } catch {
      return null
    }
  }
  return null
}
