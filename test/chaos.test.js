/**
 * Chaos Twin Lite (src/chaos): divergence, verdicts, the cleanup lifecycle under injected
 * failures, and how ProofDebt counts a recovery rehearsal. No Docker: every external step of
 * rehearseRecovery is replaced through `deps`; test/demo-chaos.test.js runs the real thing.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chaosVerdict, divergence, rehearseRecovery } from '../src/chaos/twin.js'
import { createLifecycle } from '../src/chaos/lifecycle.js'
import { proofDebt } from '../src/evidence/proofdebt.js'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { receiptHash, verifyChain } from '../src/receipts/chain.js'
import { checkPolicy } from '../src/receipts/policy.js'

const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = (p) => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), p)))
  dirs.push(d)
  return d
}
const MEASURE = { schema_hash: 'sha256:s', tables: { orders: { rows: 3, checksum: 'a' }, patches: { rows: 5, checksum: 'b' } } }
const CONTRACT = { id: 'mission-chaos-test', plan: [{ id: 's1', tool: 'shell', args: ['echo', 'x'], reversibility: true }], protected_tables: ['orders'], irreversible_actions: [], resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] }, allowed_paths: ['demo/'] }
const TARGET = { project: 'jrm-real', composeFile: 'demo/docker-compose.yml', dbService: 'db', dbUser: 'demo_user', dbName: 'pumpkin_patch' }

/** Fake external steps; `log` records every acquire and release, `fail` makes one step throw. */
function fakes({ after = MEASURE, fileChecks = [], undoStatus = 'RECOVERED', fail = null, downFails = false } = {}) {
  const log = []
  const step = (name, value) => async (...args) => {
    log.push(name)
    if (fail === name) throw new Error(`injected failure at ${name}`)
    return typeof value === 'function' ? value(...args) : value
  }
  const copyDir = tmp('jrm-chaos-copy-')
  const overrideDir = tmp('jrm-chaos-override-')
  const deps = {
    computeFingerprint: step('fingerprint', { base: { head: 'h' } }),
    createWorkspaceCopy: step('copy', { dir: copyDir, remove: async () => { log.push('release copy'); rmSync(copyDir, { recursive: true, force: true }) } }),
    loadOrCreateKeys: (home) => { log.push('keys'); if (fail === 'keys') throw new Error('injected failure at keys'); return loadOrCreateKeys(home) },
    writeNoPortsOverride: () => { log.push('override'); if (fail === 'override') throw new Error('injected failure at override'); return path.join(overrideDir, 'no-ports.override.yml') },
    up: step('up'),
    down: async () => { log.push('release compose'); if (downFails) throw new Error('docker compose down failed'); return { code: 0 } },
    assertIsolated: step('isolated'),
    dump: step('dump', 'SQL'),
    psql: step('psql', { code: 0, stdout: '', stderr: '' }),
    planRoleOf: step('role', { exists: true }),
    captureState: step('capture', { capture_id: 'cap-20261120000000-abcdef', postgres: [{ measurement: MEASURE }], files: { files: [], roots: [] } }),
    executeSteps: step('steps', [{ id: 's1', status: 'ok' }]),
    crash: step('crash'),
    measureDatabase: step('measure', after),
    verifyFiles: () => fileChecks,
    undoMission: step('undo', { status: undoStatus, resources: [{ resource: 'postgres', status: 'succeeded' }], verification: { status: 'PASS', checks: [{ check: 'row_count', ok: true }], failed: [], not_checked: [], coverage: null } }),
    leftovers: step('leftovers', { containers: 0, volumes: 0, networks: 0 }),
  }
  return { deps, log, copyDir, overrideDir }
}
function setup() {
  const repoDir = tmp('jrm-chaos-ws-')
  mkdirSync(path.join(repoDir, 'demo'))
  const keys = loadOrCreateKeys(tmp('jrm-chaos-home-'))
  return { repoDir, keys, run: (deps) => rehearseRecovery({ repoDir, contract: CONTRACT, contractHash: 'sha256:c', target: TARGET, keys, deps }) }
}

