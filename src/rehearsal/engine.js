/**
 * Rehearsal engine (R2.1 to R2.7, R3.1, R15.1).
 *
 * 1. Fingerprint the real target.
 * 2. Create a workspace copy and a Compose copy with a unique project name.
 * 3. Load a pg_dump of the real database into the copy.
 * 4. Measure, run the plan, measure again, build the impact report.
 * 5. Always remove the copy (containers, volumes, network, worktree).
 * 6. Store the report under .justrunme/missions/<mission>/rehearsals/<plan_id>.json.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hashValue } from '../util/canonical.js'
import { redactDeep } from '../privacy/redact.js'
import { computeFingerprint } from '../fidelity/fingerprint.js'
import { baseHash } from '../fidelity/gate.js'
import { STATE_DIR } from '../fidelity/source.js'
import { createWorkspaceCopy } from './workspace.js'
import { down, dump, psql, up, writeNoPortsOverride } from './compose.js'
import { measureDatabase } from './measure.js'
import { buildImpact } from './impact.js'
import { executeSteps } from './steps.js'

export const planId = (contract) => 'plan-' + hashValue(contract.plan).slice(7, 19)

export function reportPath(repoDir, missionId, id) {
  return path.join(repoDir, STATE_DIR, 'missions', missionId, 'rehearsals', `${id}.json`)
}

export function loadReport(repoDir, missionId, id) {
  return JSON.parse(readFileSync(reportPath(repoDir, missionId, id), 'utf8'))
}

/**
 * @param {object} a
 * @param {string} a.repoDir real workspace (git working tree)
 * @param {any} a.contract
 * @param {string} a.contractHash
 * @param {import('./compose.js').Target} a.target real Compose project; composeFile relative to repoDir
 * @param {() => number} [a.clock]
 */
export async function rehearse({ repoDir, contract, contractHash, target, clock = Date.now }) {
  const started = clock()
  const realTarget = { ...target, composeFile: path.resolve(repoDir, target.composeFile) }
  const fingerprint = await computeFingerprint({ repoDir, target: realTarget, contract, contractHash })
  const id = planId(contract)
  const copy = await createWorkspaceCopy(repoDir)
  const suffix = randomBytes(4).toString('hex')
  const project = `jrm-reh-${contract.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}-${suffix}`
  const rehearsalTarget = {
    ...target,
    project,
    composeFile: path.resolve(copy.dir, target.composeFile),
    overrideFile: writeNoPortsOverride([target.dbService]),
  }

  let steps = []
  let before = null
  let after = null
  let failure = null
  try {
    await up(rehearsalTarget, [target.dbService])
    const data = await dump(realTarget)
    const load = await psql(rehearsalTarget, { input: data })
    if (load.code !== 0) throw new Error('loading the database copy failed')
    before = await measureDatabase((sql) => psql(rehearsalTarget, { sql }))
    steps = await executeSteps({ plan: contract.plan, cwd: copy.dir, target: rehearsalTarget, mode: 'rehearsal' })
    after = await measureDatabase((sql) => psql(rehearsalTarget, { sql }))
  } catch (err) {
    failure = String(err?.message ?? err)
  } finally {
    await down(rehearsalTarget)
    await copy.remove()
  }

  const impact = failure
    ? { verdict: 'FAILED', evidence: [{ kind: 'rehearsal_error', detail: failure }] }
    : buildImpact({ before, after, protectedTables: contract.protected_tables, steps, thresholds: contract.impact_thresholds })

  const report = redactDeep({
    version: 1,
    mission_id: contract.id,
    plan_id: id,
    contract_hash: contractHash,
    base_hash: baseHash(fingerprint),
    fingerprint,
    rehearsed_at: new Date(started).toISOString(),
    duration_ms: clock() - started,
    compose_project: project,
    steps,
    irreversible_actions: contract.irreversible_actions,
    all_reversible: contract.irreversible_actions.length === 0,
    database: failure ? null : { name: target.dbName, before, after },
    ...impact,
  })
  const file = reportPath(repoDir, contract.id, id)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  return report
}
