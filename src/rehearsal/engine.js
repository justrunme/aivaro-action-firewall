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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hashValue } from '../util/canonical.js'
import { redactDeep } from '../privacy/redact.js'
import { publicKeyHex, signValue, verifyValue } from '../receipts/keys.js'
import { appendReceipt, verifyChain } from '../receipts/chain.js'
import { AuthorizationRefused, entriesForPlan } from '../authorize/authorization.js'
import { run } from '../util/exec.js'
import { computeFingerprint } from '../fidelity/fingerprint.js'
import { baseHash } from '../fidelity/gate.js'
import { STATE_DIR } from '../fidelity/source.js'
import { createWorkspaceCopy } from './workspace.js'
import { assertIsolated, down, dump, psql, serverLog, up, writeNoPortsOverride } from './compose.js'
import { CONFLICT_MESSAGE, checkRequirements, findConflict } from '../mission/requirements.js'
import { comparableRole, createRoleSql, functionCalls, installObservers, judgeObservations, logMarker, missingKeys, observerState, planRoleOf, readObserverTables, recordsBetween } from './observe.js'
import { measureDatabase } from './measure.js'
import { buildImpact } from './impact.js'
import { executeSteps } from './steps.js'
import { archiveRehearsal, snapshotPlanFiles } from '../history/archive.js'

export const planId = (contract) => 'plan-' + hashValue(contract.plan).slice(7, 19)

