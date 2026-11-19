/**
 * Undo keeps database privileges, and the recovery verification notices when they differ.
 *
 * Against a real Postgres 16 (the demo stack): a role gets table, column, sequence,
 * function, schema, database-level and default privileges, and PUBLIC loses some.
 * A capture is taken, the data and the grants are damaged, the database is restored
 * from the capture, and every privilege is checked again as Postgres reports it.
 * The control repeats the old path (a dump without privileges and no privileges in
 * the capture) and shows what it lost and that it was marked not checked.
 *
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { down, dump, imageDigests, psql, up, writeNoPortsOverride } from '../src/rehearsal/compose.js'
import { measureDatabase } from '../src/rehearsal/measure.js'
import { capturePostgres, restorePostgres } from '../src/capture/postgres.js'
import { measurePrivileges } from '../src/capture/privileges.js'
import { verifyRecovery } from '../src/undo/verify.js'
import { sha256Hex } from '../src/util/canonical.js'

const enabled = process.platform === 'linux' || process.env.JRM_DOCKER_TESTS === '1'
const DEMO = new URL('../demo/', import.meta.url).pathname

// demo-only role, no password: it is never used to log in here.
const GRANTS = `
CREATE ROLE jrm_undo_reader NOLOGIN NOINHERIT;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jrm_undo_reader;
GRANT SELECT, UPDATE ON orders TO jrm_undo_reader;
GRANT SELECT (id, name) ON patches TO jrm_undo_reader;
GRANT USAGE ON SEQUENCE orders_id_seq TO jrm_undo_reader;
CREATE FUNCTION order_count() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM orders';
REVOKE ALL ON FUNCTION order_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION order_count() TO jrm_undo_reader;
REVOKE CONNECT, TEMPORARY ON DATABASE pumpkin_patch FROM PUBLIC;
GRANT CONNECT ON DATABASE pumpkin_patch TO jrm_undo_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO jrm_undo_reader;
`
// What a damaging run could leave behind: data changed, rights taken away or widened.
const DAMAGE = `
UPDATE orders SET quantity = quantity + 1;
REVOKE ALL ON orders FROM jrm_undo_reader;
REVOKE EXECUTE ON FUNCTION order_count() FROM jrm_undo_reader;
GRANT ALL ON SCHEMA public TO PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE pumpkin_patch TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM jrm_undo_reader;
`
// What Postgres itself says about the rights, independent of the measurement under test.
const ASK = `SELECT concat_ws(',',
  has_table_privilege('jrm_undo_reader', 'orders', 'SELECT'),
  has_table_privilege('jrm_undo_reader', 'orders', 'UPDATE'),
  has_column_privilege('jrm_undo_reader', 'patches', 'name', 'SELECT'),
  has_column_privilege('jrm_undo_reader', 'patches', 'location', 'SELECT'),
  has_sequence_privilege('jrm_undo_reader', 'orders_id_seq', 'USAGE'),
  has_function_privilege('jrm_undo_reader', 'order_count()', 'EXECUTE'),
  has_function_privilege('public', 'order_count()', 'EXECUTE'),
  has_schema_privilege('jrm_undo_reader', 'public', 'USAGE'),
  has_schema_privilege('public', 'public', 'USAGE'),
  has_database_privilege('jrm_undo_reader', 'pumpkin_patch', 'CONNECT'),
  has_database_privilege('public', 'pumpkin_patch', 'CONNECT'),
  has_database_privilege('public', 'pumpkin_patch', 'TEMPORARY'),
  (SELECT count(*) FROM pg_default_acl))`
const GRANTED = 't,t,t,f,t,t,f,t,f,t,f,f,1'

describe('Undo keeps database privileges and verifies them', { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-undo-grants-'))
  const pgDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-undo-grants-pg-'))
  const target = {
    project: `jrm-undogrants-${randomBytes(4).toString('hex')}`,
    composeFile: path.join(repoDir, 'demo/docker-compose.yml'),
    overrideFile: writeNoPortsOverride(['db']),
    dbService: 'db',
    dbUser: 'demo_user',
    dbName: 'pumpkin_patch',
  }
  const sql = async (q) => {
    const r = await psql(target, { sql: q })
    assert.equal(r.code, 0, r.stderr)
    return r.stdout.trim()
  }
  const script = async (input) => {
    const r = await psql(target, { input, singleTransaction: true })
    assert.equal(r.code, 0, r.stderr)
  }
  const manifestOf = async (entry) => ({ files: { files: [], roots: [] }, postgres: [entry], containers: { images: await imageDigests(target) } })

  before(async () => {
    cpSync(DEMO, path.join(repoDir, 'demo'), { recursive: true, filter: (src) => !src.includes('node_modules') && !src.endsWith('.test.js') })
    await up(target, ['db'])
    await script(readFileSync(path.join(repoDir, 'demo/migrations/001_init.sql'), 'utf8'))
    await script(readFileSync(path.join(repoDir, 'demo/migrations/002_seed_data.sql'), 'utf8'))
    await script(GRANTS)
  })
  after(async () => {
    await down(target)
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(pgDir, { recursive: true, force: true })
  })

  it('a restore from a capture brings back the data and every privilege; the verification checks them and passes', async () => {
    assert.equal(await sql(ASK), GRANTED, 'the grants hold before the capture')
    const before = await measureDatabase((q) => psql(target, { sql: q }))
    const entry = await capturePostgres(target, path.join(pgDir, 'pumpkin_patch.sql'))
    assert.match(entry.privileges.hash, /^sha256:/)
    assert.ok(entry.privileges.lines.includes('table public.orders grant jrm_undo_reader SELECT'), entry.privileges.lines.join('\n'))
    assert.ok(entry.privileges.lines.includes('database grant jrm_undo_reader CONNECT'))
    assert.ok(!entry.privileges.lines.some((l) => l.startsWith('database grant PUBLIC')), 'PUBLIC lost CONNECT and TEMPORARY')
    assert.ok(entry.privileges.lines.some((l) => l.startsWith('default demo_user public r grant jrm_undo_reader SELECT')), 'default privileges are recorded')

    await script(DAMAGE)
    assert.notEqual(await sql(ASK), GRANTED, 'the damage took rights away')
    const damaged = await verifyRecovery({ repoDir, manifest: await manifestOf(entry), target })
    assert.equal(damaged.status, 'FAIL')
    const pcheck = damaged.failed.find((c) => c.check === 'privileges')
    assert.ok(pcheck, 'the verification sees the privilege damage')
    assert.ok(pcheck.missing.includes('table public.orders grant jrm_undo_reader SELECT'))
    assert.ok(pcheck.extra.some((l) => l.startsWith('database grant PUBLIC')))

    const restored = await restorePostgres(target, entry, path.join(pgDir, 'pumpkin_patch.sql'))
    assert.equal(restored.status, 'succeeded', restored.detail)
    assert.equal(await sql(ASK), GRANTED, 'every right is back, as Postgres reports it')
    const after = await measureDatabase((q) => psql(target, { sql: q }))
    assert.deepEqual(after.tables, before.tables, 'and the data')
    const v = await verifyRecovery({ repoDir, manifest: await manifestOf(entry), target })
    assert.equal(v.status, 'PASS', JSON.stringify(v.failed))
    assert.deepEqual(v.not_checked, [])
    const ok = v.checks.find((c) => c.check === 'privileges')
    assert.equal(ok.ok, true)
    assert.equal(ok.actual, entry.privileges.hash)
  })

  it('a privilege changed after the restore makes the verification FAIL and names the line', async () => {
    const entry = await capturePostgres(target, path.join(pgDir, 'pumpkin_patch.sql'))
    await sql('REVOKE USAGE ON SEQUENCE orders_id_seq FROM jrm_undo_reader')
    const v = await verifyRecovery({ repoDir, manifest: await manifestOf(entry), target })
    assert.equal(v.status, 'FAIL')
    assert.deepEqual(v.failed.map((c) => c.check), ['privileges'], 'data, schema and images still match; only the privileges differ')
    assert.deepEqual(v.failed[0].missing, ['sequence public.orders_id_seq grant jrm_undo_reader USAGE'])
    await sql('GRANT USAGE ON SEQUENCE orders_id_seq TO jrm_undo_reader')
  })

  it('ownership is not restored: an object owned by another role comes back owned by the loading user, and the verification FAILs on it', async () => {
    await script('CREATE TABLE owned_elsewhere (id INT); ALTER TABLE owned_elsewhere OWNER TO jrm_undo_reader;')
    const entry = await capturePostgres(target, path.join(pgDir, 'owned.sql'))
    assert.ok(entry.privileges.lines.includes('table public.owned_elsewhere owner jrm_undo_reader'))
    const restored = await restorePostgres(target, entry, path.join(pgDir, 'owned.sql'))
    assert.equal(restored.status, 'succeeded', restored.detail)
    const v = await verifyRecovery({ repoDir, manifest: await manifestOf(entry), target })
    assert.equal(v.status, 'FAIL', 'a different owner is not a recovery')
    const p = v.failed.find((c) => c.check === 'privileges')
    assert.ok(p.missing.includes('table public.owned_elsewhere owner jrm_undo_reader'), JSON.stringify(p))
    assert.ok(p.extra.includes('table public.owned_elsewhere owner demo_user'), JSON.stringify(p))
    await script('DROP TABLE owned_elsewhere;')
  })

  it('control: the old capture (dump without privileges, nothing recorded) loses the grants, and its verification is UNVERIFIABLE (privileges not checked), never PASS', async () => {
    assert.equal(await sql(ASK), GRANTED)
    const file = path.join(pgDir, 'legacy.sql')
    const old = await dump(target)
    writeFileSync(file, old)
    const legacy = { name: 'pumpkin_patch', sha256: 'sha256:' + sha256Hex(old), measurement: await measureDatabase((q) => psql(target, { sql: q })) }
    const restored = await restorePostgres(target, legacy, file)
    assert.equal(restored.status, 'succeeded', restored.detail)
    const lost = (await sql(ASK)).split(',')
    assert.equal(lost[0], 'f', 'the table grant is gone (the bug this change fixes)')
    assert.equal(lost[10], 't', 'and PUBLIC can connect again')
    const v = await verifyRecovery({ repoDir, manifest: await manifestOf(legacy), target })
    assert.equal(v.status, 'UNVERIFIABLE', 'data and schema match, but privileges could not be checked: not a PASS')
    assert.deepEqual(v.failed, [], 'nothing failed')
    assert.deepEqual(v.not_checked, [{ check: 'privileges', resource: 'pumpkin_patch', why: 'the capture was made before privileges were recorded' }])
    assert.ok(!v.checks.some((c) => c.check === 'privileges'), 'no privileges check is claimed')
    // Measured the same way, the privileges after the old restore differ from the granted state.
    const now = await measurePrivileges((q) => psql(target, { sql: q }))
    assert.ok(!now.lines.includes('table public.orders grant jrm_undo_reader SELECT'))
  })
})
