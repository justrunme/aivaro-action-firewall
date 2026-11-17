#!/usr/bin/env node
/**
 * justrunme CLI (T18): JSON on stdout by default, `--text` for people, stable exit
 * codes (src/cli/codes.js). No colour codes are ever written. Output is redacted
 * (home paths, e-mail addresses, credential values) before it is printed.
 *
 *   justrunme keys init
 *   justrunme rehearse | authorize | run
 *   justrunme compare [plan_id ...]
 *   justrunme undo <capture_id> [--resource files|config_files|postgres|containers ...]
 *   justrunme verify | replay [--receipt <hash>] | status | receipt [--seq n]
 *   justrunme reanchor --reason "<text>"
 *   justrunme lock inspect | lock recover [--sha256 <hash>] --reason "<text>"
 * Common options: --repo <dir> (default: current directory), --mission <id>, --text.
 */

import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { redactDeep } from '../privacy/redact.js'
import { keyHome } from '../receipts/keys.js'
import { EXIT } from './codes.js'
import * as cmd from './commands.js'

const MISSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/
const OPTIONS = {
  repo: { type: 'string' },
  mission: { type: 'string' },
  text: { type: 'boolean', default: false },
  reason: { type: 'string' },
  sha256: { type: 'string' },
  receipt: { type: 'string' },
  seq: { type: 'string' },
  resource: { type: 'string', multiple: true },
  'emergency-recovery': { type: 'boolean', default: false },
  confirm: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
}

const USAGE = 'usage: justrunme <keys init|rehearse|compare|authorize|run|undo|verify|replay|status|receipt|reanchor|lock|judge> [options]'

async function dispatch(command, rest, repoDir, opts) {
  const ctx = { repoDir, opts }
  switch (command) {
    case 'keys':
      if (rest[0] !== 'init') break
      return cmd.keysInit()
    case 'rehearse':
      return cmd.rehearseCmd(ctx)
    case 'compare':
      return cmd.compareCmd({ ...ctx, planIds: rest })
    case 'authorize':
      return cmd.authorizeCmd(ctx)
    case 'run':
      return cmd.runCmd(ctx)
    case 'undo':
      return cmd.undoCmd({ ...ctx, captureId: rest[0] })
    case 'verify':
      return cmd.verifyCmd(ctx)
    case 'replay':
      return cmd.replayCmd(ctx)
    case 'status':
      return cmd.statusCmd(ctx)
    case 'receipt':
      return cmd.receiptCmd(ctx)
    case 'reanchor':
      return cmd.reanchorCmd(ctx)
    case 'lock':
      return cmd.lockCmd({ ...ctx, action: rest[0] })
    case 'judge':
      return cmd.judgeCmd(ctx)
  }
  throw new cmd.CliError(EXIT.USAGE, 'USAGE', USAGE)
}

function textOf(out) {
  const lines = [`${out.command}: ${out.ok ? 'ok' : 'not ok'} (exit ${out.exit_code})`]
  if (out.error) {
    lines.push(`${out.error.code}: ${out.error.message}`)
    if (out.error.detail !== undefined) lines.push(JSON.stringify(out.error.detail))
  }
  if (out.command === 'judge' && out.result?.steps) {
    const j = out.result.judge
    lines.push(`${j.status} in ${(j.elapsed_ms / 1000).toFixed(1)} s (budget ${j.budget_ms / 1000} s, ${j.budget_enforced ? 'enforced' : 'not enforced: images were downloaded'})`)
    for (const s of out.result.steps) lines.push(`  ${s.status === 'passed' ? 'ok  ' : s.status === 'failed' ? 'FAIL' : 'skip'} ${s.title}${s.duration_ms === undefined ? '' : ` (${(s.duration_ms / 1000).toFixed(1)} s)`}`)
    lines.push(`receipts verified: ${out.result.counts.receipts_verified}, mismatches: ${out.result.counts.mismatches}, policy violations: ${out.result.counts.policy_violations}`)
  } else if (out.result) {
    for (const [k, v] of Object.entries(out.result)) lines.push(`${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
  }
  return lines.map(printable).join('\n') + '\n'
}

/**
 * @param {string[]} argv
 * @returns {Promise<{ exit: number, output: object }>}
 */
export async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (err) {
    return { exit: EXIT.USAGE, output: { command: null, ok: false, exit_code: EXIT.USAGE, error: { code: 'USAGE', message: err.message } } }
  }
  const [command = null, ...rest] = parsed.positionals
  const opts = parsed.values
  let exit
  let body
  try {
    if (opts.help) return { exit: EXIT.OK, text: opts.text, output: { command, ok: true, exit_code: EXIT.OK, result: { usage: USAGE } } }
    if (!command) throw new cmd.CliError(EXIT.USAGE, 'USAGE', USAGE)
    if (opts.mission !== undefined && !MISSION_RE.test(opts.mission)) throw new cmd.CliError(EXIT.USAGE, 'USAGE', 'invalid --mission')
    if ((opts['emergency-recovery'] || opts.confirm !== undefined) && command !== 'undo') throw new cmd.CliError(EXIT.USAGE, 'USAGE', '--emergency-recovery and --confirm exist only for undo')
    const repoDir = path.resolve(opts.repo ?? process.cwd())
    const r = await dispatch(command, rest, repoDir, opts)
    exit = r.exit
    body = { result: r.result }
  } catch (err) {
    if (err instanceof cmd.CliError) {
      exit = err.exit
      body = { error: { code: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) } }
    } else if (err?.code === 'CHAIN_LOCKED') {
      exit = EXIT.CHAIN_LOCKED
      body = { error: { code: 'CHAIN_LOCKED', message: String(err.message) } }
    } else {
      exit = EXIT.INTERNAL
      body = { error: { code: 'INTERNAL', message: String(err?.message ?? err) } }
    }
  }
  const out = { command, ok: exit === EXIT.OK, exit_code: exit, ...body }
  const pairs = [[keyHome(), '$JUSTRUNME_HOME'], [path.resolve(opts.repo ?? process.cwd()), '$REPO']]
  // judge works in temporary directories whose names can appear in error text.
  if (command === 'judge') for (const t of new Set([os.tmpdir(), tryReal(os.tmpdir())])) pairs.push([t, '$TMP'])
  return { exit, text: opts.text, output: redactDeep(scrubPaths(out, pairs)) }
}

/**
 * Replace local paths that redact() does not know (a key directory or workspace
 * outside the home directory) with placeholders, longest first.
 * @param {unknown} value
 * @param {[string, string][]} pairs
 */
export function scrubPaths(value, pairs) {
  const sorted = pairs.filter(([p]) => typeof p === 'string' && p.length > 1).sort((a, b) => b[0].length - a[0].length)
  const walk = (v) => {
    if (typeof v === 'string') return sorted.reduce((s, [p, label]) => s.split(p).join(label), v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value)
}

const tryReal = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Text mode: no control characters, so nothing can colour the terminal or fake a line. */
export const printable = (s) => String(s).replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '?')

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntry) {
  const { exit, text, output } = await main(process.argv.slice(2))
  process.stdout.write(text ? textOf(output) : JSON.stringify(output) + '\n')
  process.exitCode = exit
}