describe('Chaos Twin: divergence and verdict', () => {
  it('a file-only change is a change, so it is never NOTHING TO RECOVER', () => {
    const d = divergence(MEASURE, MEASURE, [{ check: 'file_sha256', resource: 'demo/app.config.json', ok: false }, { check: 'file_absent', resource: 'demo/new.txt', ok: false }, { check: 'file_sha256', resource: 'demo/same.txt', ok: true }])
    assert.equal(d.changed, true)
    assert.equal(d.schema_changed, false)
    assert.deepEqual(d.files_changed, ['changed: demo/app.config.json', 'added: demo/new.txt'])
    assert.equal(chaosVerdict({ failure: null, diverged: d.changed, undoStatus: 'RECOVERED' }), 'RECOVERY PROVEN')
  })

  it('database differences are found by schema, rows and checksums', () => {
    const d = divergence(MEASURE, { schema_hash: 'sha256:s', tables: { orders: { rows: 3, checksum: 'z' }, patches: { rows: 4, checksum: 'b' } } })
    assert.deepEqual([d.changed, d.tables_with_other_rows, d.tables_with_other_checksums], [true, ['patches'], ['orders']])
    assert.equal(divergence(MEASURE, MEASURE, []).changed, false)
  })

  it('a no-op plan gives NOTHING TO RECOVER, signed, and the twin is cleaned up', async () => {
    const s = setup()
    const f = fakes()
    const r = await s.run(f.deps)
    assert.equal(r.verdict, 'NOTHING TO RECOVER')
    assert.equal(r.cleanup.clean, true)
    const c = verifyChain({ repoDir: s.repoDir, home: s.keys.home, publicKey: s.keys.publicKey, missionId: CONTRACT.id })
    assert.equal(c.ok, true)
    assert.deepEqual([c.receipts.at(-1).kind, c.receipts.at(-1).verdict], ['recovery_rehearsal', 'NOTHING TO RECOVER'])
    assert.deepEqual(checkPolicy(c.receipts).findings, [])
  })

  it('a database change that the undo restores gives RECOVERY PROVEN', async () => {
    const s = setup()
    const r = await s.run(fakes({ after: { ...MEASURE, tables: { ...MEASURE.tables, orders: { rows: 2, checksum: 'x' } } } }).deps)
    assert.equal(r.verdict, 'RECOVERY PROVEN')
    assert.deepEqual(r.diverged.tables_with_other_rows, ['orders'])
  })

  it('a change the undo does not restore gives RECOVERY FAILED', async () => {
    const s = setup()
    const r = await s.run(fakes({ fileChecks: [{ check: 'file_sha256', resource: 'demo/a', ok: false }], undoStatus: 'NOT_RECOVERED' }).deps)
    assert.equal(r.verdict, 'RECOVERY FAILED')
  })
})

