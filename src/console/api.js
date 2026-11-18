/**
 * What the Console (T27) can do, and nothing more.
 *
 * Reads run the same CLI commands in this process (`main` from src/cli/index.js), so the
 * Console shows exactly what `justrunme history|verify|approvals|status|receipt|replay`
 * print: verified, redacted, with local paths replaced. Only those commands are allowed
 * (`readArgv`). Importing the CLI also loads the approve code into this process; the
 * allowlist is what keeps it unused here, and no passphrase is ever given to it.
 *
 * Writes (approve, deny, undo) start the CLI as a child process. The approver
 * passphrase goes to that child on stdin (`--passphrase-stdin`); it is never put in
 * argv or in the environment, and this process never opens the approver key. The
 * child's environment has JUSTRUNME_APPROVER_PASSPHRASE removed, so an approval made
 * here is recorded with passphrase_source "stdin", never "env".
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { main } from '../cli/index.js'

export const READ_COMMANDS = Object.freeze(['history', 'verify', 'approvals', 'status', 'receipt', 'replay'])
const CLI = fileURLToPath(new URL('../cli/index.js', import.meta.url))

const REQUEST_ID_RE = /^apr-[0-9a-f]{16}$/
const PLAN_ID_RE = /^plan-[0-9a-f]{12}$/
const CAPTURE_RE = /^cap-\d{14}-[0-9a-f]{6}$/
const SEQ_RE = /^\d{1,9}$/
const MAX_PASSPHRASE = 1024
const MAX_REASON = 300

export class InputError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * The argv of an in-process read. Anything but a read command throws, so the CLI code
 * this process has loaded (which includes approve) is reachable only through the child.
 * @param {string} command @param {string[]} args @param {string[]} scope
 */
export function readArgv(command, args, scope) {
  if (!READ_COMMANDS.includes(command)) throw new Error(`not a read command: ${command}`)
  return [command, ...args, ...scope]
}

/**
 * @param {{ repoDir: string, mission?: string, cliPath?: string, env?: NodeJS.ProcessEnv, runMain?: typeof main }} cfg
 */
export function createApi({ repoDir, mission, cliPath = CLI, env = process.env, runMain = main }) {
  const scope = ['--repo', repoDir, ...(mission ? ['--mission', mission] : [])]

  async function read(command, ...args) {
    const { output } = await runMain(readArgv(command, args, scope))
    return output
  }

  /** The child's environment: everything this process has, minus the passphrase. */
  function childEnv() {
    const e = { ...env }
    delete e.JUSTRUNME_APPROVER_PASSPHRASE
    return e
  }

  function runChild(args, { stdin = null, timeoutMs }) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cliPath, ...args, ...scope], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
      const out = []
      let size = 0
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.stdout.on('data', (b) => {
        size += b.length
        if (size <= 4 * 1024 * 1024) out.push(b)
      })
      child.stderr.resume()
      child.on('error', () => {})
      child.on('close', (code) => {
        clearTimeout(timer)
        let parsed = null
        try {
          parsed = JSON.parse(Buffer.concat(out).toString('utf8'))
        } catch {
          // reported below
        }
        resolve(parsed ?? { command: args[0], ok: false, exit_code: code ?? -1, error: { code: 'CHILD_FAILED', message: 'the CLI did not return a result' } })
      })
      child.stdin.on('error', () => {})
      child.stdin.end(stdin === null ? '' : stdin + '\n')
    })
  }

  return {
    /** Everything the Missions, Impact Diff and Recovery screens show. */
    async state() {
      const [story, verify, approvals, status] = await Promise.all([read('history'), read('verify'), read('approvals'), read('status')])
      return { story, verify, approvals, status }
    },

    async approval(id) {
      if (!REQUEST_ID_RE.test(id ?? '')) throw new InputError('REQUEST_INVALID', 'request id must look like apr-<16 hex>')
      return read('approvals', id)
    },

    async receipt(seq) {
      if (!SEQ_RE.test(seq ?? '')) throw new InputError('INVALID_SEQ', 'seq must be a number')
      return read('receipt', '--seq', seq)
    },

    async replay() {
      return read('replay')
    },

    async approve({ request_id, confirm, passphrase } = {}) {
      if (!REQUEST_ID_RE.test(request_id ?? '')) throw new InputError('REQUEST_INVALID', 'request id must look like apr-<16 hex>')
      if (!PLAN_ID_RE.test(confirm ?? '')) throw new InputError('CONFIRMATION_REQUIRED', 'type the plan id of the request (plan-<12 hex>) to confirm')
      if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE || /[\r\n]/.test(passphrase)) {
        throw new InputError('PASSPHRASE_REQUIRED', 'the approver passphrase is required (one line)')
      }
      const out = await runChild(['approve', request_id, '--confirm', confirm, '--passphrase-stdin'], { stdin: passphrase, timeoutMs: 180_000 })
      // The CLI never prints the passphrase; this keeps it out of the response even if that changed.
      const text = JSON.stringify(out)
      const needle = JSON.stringify(passphrase).slice(1, -1)
      return needle.length >= 4 && text.includes(needle) ? JSON.parse(text.split(needle).join('[redacted]')) : out
    },

    async deny({ request_id, reason } = {}) {
      if (!REQUEST_ID_RE.test(request_id ?? '')) throw new InputError('REQUEST_INVALID', 'request id must look like apr-<16 hex>')
      if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > MAX_REASON) throw new InputError('REASON_REQUIRED', `a reason of 3 to ${MAX_REASON} characters is required`)
      // `--reason=<text>`: a reason that starts with "-" stays the reason, never an option.
      return runChild(['deny', request_id, `--reason=${reason.trim()}`], { timeoutMs: 60_000 })
    },

    async undo({ capture_id, confirm } = {}) {
      if (!CAPTURE_RE.test(capture_id ?? '')) throw new InputError('INVALID_CAPTURE_ID', 'capture id must look like cap-<14 digits>-<6 hex>')
      if (confirm !== capture_id) throw new InputError('CONFIRMATION_REQUIRED', 'type the capture id again to confirm the undo')
      return runChild(['undo', capture_id], { timeoutMs: 600_000 })
    },
  }
}
