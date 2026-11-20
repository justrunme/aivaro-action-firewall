/**
 * Chaos Twin Lite: rehearse the recovery itself before relying on it.
 *
 * 1. A disposable twin: a copy of the workspace (git worktree), an isolated Compose project
 *    with an internal network and no published ports, and a pg_dump of the real database
 *    loaded into it. The real database is only read (pg_dump and the fingerprint).
 * 2. The same pre-run capture the real run makes (captureState), inside the twin, signed by
 *    a throwaway key whose directory is removed afterwards.
 * 3. The plan runs in the twin up to the fault point (all steps by default), then the
 *    database container is killed (SIGKILL) and started again.
 * 4. Divergence: the database (schema, row counts, checksums) and the captured workspace
 *    files are compared with the capture. A recovery from no change proves nothing.
 * 5. The same undo (undoMission) and recovery verification the operator would run.
 * 6. One receipt in the real mission chain, signed by the operator key: fault, divergence,
 *    undo, verification, plan file hashes and the base hash of the real state.
 *
 * Verdicts: RECOVERY PROVEN, RECOVERY UNVERIFIED, RECOVERY FAILED, NOTHING TO RECOVER, FAILED.
 * Proven is only what the capture covers: files under allowed_paths, contract config files,
 * the named database, container images. Not checked: the health endpoint (the twin runs the
 * database only) and external effects. Shell steps get COMPOSE_PROJECT_NAME and COMPOSE_FILE of
 * the twin; a step that names the real project explicitly is not prevented (same OS user).
 *
 * Every resource is owned by the lifecycle the moment it exists and released on any outcome
 * (src/chaos/lifecycle.js); `deps` exists so that tests can inject failures at each step.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureState } from '../capture/capture.js'
import { verifyFiles } from '../capture/files.js'
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
import { createLifecycle } from './lifecycle.js'

export class ChaosRefused extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export const TWIN_PREFIX = 'jrm-twin-'
const KEYS_PREFIX = 'jrm-twin-keys-'

/** What differs from the capture: database (schema, row counts, table checksums) and captured files. */
export function divergence(before, after, fileChecks = []) {
  const tables = [...new Set([...Object.keys(before?.tables ?? {}), ...Object.keys(after?.tables ?? {})])].sort()
  const rows = tables.filter((t) => (before.tables[t]?.rows ?? null) !== (after.tables[t]?.rows ?? null))
  const checksums = tables.filter((t) => (before.tables[t]?.checksum ?? null) !== (after.tables[t]?.checksum ?? null))
  const schema = before?.schema_hash !== after?.schema_hash
  const files = fileChecks.filter((c) => !c.ok).map((c) => `${c.check === 'file_absent' ? 'added' : 'changed'}: ${c.resource}`)
  return {
    changed: schema || rows.length > 0 || checksums.length > 0 || files.length > 0,
    schema_changed: schema,
    tables_with_other_rows: rows,
    tables_with_other_checksums: checksums,
    files_changed: files.slice(0, 20),
    files_changed_count: files.length,
  }
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

/** Removes a directory only if it is one this module made: directly under the temp directory, with its prefix. */
function removeOwnDir(dir, prefix) {
  const tmp = realpathSync(os.tmpdir())
  if (path.dirname(dir) !== tmp || !path.basename(dir).startsWith(prefix)) throw new Error(`refusing to remove ${path.basename(dir)}: not a directory this rehearsal made`)
  rmSync(dir, { recursive: true, force: true })
}

const DEFAULT_DEPS = { computeFingerprint, createWorkspaceCopy, loadOrCreateKeys, writeNoPortsOverride, up, down, assertIsolated, dump, psql, planRoleOf, captureState, executeSteps, crash, measureDatabase, verifyFiles, undoMission, leftovers }

/**
 * @param {object} a
 * @param {string} a.repoDir real workspace
 * @param {any} a.contract
 * @param {string} a.contractHash
 * @param {import('../rehearsal/compose.js').Target} a.target real target, composeFile relative to repoDir
 * @param {{ privateKey: any, publicKey: any, home: string }} a.keys operator keys: only the final receipt
 * @param {number | null} [a.afterStep] steps run before the crash; default: every step
 * @param {(twin: any) => unknown} [a.inspect] called with the twin target once it is isolated and loaded (tests)
 * @param {Partial<typeof DEFAULT_DEPS>} [a.deps] replacements for tests
 */
export async function rehearseRecovery({ repoDir, contract, contractHash, target, keys, afterStep = null, inspect = null, deps = {}, clock = Date.now }) {
  const d = { ...DEFAULT_DEPS, ...deps }
  const plan = contract.plan
  const k = afterStep ?? plan.length
  if (!Number.isInteger(k) || k < 0 || k > plan.length) throw new ChaosRefused('FAULT_INVALID', `the fault point must be a step count from 0 to ${plan.length}`)
  const chain = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId: contract.id })
  if (!chain.ok) throw new ChaosRefused('CHAIN_INVALID', `receipt chain does not verify: ${chain.findings[0].problem}; nothing was run`)

  const started = clock()
  const realTarget = { ...target, composeFile: path.resolve(repoDir, target.composeFile) }
  const snapshot = snapshotPlanFiles(plan, repoDir)
  const project = `${TWIN_PREFIX}${contract.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}-${randomBytes(4).toString('hex')}`
  const life = createLifecycle()
  const made = { copy: null, home: null, override: null, composeStarted: false }

  let base = null
  let failure = null
  let steps = []
  let diverged = null
  let undo = null
  try {
    base = baseHash(await d.computeFingerprint({ repoDir, target: realTarget, contract, contractHash }))
    const copy = await d.createWorkspaceCopy(repoDir)
    made.copy = copy.dir
    life.own('workspace copy', () => copy.remove())
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), KEYS_PREFIX)))
    made.home = home
    life.own('throwaway key directory', () => removeOwnDir(home, KEYS_PREFIX))
    // A throwaway key: the twin's capture, undo and verification receipts never touch the operator's chain or key directory.
    const twinKeys = d.loadOrCreateKeys(home)
    const override = d.writeNoPortsOverride([target.dbService], { isolate: true })
    made.override = override
    life.own('compose override', () => rmSync(path.dirname(override), { recursive: true, force: true }))
    const twin = { ...target, project, composeFile: path.resolve(copy.dir, target.composeFile), overrideFile: override }
    // Registered before `up`: a half-started project is still stopped. Only this rehearsal's own project name.
    life.own('compose project', async () => {
      const r = await d.down(twin)
      if (r && r.code !== 0) throw new Error(`docker compose down exited ${r.code}`)
    })
    made.composeStarted = true
    await d.up(twin, [target.dbService])
    await d.assertIsolated(twin)
    if (target.planUser) {
      const role = await d.planRoleOf((sql) => d.psql(realTarget, { sql }), target.planUser)
      if (!role.exists) throw new Error(`the plan role ${target.planUser} does not exist in the real database`)
      if ((await d.psql(twin, { input: createRoleSql(role) })).code !== 0) throw new Error('creating the plan role in the twin failed')
    }
    const data = await d.dump(realTarget, { privileges: Boolean(target.planUser) })
    if ((await d.psql(twin, { input: data })).code !== 0) throw new Error('loading the twin database failed')
    if (inspect) await inspect(twin)

    const manifest = await d.captureState({ repoDir: copy.dir, contract, target: twin, keys: twinKeys })
    steps = await d.executeSteps({ plan: plan.slice(0, k), cwd: copy.dir, target: twin, mode: 'rehearsal' })
    await d.crash(twin)
    diverged = divergence(manifest.postgres[0].measurement, await d.measureDatabase((sql) => d.psql(twin, { sql })), d.verifyFiles(copy.dir, manifest.files))
    const u = await d.undoMission({ repoDir: copy.dir, missionId: contract.id, captureId: manifest.capture_id, target: { ...twin, composeFile: target.composeFile }, keys: twinKeys, health: null })
    const v = u.verification
    undo = {
      status: u.status,
      resources: u.resources.map((r) => ({ resource: r.resource, status: r.status })),
      verification: { status: v.status, checks: v.checks.length, checked: [...new Set(v.checks.map((c) => c.check))].sort(), failed: v.failed.slice(0, 20).map((c) => ({ check: c.check, resource: c.resource })), not_checked: (v.not_checked ?? []).map((c) => ({ check: c.check, resource: c.resource })), coverage: v.coverage ?? null },
    }
  } catch (err) {
    failure = errorSummary(String(err?.message ?? err))
  }
  const released = await life.releaseAll()
  const left = made.composeStarted ? await d.leftovers(project).catch(() => null) : { containers: 0, volumes: 0, networks: 0 }
  const cleanup = {
    released,
    leftovers: left,
    worktree_removed: made.copy ? !existsSync(made.copy) : true,
    keys_removed: made.home ? !existsSync(made.home) : true,
  }
  cleanup.clean = released.every((r) => r.released) && left !== null && left.containers + left.volumes + left.networks === 0 && cleanup.worktree_removed && cleanup.keys_removed
  const verdict = chaosVerdict({ failure, diverged: diverged?.changed === true, undoStatus: undo?.status })

  const subject = {
    plan_id: planId(contract),
    files_hash: hashValue(snapshot.files),
    base_hash: base,
    twin_project: project,
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