describe('Chaos Twin: cleanup after injected failures', () => {
  for (const at of ['copy', 'keys', 'override', 'up', 'dump', 'capture', 'steps', 'crash', 'undo']) {
    it(`failure at ${at}: FAILED with that error, every resource made so far released, nothing left`, async () => {
      const s = setup()
      const f = fakes({ fail: at })
      const r = await s.run(f.deps)
      assert.equal(r.verdict, 'FAILED')
      assert.match(r.failure, new RegExp(`injected failure at ${at}`))
      assert.ok(r.cleanup.released.every((x) => x.released), JSON.stringify(r.cleanup.released))
      const made = r.cleanup.released.map((x) => x.resource)
      if (at !== 'copy') assert.ok(made.includes('workspace copy') && f.log.includes('release copy'))
      if (!['copy', 'keys', 'override'].includes(at)) assert.ok(made.includes('compose project') && f.log.includes('release compose'))
      assert.equal(r.cleanup.worktree_removed, true)
      assert.equal(r.cleanup.keys_removed, true)
      assert.equal(r.cleanup.clean, true)
    })
  }

  it('a failing docker compose down does not skip the other releases, and the run is not clean', async () => {
    const s = setup()
    const f = fakes({ fail: 'steps', downFails: true })
    const r = await s.run(f.deps)
    assert.match(r.failure, /injected failure at steps/, 'the original failure is kept')
    const byName = Object.fromEntries(r.cleanup.released.map((x) => [x.resource, x]))
    assert.equal(byName['compose project'].released, false)
    assert.match(byName['compose project'].error, /docker compose down failed/)
    assert.equal(byName['workspace copy'].released, true)
    assert.equal(byName['throwaway key directory'].released, true)
    assert.equal(existsSync(f.copyDir), false)
    assert.equal(r.cleanup.clean, false)
  })

  it('the lifecycle releases in reverse order and reports, never throws', async () => {
    const life = createLifecycle()
    const order = []
    life.own('a', () => order.push('a'))
    life.own('b', () => { throw new Error('b failed') })
    life.own('c', () => order.push('c'))
    const r = await life.releaseAll()
    assert.deepEqual(order, ['c', 'a'])
    assert.deepEqual(r.map((x) => [x.resource, x.released]), [['c', true], ['b', false], ['a', true]])
    assert.deepEqual(await life.releaseAll(), [], 'released only once')
  })
})

describe('ProofDebt: a recovery rehearsal counts only on its own base', () => {
  const twin = (base) => {
    const r = { kind: 'recovery_rehearsal', verdict: 'RECOVERY PROVEN', seq: 0, timestamp: '2026-11-20T12:00:00.000Z', subject: { plan_id: 'plan-1', base_hash: base, fault: { after_step: 1, of_steps: 1 }, undo: { verification: { checked: ['row_count'] } } }, refs: {} }
    return [r]
  }
  it('same base: verified, recovery rehearsed', () => {
    const d = proofDebt({ receipts: twin('sha256:aaaa'), planIdNow: 'plan-1', currentBase: 'sha256:aaaa' })
    assert.ok(d.verified.some((v) => v.id === 'recovery_rehearsal' && v.receipt.hash === receiptHash(twin('sha256:aaaa')[0])))
    assert.deepEqual([d.recovery_readiness.recovery_rehearsed, d.recovery_readiness.recovery_rehearsal_state], [true, 'current'])
  })
  it('stale base: an older rehearsal for a different baseline, not verified', () => {
    const d = proofDebt({ receipts: twin('sha256:aaaa'), planIdNow: 'plan-1', currentBase: 'sha256:bbbb' })
    assert.ok(!d.verified.some((v) => v.id === 'recovery_rehearsal'))
    assert.equal(d.not_verified.find((n) => n.id === 'recovery_rehearsal').why, 'RECOVERY_REHEARSED_ON_OTHER_BASE')
    assert.deepEqual([d.recovery_readiness.recovery_rehearsed, d.recovery_readiness.recovery_rehearsal_state], [false, 'other_base'])
  })
  it('base not checkable: said so, not counted', () => {
    const d = proofDebt({ receipts: twin('sha256:aaaa'), planIdNow: 'plan-1', currentBase: null, baseCheckError: 'no target' })
    assert.equal(d.not_verified.find((n) => n.id === 'recovery_rehearsal').why, 'CURRENT_BASE_NOT_CHECKED')
    assert.equal(d.recovery_readiness.recovery_rehearsed, false)
  })
  it('a rehearsal of another plan does not count', () => {
    const d = proofDebt({ receipts: twin('sha256:aaaa'), planIdNow: 'plan-2', currentBase: 'sha256:aaaa' })
    assert.equal(d.not_verified.find((n) => n.id === 'recovery_rehearsal').why, 'RECOVERY_NOT_REHEARSED')
  })
})
