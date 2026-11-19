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
 *
 * Several missions: every directory under .justrunme/missions/ whose name is a valid
 * mission id is one mission of this workspace (`missions()`). A call may name one of
 * them; the name is checked against that list and the mission-id pattern before it is
 * passed on as `--mission <id>`, so a request can never point the CLI anywhere else.
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../cli/index.js'

export const READ_COMMANDS = Object.freeze(['history', 'verify', 'approvals', 'status', 'receipt', 'replay'])
const CLI = fileURLToPath(new URL('../cli/index.js', import.meta.url))

const REQUEST_ID_RE = /^apr-[0-9a-f]{16}$/
const PLAN_ID_RE = /^plan-[0-9a-f]{12}$/
const CAPTURE_RE = /^cap-\d{14}-[0-9a-f]{6}$/
const SEQ_RE = /^\d{1,9}$/
// The same pattern the CLI and the receipt chain use for mission ids.
export const MISSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/
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

/** Mission ids of a workspace: the valid directory names under .justrunme/missions/, sorted. */
export function listMissions(repoDir) {
  const dir = path.join(repoDir, '.justrunme', 'missions')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && MISSION_RE.test(e.name))
    .map((e) => ({ mission_id: e.name, has_receipts: existsSync(path.join(dir, e.name, 'receipts.jsonl')) }))
    .sort((a, b) => a.mission_id.localeCompare(b.mission_id))
}

/**
 * @param {{ repoDir: string, mission?: string, cliPath?: string, env?: NodeJS.ProcessEnv, runMain?: typeof main }} cfg
 */
export function createApi({ repoDir, mission, cliPath = CLI, env = process.env, runMain = main }) {
  /** The mission a call names: the fixed one of this Console, or one of the workspace's missions. */
  function missionOf(asked) {
    if (asked === undefined || asked === null || asked === '') return mission ?? null
    if (typeof asked !== 'string' || !MISSION_RE.test(asked)) throw new InputError('MISSION_INVALID', 'mission must be a mission id')
    if (asked !== mission && !listMissions(repoDir).some((m) => m.mission_id === asked)) throw new InputError('MISSION_UNKNOWN', 'no such mission in this workspace')
    return asked
  }
  const scopeOf = (m) => ['--repo', repoDir, ...(m ? ['--mission', m] : [])]

  async function read(m, command, ...args) {
    const { output } = await runMain(readArgv(command, args, scopeOf(m)))
    return output
  }

  /** The child's environment: everything this process has, minus the passphrase. */
  function childEnv() {
    const e = { ...env }
    delete e.JUSTRUNME_APPROVER_PASSPHRASE
    return e
  }

  function runChild(m, args, { stdin = null, timeoutMs }) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cliPath, ...args, ...scopeOf(m)], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
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
    /**
     * The missions of this workspace. `default` is the mission a call without one reads:
     * the Console's fixed mission, else (null) the one the contract file names.
     */
    missions() {
      const list = listMissions(repoDir)
      if (mission && !list.some((m) => m.mission_id === mission)) list.unshift({ mission_id: mission, has_receipts: false })
      return { ok: true, default: mission ?? null, missions: list }
    },

    /** Everything the Missions, Impact Diff and Recovery screens show, for one mission. */
    async state(asked) {
      const m = missionOf(asked)
      const [story, verify, approvals, status] = await Promise.all([read(m, 'history'), read(m, 'verify'), read(m, 'approvals'), read(m, 'status')])
      return { mission: m, story, verify, approvals, status }
    },

    async approval(id, asked) {
      if (!REQUEST_ID_RE.test(id ?? '')) throw new InputError('REQUEST_INVALID', 'request id must look like apr-<16 hex>')
      return read(missionOf(asked), 'approvals', id)
    },

    async receipt(seq, asked) {
      if (!SEQ_RE.test(seq ?? '')) throw new InputError('INVALID_SEQ', 'seq must be a number')
      return read(missionOf(asked), 'receipt', '--seq', seq)
    },

    async replay(asked) {
      return read(missionOf(asked), 'replay')
    },

    async approve({ request_id, confirm, passphrase, mission: asked } = {}) {
      if (!REQUEST_ID_RE.test(request_id ?? '')) throw new InputError('REQUEST_INVALID', 'request id must look like apr-<16 hex>')
      if (!PLAN_ID_RE.test(confirm ?? '')) throw new InputError('CONFIRMATION_REQUIRED', 'confirm that you reviewed the plan (its plan id, plan-<12 hex>)')
      if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE || /[\r\n]/.test(passphrase)) {
        throw new InputError('PASSPHRASE_REQUIRED', 'the approver passphrase is required (one line)')
      }
      const m = missionOf(asked)
      const out = await runChild(m, ['approve', request_id, '--confirm', confirm, '--passphrase-stdin'], { stdin: passphrase, timeoutMs: 180_000 })
      // The CLI never prints the passphrase; this keeps it out of the response even if that changed.
      const text = JSON.stringify(out)
      const needle = JSON.stringify(passphrase).slice(1, -1)
      return needle.length >= 4 && text.includes(needle) ? JSON.parse(text.split(needle).join('[redacted]')) : out
    },

    async deny({ request_id, reason, mission: asked } = {}) {
      if (!REQUEST_ID_RE.test(request_id ?? '')) throw new InputError('REQUEST_INVALID', 'request id must look like apr-<16 hex>')
      if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > MAX_REASON) throw new InputError('REASON_REQUIRED', `a reason of 3 to ${MAX_REASON} characters is required`)
      // `--reason=<text>`: a reason that starts with "-" stays the reason, never an option.
      return runChild(missionOf(asked), ['deny', request_id, `--reason=${reason.trim()}`], { timeoutMs: 60_000 })
    },

    async undo({ capture_id, confirm, mission: asked } = {}) {
      if (!CAPTURE_RE.test(capture_id ?? '')) throw new InputError('INVALID_CAPTURE_ID', 'capture id must look like cap-<14 digits>-<6 hex>')
      if (confirm !== capture_id) throw new InputError('CONFIRMATION_REQUIRED', 'confirm the undo of this capture')
      return runChild(missionOf(asked), ['undo', capture_id], { timeoutMs: 600_000 })
    },
  }
}
