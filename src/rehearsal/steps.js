/**
 * Execute plan steps against one Compose target. Used for both rehearsal (copy)
 * and the real run, so the two execute the same code path.
 *
 * Supported step tools:
 *   sql_migration  args: [<file>]  file applied with psql in one transaction
 *   shell          args: argv      run without a shell, cwd = workspace root,
 *                                  COMPOSE_PROJECT_NAME / COMPOSE_FILE point at the target
 * Steps with reversibility false are not executed in rehearsal (they need approval).
 * Any other tool cannot be rehearsed and fails the rehearsal (fail closed).
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { psql } from './compose.js'
import { backslashInCode, metaCommandAt } from './sqltext.js'
import { run } from '../util/exec.js'
import { errorSummary } from '../privacy/redact.js'

const tail = (s) => errorSummary(s)

// Plan steps are agent-authored code: they get no pointer to the operator key
// directory and cannot switch the gate. (They still run as the OS user; see the threat model.)
function stepEnv(target) {
  const env = { ...process.env, COMPOSE_PROJECT_NAME: target.project, COMPOSE_FILE: [target.composeFile, target.overrideFile].filter(Boolean).join(path.delimiter) }
  delete env.JUSTRUNME_HOME
  delete env.JUSTRUNME_GATE
  return env
}

function insideRoot(root, rel) {
  const abs = path.resolve(root, rel)
  return abs.startsWith(root + path.sep) ? abs : null
}

/**
 * @param {object} a
 * @param {any[]} a.plan
 * @param {string} a.cwd workspace root of this run (copy or real)
 * @param {import('./compose.js').Target} a.target
 * @param {'rehearsal' | 'real'} a.mode
 * @returns {Promise<{ id: string, tool: string, status: string, detail: string }[]>}
 */
export async function executeSteps({ plan, cwd, target, mode }) {
  const results = []
  let stopped = false
  for (const step of plan) {
    if (stopped) {
      results.push({ id: step.id, tool: step.tool, status: 'not_run', detail: 'an earlier step failed' })
      continue
    }
    if (step.reversibility === false) {
      results.push({ id: step.id, tool: step.tool, status: mode === 'rehearsal' ? 'not_rehearsed_irreversible' : 'skipped_needs_approval', detail: 'irreversible action' })
      continue
    }
    let result
    if (step.tool === 'sql_migration') {
      const file = step.args.length === 1 ? insideRoot(cwd, step.args[0]) : null
      if (!file) {
        result = { status: 'failed', detail: 'sql_migration needs exactly one file inside the workspace' }
      } else {
        // The path was checked when the plan was proposed; check again what is on disk now,
        // so that a file swapped for a link in between is not read.
        let linked = true
        try {
          linked = lstatSync(file).isSymbolicLink() || realpathSync(file) !== path.join(realpathSync(cwd), path.relative(cwd, file))
        } catch {
          linked = true
        }
        const text = linked ? null : readFileSync(file)
        // psql reads backslash commands from stdin (\c reconnects as another role, \! runs a shell): only SQL runs.
        const meta = text === null ? -1 : metaCommandAt(text.toString('utf8'))
        const r = linked
          ? { code: 1, stderr: 'the migration file is missing or is a symbolic link' }
          : meta !== -1
            ? backslashInCode(text.toString('utf8'))
              ? { code: 1, stderr: `META_COMMAND: the migration contains a psql backslash command at offset ${meta}; only SQL may run` }
              : { code: 1, stderr: `BACKSLASH_REFUSED: the migration contains a backslash at offset ${meta} (inside a string or comment); plan files may contain no backslash at all, write the value another way (for example chr(10) for a newline)` }
            : await psql(target, { input: text, singleTransaction: true, asPlan: true })
        // reached_database: false when the step failed before psql ran (missing file, link, backslash command).
        result = r.code === 0 ? { status: 'ok', detail: '' } : { status: 'failed', detail: tail(r.stderr), ...(linked || meta !== -1 ? { reached_database: false } : {}) }
      }
    } else if (step.tool === 'shell') {
      const r = await run(step.args[0], step.args.slice(1), { cwd, env: stepEnv(target), timeoutMs: 120000 })
      result = r.code === 0 ? { status: 'ok', detail: '' } : { status: 'failed', detail: `exit ${r.code}: ${tail(r.stderr)}` }
    } else {
      result = { status: 'failed', detail: `tool ${step.tool} cannot be rehearsed` }
    }
    results.push({ id: step.id, tool: step.tool, ...result })
    if (result.status === 'failed') stopped = true
  }
  return results
}
