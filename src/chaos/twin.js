/**
 * Chaos Twin Lite: rehearse the recovery itself before relying on it.
 *
 * 1. A disposable twin: a copy of the workspace (git worktree), an isolated Compose project
 *    with no network, and a pg_dump of the real database loaded into it. The real database
 *    is only read (pg_dump and the fingerprint); nothing is written to it.
 * 2. The same pre-run capture the real run makes (captureState), inside the twin, signed by
 *    a throwaway key whose directory is removed afterwards.
 * 3. The plan runs in the twin up to the fault point (all reversible steps by default),
 *    then the database container is killed and started again (a crash, not a clean stop).
 * 4. The same undo the operator would run (undoMission), against the twin.
 * 5. The same recovery verification (schema hash, row counts, table checksums, privileges,
 *    files, images), plus a check that the plan really changed the twin before the undo:
 *    a recovery from no change proves nothing and is reported as such.
 * 6. One receipt in the real mission chain, signed by the operator key, records the fault,
 *    the divergence, the undo result and the verification, with the plan's file hashes
 *    and the base hash of the real state it was rehearsed on.
 *
 * Verdicts: RECOVERY PROVEN (the plan changed the twin, the undo restored it, verification
 * PASS); RECOVERY UNVERIFIED (restored, a required check could not be made); RECOVERY FAILED
 * (not restored or a check failed); NOTHING TO RECOVER (the plan changed nothing measured);
 * FAILED (the twin could not be built or run). Only what the capture covers is proven:
 * tracked files under allowed_paths, contract config files, the named database, images.
 * The health endpoint is not checked (the twin runs the database only), and external side
 * effects are outside every capture.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureState } from '../capture/capture.js'
import { computeFingerprint } from '../fidelity/fingerprint.js'
import { baseHash } from '../fidelity/gate.js'
import { snapshotPlanFiles } from '../history/archive.js'
import { appendReceipt, verifyChain } from '../receipts/chain.js'
import { loadOrCreateKeys } from '../receipts/keys.js'
import { assertIsolated, down, dump, psql, up, writeNoPortsOverride } from '../rehearsal/compose.js'
import { planId } from '../rehearsal/engine.js'
import { measureDatabase } from '../rehearsal/measure.js'
import { createRoleSql, planRoleOf } from '../rehearsal/observe.js'
import { executeSteps } from '../rehearsal/steps.js'
import { createWorkspaceCopy } from '../rehearsal/workspace.js'
import { undoMission } from '../undo/undo.js'
import { hashValue } from '../util/canonical.js'
import { run } from '../util/exec.js'
import { errorSummary } from '../privacy/redact.js'

export class ChaosRefused extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** What differs between two database measurements (schema, row counts, table checksums). */
export function divergence(before, after) {
  const tables = [...new Set([...Object.keys(before?.tables ?? {}), ...Object.keys(after?.tables ?? {})])].sort()
  const rows = tables.filter((t) => (before.tables[t]?.rows ?? null) !== (after.tables[t]?.rows ?? null))
  const checksums = tables.filter((t) => (before.tables[t]?.checksum ?? null) !== (after.tables[t]?.checksum ?? null))
  const schema = before?.schema_hash !== after?.schema_hash
  return { changed: schema || rows.length > 0 || checksums.length > 0, schema_changed: schema, tables_with_other_rows: rows, tables_with_other_checksums: checksums }
}

/** @returns {string} the verdict of a recovery rehearsal */
export function chaosVerdict({ failure, diverged, undoStatus }) {
  if (failure) return 'FAILED'
  if (!diverged) return 'NOTHING TO RECOVER'
  if (undoStatus === 'RECOVERED') return 'RECOVERY PROVEN'
  if (undoStatus === 'RESTORED_UNVERIFIED') return 'RECOVERY UNVERIFIED'
  return 'RECOVERY FAILED'
}

/** Kill (SIGKILL) the twin's database container and start it again: Postgres recovers from a crash. */
async function crash(target) {
  const args = ['compose', '-p', target.project, '-f', target.composeFile, '-f', target.overrideFile]
  const killed = await run('docker', [...args, 'kill', '-s', 'SIGKILL', target.dbService], { timeoutMs: 60000 })
  if (killed.code !== 0) throw new Error(`could not kill the twin database: ${errorSummary(killed.stderr)}`)
  await up(target, [target.dbService])
}

async function leftovers(project) {
  const filter = `label=com.docker.compose.project=${project}`
  const count = async (args) => (await run('docker', args)).stdout.split('\n').filter(Boolean).length
  return { containers: await count(['ps', '-a', '-q', '--filter', filter]), volumes: await count(['volume', 'ls', '-q', '--filter', filter]), networks: await count(['network', 'ls', '-q', '--filter', filter]) }
}

