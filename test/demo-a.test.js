/**
 * Demo A end to end (R13.1 to R13.3, R2.6, R2.7, R3.3, R14.5, R15.1).
 *
 * Scripted agent, real Docker and Postgres, no credentials:
 *   dangerous migration -> rehearsal measures DATA LOSS -> authorization refused,
 *   real database untouched -> agent replans -> SAFE -> signed authorization ->
 *   real run -> authorization consumed -> drift with equal row count is blocked.
 *
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 * Receipts (R13.4) are not implemented yet (T16).
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { parseContract } from '../src/contract/parser.js'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { rehearse, reportPath } from '../src/rehearsal/engine.js'
import { measureDatabase } from '../src/rehearsal/measure.js'
import { down, psql, up, writeNoPortsOverride } from '../src/rehearsal/compose.js'
import { authorizeMission, runMission } from '../src/run/mission.js'
import { verifyChain } from '../src/receipts/chain.js'
import { checkPolicy } from '../src/receipts/policy.js'
import { comparePlans, verifySelection } from '../src/compare/select.js'

const enabled = process.platform === 'linux' || process.env.JRM_DOCKER_TESTS === '1'
const DEMO = new URL('../demo/', import.meta.url).pathname

const DANGEROUS = `-- "Consolidate" orders: keeps only large orders and drops the timestamp column.
CREATE TABLE orders_v2 AS SELECT id, patch_id, quantity FROM orders WHERE quantity >= 10;
DROP TABLE orders;
ALTER TABLE orders_v2 RENAME TO orders;
`
const SAFE = `-- Additive change: new column with a default, no rows or columns removed.
ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
`

function contractFor(file) {
  return {
    id: 'mission-demo-a',
    objective: 'Add order status tracking to the demo service',
    allowed_paths: ['demo/migrations/'],
    protected_tables: ['orders', 'patches'],
    time_limit_seconds: 300,
    irreversible_actions: [],
    plan: [{ id: 'migrate', tool: 'sql_migration', args: [file], reversibility: true }],
    resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] },
  }
}

describe('Demo A: DATA LOSS is measured and blocked, the safe replan runs', { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-a-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-a-keys-'))
  const target = {
    project: `jrm-demoa-real-${randomBytes(4).toString('hex')}`,
    composeFile: 'demo/docker-compose.yml',
    dbService: 'db',
    dbUser: 'demo_user',
    dbName: 'pumpkin_patch',
  }
  const realTarget = { ...target, composeFile: path.join(repoDir, target.composeFile), overrideFile: writeNoPortsOverride(['db', 'app']) }
  const measureReal = () => measureDatabase((sql) => psql(realTarget, { sql }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@demo.invalid', ...args], { cwd: repoDir, stdio: 'pipe' })
  const keys = loadOrCreateKeys(home)

  function writeContract(file) {
    const text = stringify(contractFor(file))
    writeFileSync(path.join(repoDir, 'justrunme.mission.yaml'), text)
    return parseContract(text)
  }

  before(async () => {
    mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
    copyFileSync(path.join(DEMO, 'docker-compose.yml'), path.join(repoDir, 'demo/docker-compose.yml'))
    for (const f of ['001_init.sql', '002_seed_data.sql']) copyFileSync(path.join(DEMO, 'migrations', f), path.join(repoDir, 'demo/migrations', f))
    writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\n')
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'demo base')
    // The "real" stack for this test: its own project, no published ports.
    await up(realTarget, ['db'])
    for (const f of ['001_init.sql', '002_seed_data.sql']) {
      const r = await psql(realTarget, { input: readFileSync(path.join(repoDir, 'demo/migrations', f)) })
      assert.equal(r.code, 0, r.stderr)
    }
  })

  after(async () => {
    await down(realTarget)
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  let dangerReport
  let safeReport

  it('R13.1: the dangerous migration rehearses as DATA LOSS with measured counts', async () => {
    writeFileSync(path.join(repoDir, 'demo/migrations/003_consolidate_orders.sql'), DANGEROUS)
    const c = writeContract('demo/migrations/003_consolidate_orders.sql')
    assert.equal(c.ok, true)
    const realBefore = await measureReal()
    dangerReport = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
    assert.equal(dangerReport.verdict, 'DATA LOSS')
    assert.deepEqual(dangerReport.tables.orders.rows_before, 3)
    assert.deepEqual(dangerReport.tables.orders.rows_after, 2)
    assert.ok(dangerReport.evidence.some((e) => e.kind === 'column_removed' && e.column === 'orders.created_at'))
    assert.ok(dangerReport.evidence.some((e) => e.kind === 'protected_rows_lost' && e.table === 'orders' && e.rows_after === 2))
    // R13.2: the real database was not touched by the rehearsal.
    assert.deepEqual(await measureReal(), realBefore)
    // R2.5: the rehearsal copy is gone.
    const left = execFileSync('docker', ['ps', '-a', '--filter', `name=${dangerReport.compose_project}`, '-q']).toString().trim()
    assert.equal(left, '')
  })

  it('R2.7, R13.2: authorization is refused for DATA LOSS and the real database is unchanged', async () => {
    const realBefore = await measureReal()
    const c = writeContract('demo/migrations/003_consolidate_orders.sql')
    await assert.rejects(authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys }), (e) => e.code === 'DATA_LOSS' && e.detail.length > 0)
    await assert.rejects(runMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys }), (e) => e.code === 'NO_AUTHORIZATION')
    assert.deepEqual(await measureReal(), realBefore)
  })

  it('PR #5 condition 1: a report edited to say SAFE is rejected (report signature)', async () => {
    const c = writeContract('demo/migrations/003_consolidate_orders.sql')
    const file = reportPath(repoDir, c.contract.id, dangerReport.plan_id)
    const forged = JSON.parse(readFileSync(file, 'utf8'))
    forged.verdict = 'SAFE'
    forged.evidence = []
    writeFileSync(file, JSON.stringify(forged))
    await assert.rejects(authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys }), (e) => e.code === 'REPORT_INVALID')
    writeFileSync(file, JSON.stringify(dangerReport)) // restore the genuine report
    assert.equal(existsSync(path.join(repoDir, '.justrunme/authorization.json')), false)
  })

  it('R13.3: the replanned additive migration rehearses SAFE and runs for real', async () => {
    unlinkSync(path.join(repoDir, 'demo/migrations/003_consolidate_orders.sql'))
    writeFileSync(path.join(repoDir, 'demo/migrations/003_add_order_status.sql'), SAFE)
    const c = writeContract('demo/migrations/003_add_order_status.sql')
    safeReport = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
    assert.equal(safeReport.verdict, 'SAFE', JSON.stringify(safeReport.evidence))
    assert.deepEqual(safeReport.schema_delta.added_columns, ['orders.status'])
    // R15.2 groundwork: both plans started from the same base state.
    assert.equal(safeReport.base_hash, dangerReport.base_hash)
    assert.notEqual(safeReport.plan_id, dangerReport.plan_id)

    // Two plans on the same state: authorization needs a comparison first.
    await assert.rejects(authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys }), (e) => e.code === 'COMPARISON_REQUIRED')

    // T17: counterfactual replay of both measured plans; the rule, not an agent, picks.
    const cmp = comparePlans({ repoDir, keys, missionId: c.contract.id, planIds: [dangerReport.plan_id, safeReport.plan_id] })
    assert.equal(cmp.comparison.ranking.recommended, safeReport.plan_id)
    assert.equal(cmp.comparison.ranking.decided_by, 'R15.4.1')
    assert.deepEqual(cmp.comparison.ranking.removed, [{ plan_id: dangerReport.plan_id, rule: 'R15.4.1', reason: 'verdict DATA LOSS' }])
    const danger = cmp.comparison.plans.find((p) => p.plan_id === dangerReport.plan_id)
    assert.equal(danger.rows_lost.orders, 1)
    const replay = verifySelection({ repoDir, home, publicKey: keys.publicKey, missionId: c.contract.id })
    assert.equal(replay.ok, true, JSON.stringify(replay.findings))
    assert.equal(replay.reports_rechecked, 2)

    const auth = await authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
    assert.match(auth.signature, /^[0-9a-f]{128}$/)
    assert.deepEqual(auth.selection, { mode: 'selected', receipt: cmp.receipt_hash })

    // PR #5 condition 1: the authorization does not fit another plan ...
    const otherPlan = { ...c.contract, plan: [{ ...c.contract.plan[0], args: ['demo/migrations/003_consolidate_orders.sql'] }] }
    await assert.rejects(runMission({ repoDir, contract: otherPlan, contractHash: 'sha256:' + '0'.repeat(64), target, keys }), (e) => e.code === 'AUTHORIZATION_INVALID')
    // ... nor another environment with identical data and images.
    const twin = { ...target, project: `jrm-demoa-twin-${randomBytes(4).toString('hex')}` }
    const twinReal = { ...realTarget, project: twin.project }
    try {
      await up(twinReal, ['db'])
      for (const f of ['001_init.sql', '002_seed_data.sql']) await psql(twinReal, { input: readFileSync(path.join(repoDir, 'demo/migrations', f)) })
      await assert.rejects(
        runMission({ repoDir, contract: c.contract, contractHash: c.hash, target: twin, keys }),
        (e) => e.code === 'FIDELITY_MISMATCH' && e.detail.some((d) => d.component === 'base.target.project')
      )
    } finally {
      await down(twinReal)
    }

    const result = await runMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
    assert.equal(result.ok, true, JSON.stringify(result.steps))
    const real = await measureReal()
    assert.equal(real.tables.orders.rows, 3)
    assert.ok(real.columns.orders.some((col) => col.startsWith('status ')))
    // Single use: the same authorization cannot run twice.
    await assert.rejects(runMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys }), (e) => e.code === 'NO_AUTHORIZATION')
  })

  it('R14.5, R3.3: an UPDATE that keeps the row count still blocks authorization', async () => {
    writeFileSync(path.join(repoDir, 'demo/migrations/004_index.sql'), 'CREATE INDEX orders_patch_idx ON orders (patch_id);\n')
    const c = writeContract('demo/migrations/004_index.sql')
    const report = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
    assert.equal(report.verdict, 'SAFE')
    const r = await psql(realTarget, { sql: 'UPDATE orders SET quantity = quantity + 1 WHERE id = 1' })
    assert.equal(r.code, 0, r.stderr)
    await assert.rejects(
      authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys }),
      (e) => e.code === 'FIDELITY_MISMATCH' && e.detail.some((d) => d.component === 'base.postgres.pumpkin_patch.tables.orders.checksum')
    )
  })

  it('R13.4: the block, the refusals and the real run are all in one signed chain that verifies', () => {
    const v = verifyChain({ repoDir, home, publicKey: keys.publicKey, missionId: 'mission-demo-a' })
    assert.equal(v.ok, true, JSON.stringify(v.findings))
    assert.equal(checkPolicy(v.receipts).ok, true, JSON.stringify(checkPolicy(v.receipts).findings))
    const story = v.receipts.map((r) => `${r.kind}:${r.verdict}`)
    assert.equal(story[0], 'rehearsal:DATA LOSS')
    assert.ok(v.receipts.some((r) => r.kind === 'authorization_refused' && r.subject.code === 'DATA_LOSS'))
    assert.ok(v.receipts.some((r) => r.kind === 'authorization_refused' && r.subject.code === 'REPORT_INVALID'))
    assert.ok(v.receipts.some((r) => r.kind === 'run_refused' && r.subject.code === 'FIDELITY_MISMATCH'))
    const runs = v.receipts.filter((r) => r.kind === 'run_result')
    assert.equal(runs.length, 1)
    assert.equal(runs[0].verdict, 'completed')
    assert.ok(story.indexOf('rehearsal:SAFE') < story.indexOf('plan_selected:selected'))
    assert.ok(story.indexOf('plan_selected:selected') < story.indexOf('authorization_issued:allow'))
    assert.ok(story.indexOf('authorization_issued:allow') < story.indexOf('run_result:completed'))
  })

  const worktrees = () => execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir }).toString().split('\n').filter((l) => l.startsWith('worktree ')).length
  const overrideDirs = () => readdirSync(os.tmpdir()).filter((d) => d.startsWith('jrm-override-')).length

  it('PR #5 condition 2, R2.4: a failing step leaves no container, volume, network or worktree', async () => {
    writeFileSync(path.join(repoDir, 'demo/migrations/005_broken.sql'), 'ALTER TABLE no_such_table ADD COLUMN x INT;\n')
    const c = writeContract('demo/migrations/005_broken.sql')
    const realBefore = await measureReal()
    const overridesBefore = overrideDirs()
    const report = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
    assert.equal(report.verdict, 'FAILED')
    assert.match(report.steps[0].detail, /no_such_table/)
    assert.deepEqual(report.cleanup, { containers: 0, volumes: 0, networks: 0, worktree_removed: true, clean: true })
    assert.equal(worktrees(), 1)
    assert.equal(overrideDirs(), overridesBefore)
    assert.deepEqual(await measureReal(), realBefore)
    await assert.rejects(authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys }), (e) => e.code === 'NOT_SAFE')
  })

  it('PR #5 condition 2, R2.4: a rehearsal whose Compose copy cannot start cleans up and reports why', async () => {
    // Uncommitted edit that only breaks the copy: the running real container is not recreated.
    const composePath = path.join(repoDir, 'demo/docker-compose.yml')
    const original = readFileSync(composePath, 'utf8')
    writeFileSync(composePath, original.replace('image: postgres:16.3-alpine', 'image: postgres:0.0-jrm-does-not-exist'))
    try {
      const c = writeContract('demo/migrations/004_index.sql')
      const report = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
      assert.equal(report.verdict, 'FAILED')
      assert.equal(report.evidence[0].kind, 'rehearsal_error')
      assert.equal(report.cleanup.clean, true, JSON.stringify(report.cleanup))
      assert.equal(worktrees(), 1)
    } finally {
      writeFileSync(composePath, original)
    }
  })
})
