/**
 * T25 mechanism test, against real Docker and Postgres: a migration whose text shows
 * no danger, and a legacy trigger that exists only in the database.
 *
 *   - no file of the workspace mentions a trigger, a DELETE, a DROP or a TRUNCATE;
 *   - the rehearsal (pg_dump of the real database into a disposable copy) fires the
 *     trigger, measures 1 lost order and denies; the real database is unchanged;
 *   - a revision measured by rehearsal can be SAFE (here a prepared one: this shows the
 *     loop is not impossible; it is not evidence about any agent);
 *   - without JustRunMe, the same SQL applied directly loses order 2.
 *
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { measureDatabase } from '../src/rehearsal/measure.js'
import { down, psql, up, writeNoPortsOverride } from '../src/rehearsal/compose.js'
import { LEGACY_TRIGGER_SQL, MIGRATION_FILE, MIGRATION_SQL, ORDERS_OF_TARGET } from '../scripts/scenarios/hidden-trigger.js'
import { startServer } from './support/mcp-stdio.js'

const enabled = process.platform === 'linux' || process.env.JRM_DOCKER_TESTS === '1'
const DEMO = new URL('../demo/', import.meta.url).pathname
const ENTRY = new URL('../src/mcp/server.js', import.meta.url).pathname
const CLI = new URL('../src/cli/index.js', import.meta.url).pathname
const PASSPHRASE = randomBytes(18).toString('hex')
const PREPARED_FIX = 'ALTER TABLE patches DISABLE TRIGGER USER;\nUPDATE patches SET available_count = 0 WHERE id = 1;\nALTER TABLE patches ENABLE TRIGGER USER;\n'

describe('T25 mechanism: the SQL looks safe, the database is not', { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-hidden-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-hidden-keys-'))
  const project = `jrm-demohid-${randomBytes(4).toString('hex')}`
  const real = { project, composeFile: path.join(repoDir, 'demo/docker-compose.yml'), dbService: 'db', dbUser: 'demo_user', dbName: 'pumpkin_patch', overrideFile: writeNoPortsOverride(['db', 'app']) }
  const measureReal = () => measureDatabase((sql) => psql(real, { sql }))
  const orderIds = async () => (await psql(real, { sql: 'SELECT id FROM orders ORDER BY id' })).stdout.trim().split('\n').map(Number)
  const git = (...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@demo.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repoDir, stdio: 'pipe' })
  const env = () => {
    const e = { ...process.env, JUSTRUNME_HOME: home }
    delete e.DOCKER_DEFAULT_PLATFORM
    delete e.JUSTRUNME_APPROVER_PASSPHRASE
    return e
  }
  let server

  before(async () => {
    mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
    copyFileSync(path.join(DEMO, 'docker-compose.yml'), path.join(repoDir, 'demo/docker-compose.yml'))
    for (const f of ['001_init.sql', '002_seed_data.sql']) copyFileSync(path.join(DEMO, 'migrations', f), path.join(repoDir, 'demo/migrations', f))
    writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\n')
    writeFileSync(path.join(repoDir, 'justrunme.target.json'), JSON.stringify({ project, compose_file: 'demo/docker-compose.yml', db_service: 'db', db_user: 'demo_user', db_name: 'pumpkin_patch' }))
    writeFileSync(path.join(repoDir, 'justrunme.mission.yaml'), stringify({
      id: 'mission-demo-hidden',
      objective: 'Mark a sold-out patch without losing orders',
      allowed_paths: ['demo/migrations/'],
      protected_tables: ['orders', 'patches'],
      time_limit_seconds: 300,
      irreversible_actions: [],
      plan: [{ id: 'placeholder', tool: 'sql_migration', args: ['demo/migrations/001_init.sql'], reversibility: true }],
      resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] },
    }))
    writeFileSync(path.join(repoDir, MIGRATION_FILE), MIGRATION_SQL)
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'demo base')
    await up(real, ['db'])
    for (const f of ['001_init.sql', '002_seed_data.sql']) {
      const r = await psql(real, { input: readFileSync(path.join(repoDir, 'demo/migrations', f)) })
      assert.equal(r.code, 0, r.stderr)
    }
    // Installed in the database only, the way a hand-made production change is.
    const t = await psql(real, { input: LEGACY_TRIGGER_SQL })
    assert.equal(t.code, 0, t.stderr)
    const keys = spawnSync(process.execPath, [CLI, 'keys', 'init'], { cwd: repoDir, env: env(), encoding: 'utf8' })
    assert.equal(keys.status, 0, keys.stdout)
    const approver = spawnSync(process.execPath, [CLI, 'approver', 'init'], { cwd: repoDir, env: { ...env(), JUSTRUNME_APPROVER_PASSPHRASE: PASSPHRASE }, encoding: 'utf8' })
    assert.equal(approver.status, 0, approver.stdout)
    server = startServer({ cwd: repoDir, entry: ENTRY, env: env() })
    await server.initialize()
  })

  after(async () => {
    server?.close()
    await down(real)
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('no file of the workspace shows the danger', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: repoDir, encoding: 'utf8' }).trim().split('\n')
    for (const f of files) assert.doesNotMatch(readFileSync(path.join(repoDir, f), 'utf8'), /trigger|delete|drop|truncate/i, f)
  })

  it('the rehearsal fires the database trigger, measures 1 lost order and denies; the real database is unchanged', async () => {
    const before = await measureReal()
    const r = (await server.call('rehearse', { migrations: [MIGRATION_FILE] })).payload
    assert.deepEqual([r.status, r.reason, r.next_action], ['DENIED', 'DATA_LOSS', 'REVISE_AND_REHEARSE'], JSON.stringify(r))
    assert.deepEqual(r.impact.rows_lost, { orders: 1, patches: 0 })
    assert.deepEqual([r.impact.tables.orders.rows_before, r.impact.tables.orders.rows_after], [3, 2])
    assert.deepEqual(r.remediation.constraints.map((c) => [c.kind, c.table]), [['rows_preserved', 'orders']])
    assert.deepEqual(r.impact.schema_delta.removed_columns, [])
    assert.deepEqual(await measureReal(), before, 'the real database is only read to make the copy')
  })

  it('a revision can be measured SAFE (prepared SQL: the loop is possible; not agent evidence)', async () => {
    writeFileSync(path.join(repoDir, MIGRATION_FILE), PREPARED_FIX)
    const r = (await server.call('rehearse', { migrations: [MIGRATION_FILE] })).payload
    assert.deepEqual([r.status, r.impact.rows_lost], ['SAFE', { orders: 0, patches: 0 }], JSON.stringify(r))
    assert.equal(r.impact.tables.patches.content_changed, true, 'the patch was marked sold out')
    writeFileSync(path.join(repoDir, MIGRATION_FILE), MIGRATION_SQL)
  })

  it('a plan that removes, redefines or switches off the existing trigger logic is LOGIC CHANGE, not SAFE', async () => {
    const cases = [
      ['DROP TRIGGER patches_release_sold_out ON patches;\nUPDATE patches SET available_count = 0 WHERE id = 1;\n', 'removed_logic', 'trigger public.patches.patches_release_sold_out'],
      ['ALTER TABLE patches DISABLE TRIGGER patches_release_sold_out;\nUPDATE patches SET available_count = 0 WHERE id = 1;\n', 'changed_logic', 'trigger public.patches.patches_release_sold_out'],
      ["CREATE OR REPLACE FUNCTION release_sold_out_patch() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;\nUPDATE patches SET available_count = 0 WHERE id = 1;\n", 'changed_logic', 'function public.release_sold_out_patch()'],
      // A function whose name carries a tab, a newline and a forged entry cannot hide the redefinition.
      ['CREATE FUNCTION "x\tmd5\npublic.release_sold_out_patch()"() RETURNS int LANGUAGE sql AS \'SELECT 1\';\n' +
        "CREATE OR REPLACE FUNCTION release_sold_out_patch() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;\nUPDATE patches SET available_count = 0 WHERE id = 1;\n", 'changed_logic', 'function public.release_sold_out_patch()'],
    ]
    for (const [sql, field, object] of cases) {
      writeFileSync(path.join(repoDir, MIGRATION_FILE), sql)
      const r = (await server.call('rehearse', { migrations: [MIGRATION_FILE] })).payload
      assert.deepEqual([r.status, r.verdict, r.reason, r.impact.rows_lost.orders], ['DENIED', 'LOGIC CHANGE', 'LOGIC_CHANGE', 0], JSON.stringify(r))
      assert.ok(r.impact.schema_delta[field].includes(object), JSON.stringify(r.impact.schema_delta))
      assert.ok(r.remediation.constraints.some((c) => c.object === object), JSON.stringify(r.remediation))
    }
    writeFileSync(path.join(repoDir, MIGRATION_FILE), MIGRATION_SQL)
  })

  it('database logic changed after the rehearsal stops the approval and the run (fidelity)', async () => {
    const operator = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repoDir, env: { ...env(), JUSTRUNME_APPROVER_PASSPHRASE: PASSPHRASE }, encoding: 'utf8' })
    const json = (r) => JSON.parse(r.stdout)
    writeFileSync(path.join(repoDir, MIGRATION_FILE), PREPARED_FIX)
    const safe = (await server.call('rehearse', { migrations: [MIGRATION_FILE] })).payload
    assert.equal(safe.status, 'SAFE', JSON.stringify(safe))

    // The function body is edited after the rehearsal, name unchanged: approval is refused.
    const asked = (await server.call('request_approval', { plan_id: safe.plan_id })).payload
    assert.equal(asked.status, 'PENDING_APPROVAL', JSON.stringify(asked))
    const editedBody = LEGACY_TRIGGER_SQL.split('CREATE TRIGGER')[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replace('DELETE FROM orders WHERE patch_id = NEW.id;', 'DELETE FROM orders WHERE patch_id = NEW.id AND quantity > 0;')
    assert.equal((await psql(real, { input: editedBody })).code, 0)
    const refused = operator('approve', asked.request_id, '--confirm', safe.plan_id)
    assert.notEqual(refused.status, 0, refused.stdout)
    assert.equal(json(refused).error.code, 'FIDELITY_MISMATCH', refused.stdout)
    assert.ok(JSON.stringify(json(refused).error.detail).includes('logic.functions'), refused.stdout)
    assert.equal((await psql(real, { input: LEGACY_TRIGGER_SQL.split('CREATE TRIGGER')[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION') })).code, 0)

    // Approved on the original logic; a trigger added before the run stops the run.
    const again = (await server.call('rehearse', { migrations: [MIGRATION_FILE] })).payload
    assert.equal(again.status, 'SAFE', JSON.stringify(again))
    const asked2 = (await server.call('request_approval', { plan_id: again.plan_id })).payload
    const ok = operator('approve', asked2.request_id, '--confirm', again.plan_id)
    assert.equal(ok.status, 0, ok.stdout)
    const before = await measureReal()
    assert.equal((await psql(real, { sql: 'CREATE TRIGGER patches_audit AFTER UPDATE ON patches FOR EACH ROW EXECUTE FUNCTION release_sold_out_patch()' })).code, 0)
    const run = (await server.call('run_mission', { plan_id: again.plan_id })).payload
    assert.deepEqual([run.status, run.error?.code], ['REFUSED', 'FIDELITY_MISMATCH'], JSON.stringify(run))
    assert.deepEqual((await measureReal()).tables, before.tables, 'nothing ran')
    assert.equal((await psql(real, { sql: 'DROP TRIGGER patches_audit ON patches' })).code, 0)
    writeFileSync(path.join(repoDir, MIGRATION_FILE), MIGRATION_SQL)
  })

  it('without JustRunMe, the same SQL applied directly deletes the order of that patch', async () => {
    assert.deepEqual(await orderIds(), [1, 2, 3])
    const r = await psql(real, { input: MIGRATION_SQL, singleTransaction: true })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(await orderIds(), [1, 2, 3].filter((id) => !ORDERS_OF_TARGET.includes(id)))
  })
})