export class RehearsalRefused extends Error {
  /** @param {string} code @param {string} message @param {unknown} [detail] */
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/** Inputs of the verdict other than the plan and the base state. */
export function rehearsalConditions(contract, target) {
  return {
    protected_tables: [...contract.protected_tables].sort(),
    impact_thresholds: contract.impact_thresholds ?? {},
    // The requirements the verdict checked (T25 v2 Step 3), when the mission has any.
    ...(contract.required_changes?.length || contract.invariants?.length ? { requirements_hash: hashValue({ required_changes: contract.required_changes ?? [], invariants: contract.invariants ?? [] }) } : {}),
    // The role the plan ran as: plans rehearsed with different rights are not comparable.
    ...(target.planUser ? { plan_role: target.planUser } : {}),
    // Only when set, so reports of contracts without it keep their conditions.
    ...(contract.allowed_logic_changes?.length ? { allowed_logic_changes: [...contract.allowed_logic_changes].sort() } : {}),
    db_name: target.dbName,
    // Tests are not run during rehearsal yet: nothing is measured, nothing is claimed.
    tests_measured: false,
  }
}

export function reportPath(repoDir, missionId, id) {
  return path.join(repoDir, STATE_DIR, 'missions', missionId, 'rehearsals', `${id}.json`)
}

export function loadReport(repoDir, missionId, id) {
  return JSON.parse(readFileSync(reportPath(repoDir, missionId, id), 'utf8'))
}

/**
 * Reports are signed by the operator key at rehearsal time, so a report written by
 * anything else (for example a rehearsed script writing into .justrunme) is rejected.
 * @returns {string | null} problem
 */
export function reportSignatureProblem(report, publicKey) {
  if (!report || typeof report !== 'object') return 'report is malformed'
  const { signature, ...body } = report
  if (body.operator_pubkey !== publicKeyHex(publicKey)) return 'report was signed by a different key'
  return verifyValue(publicKey, body, signature) ? null : 'report signature is invalid'
}

/** What is left of a Compose project after `down` (containers, volumes, networks). */
async function leftovers(project) {
  const filter = `label=com.docker.compose.project=${project}`
  const list = async (args) => (await run('docker', args)).stdout.split('\n').filter(Boolean).length
  return {
    containers: await list(['ps', '-a', '-q', '--filter', filter]),
    volumes: await list(['volume', 'ls', '-q', '--filter', filter]),
    networks: await list(['network', 'ls', '-q', '--filter', filter]),
  }
}

/**
 * @param {object} a
 * @param {string} a.repoDir real workspace (git working tree)
 * @param {any} a.contract
 * @param {string} a.contractHash
 * @param {import('./compose.js').Target} a.target real Compose project; composeFile relative to repoDir
 * @param {{ privateKey: any, publicKey: any }} a.keys operator keys; the report is signed
 * @param {() => number} [a.clock]
 */
export async function rehearse({ repoDir, contract, contractHash, target, keys, clock = Date.now }) {
  if (!keys) throw new Error('rehearse needs the operator keys to sign the report')
  // Before anything runs: a plan that could never be authorized is not executed
  // either (it would run agent-authored steps that invoke JustRunMe itself), and a
  // chain that does not verify could not record the result.
  try {
    entriesForPlan(contract.plan, repoDir)
  } catch (err) {
    if (err instanceof AuthorizationRefused) throw new RehearsalRefused(err.code, `${err.message}; nothing was executed`)
    throw err
  }
  const chain = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId: contract.id })
  if (!chain.ok) throw new RehearsalRefused('CHAIN_INVALID', `receipt chain does not verify: ${chain.findings[0].problem}; nothing was executed`)
  const started = clock()
  const realTarget = { ...target, composeFile: path.resolve(repoDir, target.composeFile) }
  // T25 v2 Step 3: requirements that cannot all hold are answered before any plan runs,
  // so no agent searches for a way around them.
  const conflict = await findConflict(contract, (sql) => psql(realTarget, { sql }))
  if (conflict) throw new RehearsalRefused('CONFLICT', CONFLICT_MESSAGE, { conflicts: conflict.conflicts })
  const fingerprint = await computeFingerprint({ repoDir, target: realTarget, contract, contractHash })
  // The SQL as rehearsed, by content hash (T27.1 plan history): the plan id names the
  // file paths only, so two versions of a file share an id but not these hashes.
  const snapshot = snapshotPlanFiles(contract.plan, repoDir)
  const id = planId(contract)
  const copy = await createWorkspaceCopy(repoDir)
  const suffix = randomBytes(4).toString('hex')
  const project = `jrm-reh-${contract.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}-${suffix}`
  const rehearsalTarget = {
    ...target,
    project,
    composeFile: path.resolve(copy.dir, target.composeFile),
    // The copy holds a dump of the real database and runs agent-written SQL: no network at all.
    overrideFile: writeNoPortsOverride([target.dbService], { isolate: true }),
  }

  let steps = []
  let before = null
  let after = null
  let failure = null
  // T25 v2: observers in the copy and the plan role (src/rehearsal/observe.js).
  const observation = { plan_role: target.planUser ?? null, unverifiable: [], evidence: [], watchers: [] }
  let requirements = null
  const owner = (sql) => psql(rehearsalTarget, { sql })
  const ownerScript = (input) => psql(rehearsalTarget, { input })
  try {
    await up(rehearsalTarget, [target.dbService])
    // Before the real data is loaded and before any plan step runs.
    await assertIsolated(rehearsalTarget)
    let realRole = null
    if (target.planUser) {
      // Roles are not in the dump: create the plan role as it is for real; its grants come with the dump.
      realRole = await planRoleOf((sql) => psql(realTarget, { sql }), target.planUser)
      if (!realRole.exists) throw new Error(`the plan role ${target.planUser} does not exist in the real database`)
      const made = await ownerScript(createRoleSql(realRole))
      if (made.code !== 0) throw new Error('creating the plan role in the copy failed')
    }
    const data = await dump(realTarget, { privileges: Boolean(target.planUser) })
    const load = await psql(rehearsalTarget, { input: data })
    if (load.code !== 0) throw new Error('loading the database copy failed')
    let installed = null
    try {
      installed = await installObservers(owner, ownerScript, { protectedTables: contract.protected_tables, planRole: target.planUser ?? null })
      observation.watchers = installed.watchers.map((w) => w.trigger)
    } catch (err) {
      observation.unverifiable.push(String(err?.message ?? err).split('\n')[0].slice(0, 200))
    }
    let copyRole = null
    if (target.planUser) {
      copyRole = await planRoleOf(owner, target.planUser)
      const a = comparableRole(realRole)
      const b = comparableRole(copyRole)
      const differs = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      if (differs.length > 0) observation.unverifiable.push(`the plan role has other rights in the copy than for real (${differs.map((k) => `${k}: real ${JSON.stringify(a[k])}, copy ${JSON.stringify(b[k])}`).join('; ').slice(0, 400)})`)
    }
    before = await measureDatabase(owner)
    const callsBefore = installed ? await functionCalls(owner, installed.watchers) : {}
    const start = installed ? await logMarker(owner) : null
    steps = await executeSteps({ plan: contract.plan, cwd: copy.dir, target: rehearsalTarget, mode: 'rehearsal' })
    const end = installed ? await logMarker(owner) : null
    after = await measureDatabase(owner)
    // T25 v2 Step 3: the mission's required changes and invariants, checked on the copy.
    if ((contract.required_changes?.length ?? 0) + (contract.invariants?.length ?? 0) > 0) requirements = await checkRequirements(contract, owner)
    if (installed) {
      const judged = judgeObservations({
        installed,
        after: await observerState(owner),
        callsBefore,
        callsAfter: await functionCalls(owner, installed.watchers),
        ...(await readObserverTables(owner)),
        records: recordsBetween(await serverLog(rehearsalTarget), start, end),
        planRole: copyRole,
      })
      observation.evidence = judged.evidence
      observation.unverifiable.push(...judged.unverifiable)
      observation.missing = await missingKeys(owner, installed.keyed)
      // A refused run whose plan left no record in the server log cannot be judged (review S5).
      if (steps.some((s) => s.status === 'failed' && !String(s.detail).startsWith('META_COMMAND')) && judged.records === 0) observation.unverifiable.push('the plan failed and the server log holds no record of it')
    }
    // Review B1: a psql backslash command in a plan is an attempt to leave the plan role.
    for (const s of steps) if (String(s.detail).startsWith('META_COMMAND')) observation.evidence.push({ kind: 'bypass_meta_command', step: s.id, what: 'uses a psql backslash command (\\c reconnects as another role, \\! runs a shell)' })
  } catch (err) {
    failure = String(err?.message ?? err)
  } finally {
    // The database dump is held in memory only; nothing to delete on disk.
    await down(rehearsalTarget)
    await copy.remove()
    rmSync(path.dirname(rehearsalTarget.overrideFile), { recursive: true, force: true })
  }
  const left = await leftovers(project)
  const cleanup = { ...left, worktree_removed: !existsSync(copy.dir), clean: left.containers + left.volumes + left.networks === 0 && !existsSync(copy.dir) }

  const impact = failure
    ? { verdict: 'FAILED', evidence: [{ kind: 'rehearsal_error', detail: failure }] }
    : buildImpact({ before, after, protectedTables: contract.protected_tables, steps, thresholds: contract.impact_thresholds, allowedLogicChanges: contract.allowed_logic_changes ?? [], bypass: observation, requirements })

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
    // What the verdict was measured against (R15 comparability): two plans judged
    // with different protected tables or thresholds are not comparable.
    conditions: rehearsalConditions(contract, target),
    plan_files: snapshot.files,
    database: failure ? null : { name: target.dbName, before, after },
    cleanup,
    // T25 v2: what the observers in the copy saw (signed with the rest of the report).
    observation: { plan_role: observation.plan_role, watched_triggers: observation.watchers, unverifiable: observation.unverifiable, missing_keys: observation.missing ?? {} },
    ...impact,
    operator_pubkey: publicKeyHex(keys.publicKey),
  })
  const signed = { ...report, signature: signValue(keys.privateKey, report) }
  const file = reportPath(repoDir, contract.id, id)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(signed, null, 2) + '\n')
  // Before the receipt: a receipt never names a version the archive does not hold.
  archiveRehearsal(repoDir, contract.id, signed, snapshot.blobs)
  try {
    appendReceipt({
      repoDir,
      keys,
      missionId: contract.id,
      kind: 'rehearsal',
      verdict: signed.verdict,
      subject: { plan_id: id, report_hash: hashValue(signed), base_hash: signed.base_hash, duration_ms: signed.duration_ms, evidence: signed.evidence, files_hash: hashValue(signed.plan_files) },
    })
  } catch (err) {
    // The verdict is still returned; without its receipt the report cannot be
    // compared or authorized (both require the matching rehearsal receipt).
    return { ...signed, receipt_error: err.code === 'CHAIN_LOCKED' ? 'CHAIN_LOCKED' : 'CHAIN_INVALID' }
  }
  return signed
}