/**
 * @param {object} a
 * @param {string} a.repoDir real workspace
 * @param {any} a.contract
 * @param {string} a.contractHash
 * @param {import('../rehearsal/compose.js').Target} a.target real target, composeFile relative to repoDir
 * @param {{ privateKey: any, publicKey: any, home: string }} a.keys operator keys: only the final receipt
 * @param {number | null} [a.afterStep] steps run before the crash; default: every step
 */
export async function rehearseRecovery({ repoDir, contract, contractHash, target, keys, afterStep = null, clock = Date.now }) {
  const plan = contract.plan
  const k = afterStep ?? plan.length
  if (!Number.isInteger(k) || k < 0 || k > plan.length) throw new ChaosRefused('FAULT_INVALID', `the fault point must be a step count from 0 to ${plan.length}`)
  const chain = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId: contract.id })
  if (!chain.ok) throw new ChaosRefused('CHAIN_INVALID', `receipt chain does not verify: ${chain.findings[0].problem}; nothing was run`)

  const started = clock()
  const realTarget = { ...target, composeFile: path.resolve(repoDir, target.composeFile) }
  const fingerprint = await computeFingerprint({ repoDir, target: realTarget, contract, contractHash })
  const snapshot = snapshotPlanFiles(plan, repoDir)
  const copy = await createWorkspaceCopy(repoDir)
  // A throwaway key: the twin's capture, undo and verification receipts never touch the operator's chain or key directory.
  const twinHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'jrm-twin-keys-')))
  const twinKeys = loadOrCreateKeys(twinHome)
  const project = `jrm-twin-${contract.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}-${randomBytes(4).toString('hex')}`
  const twin = { ...target, project, composeFile: path.resolve(copy.dir, target.composeFile), overrideFile: writeNoPortsOverride([target.dbService], { isolate: true }) }
  const owner = (sql) => psql(twin, { sql })

  let failure = null
  let steps = []
  let diverged = null
  let undo = null
  try {
    await up(twin, [target.dbService])
    await assertIsolated(twin)
    if (target.planUser) {
      const role = await planRoleOf((sql) => psql(realTarget, { sql }), target.planUser)
      if (!role.exists) throw new Error(`the plan role ${target.planUser} does not exist in the real database`)
      if ((await psql(twin, { input: createRoleSql(role) })).code !== 0) throw new Error('creating the plan role in the twin failed')
    }
    const data = await dump(realTarget, { privileges: Boolean(target.planUser) })
    if ((await psql(twin, { input: data })).code !== 0) throw new Error('loading the twin database failed')

    const manifest = await captureState({ repoDir: copy.dir, contract, target: twin, keys: twinKeys })
    steps = await executeSteps({ plan: plan.slice(0, k), cwd: copy.dir, target: twin, mode: 'rehearsal' })
    await crash(twin)
    diverged = divergence(manifest.postgres[0].measurement, await measureDatabase(owner))
    const u = await undoMission({ repoDir: copy.dir, missionId: contract.id, captureId: manifest.capture_id, target: { ...twin, composeFile: target.composeFile }, keys: twinKeys, health: null })
    const v = u.verification
    undo = {
      status: u.status,
      resources: u.resources.map((r) => ({ resource: r.resource, status: r.status })),
      verification: { status: v.status, checks: v.checks.length, checked: [...new Set(v.checks.map((c) => c.check))].sort(), failed: v.failed.slice(0, 20).map((c) => ({ check: c.check, resource: c.resource })), not_checked: (v.not_checked ?? []).map((c) => ({ check: c.check, resource: c.resource })), coverage: v.coverage ?? null },
    }
  } catch (err) {
    failure = errorSummary(String(err?.message ?? err))
  } finally {
    await down(twin)
    await copy.remove()
    rmSync(path.dirname(twin.overrideFile), { recursive: true, force: true })
    rmSync(twinHome, { recursive: true, force: true })
  }
  const left = await leftovers(project)
  const cleanup = { ...left, worktree_removed: !existsSync(copy.dir), keys_removed: !existsSync(twinHome), clean: left.containers + left.volumes + left.networks === 0 && !existsSync(copy.dir) && !existsSync(twinHome) }
  const verdict = chaosVerdict({ failure, diverged: diverged?.changed === true, undoStatus: undo?.status })

  const subject = {
    plan_id: planId(contract),
    files_hash: hashValue(snapshot.files),
    base_hash: baseHash(fingerprint),
    fault: { after_step: k, of_steps: plan.length, crash: 'SIGKILL of the database container, then start' },
    steps: steps.map((s) => ({ id: s.id, status: s.status })),
    diverged,
    undo,
    failure,
    health: 'not checked (the twin runs the database only)',
    cleanup,
    duration_ms: clock() - started,
  }
  const receipt = appendReceipt({ repoDir, keys, missionId: contract.id, kind: 'recovery_rehearsal', verdict, subject })
  return { verdict, ...subject, receipt: receipt.hash, seq: receipt.receipt.seq }
}
