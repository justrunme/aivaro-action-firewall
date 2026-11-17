/**
 * T21/T22 against real Docker and Postgres, through the MCP server only: the
 * agent proposes a dangerous plan, is told what was measured, proposes a revised
 * plan, gets SAFE, and the choice and every decision are in one verifying chain.
 * (Approval and the real run are the next PR.)
 *
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { measureDatabase } from '../src/rehearsal/measure.js'
import { down, psql, up, writeNoPortsOverride } from '../src/rehearsal/compose.js'
import { startServer } from './support/mcp-stdio.js'

const enabled = process.platform === 'linux' || process.env.JRM_DOCKER_TESTS === '1'
const DEMO = new URL('../demo/', import.meta.url).pathname
const ENTRY = new URL('../src/mcp/server.js', import.meta.url).pathname

const DANGEROUS = 'CREATE TABLE orders_v2 AS SELECT id, patch_id, quantity FROM orders WHERE quantity >= 10;\nDROP TABLE orders;\nALTER TABLE orders_v2 RENAME TO orders;\n'
const SAFE = "ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'new';\n"

describe('Demo MCP: an agent is told why its plan was denied and revises it', { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-mcp-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-mcp-keys-'))
  const project = `jrm-demomcp-${randomBytes(4).toString('hex')}`
  const real = { project, composeFile: path.join(repoDir, 'demo/docker-compose.yml'), dbService: 'db', dbUser: 'demo_user', dbName: 'pumpkin_patch', overrideFile: writeNoPortsOverride(['db', 'app']) }
  const measureReal = () => measureDatabase((sql) => psql(real, { sql }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@demo.invalid', ...args], { cwd: repoDir, stdio: 'pipe' })
  let server

  before(async () => {
    mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
    copyFileSync(path.join(DEMO, 'docker-compose.yml'), path.join(repoDir, 'demo/docker-compose.yml'))
    for (const f of ['001_init.sql', '002_seed_data.sql']) copyFileSync(path.join(DEMO, 'migrations', f), path.join(repoDir, 'demo/migrations', f))
    writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\n')
    writeFileSync(path.join(repoDir, 'justrunme.target.json'), JSON.stringify({ project, compose_file: 'demo/docker-compose.yml', db_service: 'db', db_user: 'demo_user', db_name: 'pumpkin_patch' }))
    writeFileSync(
      path.join(repoDir, 'justrunme.mission.yaml'),
      stringify({
        id: 'mission-demo-mcp',
        objective: 'Add order status tracking to the demo service',
        allowed_paths: ['demo/migrations/'],
        protected_tables: ['orders', 'patches'],
        time_limit_seconds: 300,
        irreversible_actions: [],
        plan: [{ id: 'placeholder', tool: 'sql_migration', args: ['demo/migrations/001_init.sql'], reversibility: true }],
        resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] },
      })
    )
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'demo base')
    await up(real, ['db'])
    for (const f of ['001_init.sql', '002_seed_data.sql']) {
      const r = await psql(real, { input: readFileSync(path.join(repoDir, 'demo/migrations', f)) })
      assert.equal(r.code, 0, r.stderr)
    }
    const env = { ...process.env, JUSTRUNME_HOME: home }
    delete env.DOCKER_DEFAULT_PLATFORM
    execFileSync(process.execPath, [new URL('../src/cli/index.js', import.meta.url).pathname, 'keys', 'init'], { env, stdio: 'pipe' })
    server = startServer({ cwd: repoDir, entry: ENTRY, env })
    await server.initialize()
  })

  after(async () => {
    server?.close()
    await down(real)
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('rehearse -> DENIED with measurements -> revise -> rehearse -> SAFE -> compare -> receipts verify', async () => {
    const before = await measureReal()

    writeFileSync(path.join(repoDir, 'demo/migrations/003_consolidate_orders.sql'), DANGEROUS)
    const first = await server.call('rehearse', { migrations: ['demo/migrations/003_consolidate_orders.sql'] })
    assert.equal(first.isError, false, JSON.stringify(first.payload))
    const denied = first.payload
    assert.deepEqual([denied.status, denied.verdict, denied.reason, denied.next_action], ['DENIED', 'DATA LOSS', 'DATA_LOSS', 'REVISE_AND_REHEARSE'])
    assert.equal(denied.impact.rows_lost.orders, 1)
    // The consolidation also drops the columns it did not copy: the agent is told about both.
    const rows = denied.remediation.constraints.find((c) => c.kind === 'rows_preserved')
    assert.equal(rows.table, 'orders')
    assert.equal(rows.measured.rows_before - rows.measured.rows_after, 1)
    assert.ok(denied.remediation.constraints.some((c) => c.kind === 'column_preserved' && c.column.startsWith('orders.')), JSON.stringify(denied.remediation.constraints))
    assert.deepEqual(denied.attempts, { used: 1, limit: 8 })
    assert.equal(denied.cleanup_clean, true)
    assert.deepEqual(await measureReal(), before, 'the real database was not touched by the rehearsal')

    // The agent revises: removes the dangerous file, writes an additive one.
    unlinkSync(path.join(repoDir, 'demo/migrations/003_consolidate_orders.sql'))
    writeFileSync(path.join(repoDir, 'demo/migrations/003_add_order_status.sql'), SAFE)
    const second = await server.call('rehearse', { migrations: ['demo/migrations/003_add_order_status.sql'] })
    assert.equal(second.isError, false, JSON.stringify(second.payload))
    const safe = second.payload
    assert.deepEqual([safe.status, safe.verdict, safe.reason, safe.remediation, safe.next_action], ['SAFE', 'SAFE', null, null, 'REQUEST_APPROVAL'])
    assert.notEqual(safe.plan_id, denied.plan_id)
    assert.deepEqual(safe.attempts, { used: 2, limit: 8 })
    assert.deepEqual(await measureReal(), before)

    // Both reports stay readable, as signed measurements.
    const again = await server.call('get_impact_report', { plan_id: denied.plan_id })
    assert.deepEqual([again.payload.status, again.payload.reason, again.payload.impact.rows_lost.orders], ['DENIED', 'DATA_LOSS', 1])
    assert.equal((await server.call('get_impact_report', { plan_id: safe.plan_id })).payload.status, 'SAFE')
    assert.equal((await server.call('get_impact_report', { plan_id: 'plan-ffffffffffff' })).payload.error.code, 'NO_REPORT')

    const cmp = await server.call('compare', {})
    assert.equal(cmp.isError, false, JSON.stringify(cmp.payload))
    assert.deepEqual([cmp.payload.status, cmp.payload.recommended], ['RECOMMENDED', safe.plan_id])

    const receipt = await server.call('get_receipt', {})
    assert.equal(receipt.payload.chain_ok, true)
    const replay = await server.call('replay_mission', {})
    assert.deepEqual([replay.payload.status, replay.payload.ok], ['PASS', true])
    assert.equal(replay.payload.selections.length, 1)
    const text = JSON.stringify([denied, safe, cmp.payload, replay.payload])
    assert.ok(!text.includes(repoDir) && !text.includes(home), 'no local path in anything the agent sees')
  })
})
