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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { psql } from './compose.js'
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
        const r = await psql(target, { input: readFileSync(file), singleTransaction: true })
        result = r.code === 0 ? { status: 'ok', detail: '' } : { status: 'failed', detail: tail(r.stderr) }
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
