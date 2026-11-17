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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { parseContract } from '../src/contract/parser.js'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { rehearse } from '../src/rehearsal/engine.js'
import { measureDatabase } from '../src/rehearsal/measure.js'
import { down, psql, up, writeNoPortsOverride } from '../src/rehearsal/compose.js'
import { authorizeMission, runMission } from '../src/run/mission.js'

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
    dangerReport = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target })
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
    await assert.rejects(runMission({ repoDir, contract: c.contract, contractHash: c.hash, target, publicKey: keys.publicKey }), (e) => e.code === 'NO_AUTHORIZATION')
    assert.deepEqual(await measureReal(), realBefore)
  })

  it('R13.3: the replanned additive migration rehearses SAFE and runs for real', async () => {
    unlinkSync(path.join(repoDir, 'demo/migrations/003_consolidate_orders.sql'))
    writeFileSync(path.join(repoDir, 'demo/migrations/003_add_order_status.sql'), SAFE)
    const c = writeContract('demo/migrations/003_add_order_status.sql')
    safeReport = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target })
    assert.equal(safeReport.verdict, 'SAFE', JSON.stringify(safeReport.evidence))
    assert.deepEqual(safeReport.schema_delta.added_columns, ['orders.status'])
    // R15.2 groundwork: both plans started from the same base state.
    assert.equal(safeReport.base_hash, dangerReport.base_hash)
    assert.notEqual(safeReport.plan_id, dangerReport.plan_id)

    const auth = await authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
    assert.match(auth.signature, /^[0-9a-f]{128}$/)
    const result = await runMission({ repoDir, contract: c.contract, contractHash: c.hash, target, publicKey: keys.publicKey })
    assert.equal(result.ok, true, JSON.stringify(result.steps))
    const real = await measureReal()
    assert.equal(real.tables.orders.rows, 3)
    assert.ok(real.columns.orders.some((col) => col.startsWith('status ')))
    // Single use: the same authorization cannot run twice.
    await assert.rejects(runMission({ repoDir, contract: c.contract, contractHash: c.hash, target, publicKey: keys.publicKey }), (e) => e.code === 'NO_AUTHORIZATION')
  })

  it('R14.5, R3.3: an UPDATE that keeps the row count still blocks authorization', async () => {
    writeFileSync(path.join(repoDir, 'demo/migrations/004_index.sql'), 'CREATE INDEX orders_patch_idx ON orders (patch_id);\n')
    const c = writeContract('demo/migrations/004_index.sql')
    const report = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target })
    assert.equal(report.verdict, 'SAFE')
    const r = await psql(realTarget, { sql: 'UPDATE orders SET quantity = quantity + 1 WHERE id = 1' })
    assert.equal(r.code, 0, r.stderr)
    await assert.rejects(
      authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys }),
      (e) => e.code === 'FIDELITY_MISMATCH' && e.detail.some((d) => d.component === 'base.postgres.pumpkin_patch.tables.orders.checksum')
    )
  })
})
