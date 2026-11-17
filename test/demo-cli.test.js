/**
 * T18 end to end through the CLI only, against real Docker and Postgres:
 * rehearse (DATA LOSS, exit 10) -> replan, rehearse (SAFE, exit 0) ->
 * authorize before comparing (exit 21 COMPARISON_REQUIRED) -> compare (exit 0) ->
 * authorize the dangerous plan (exit 21 DATA_LOSS) -> authorize (exit 0, selected) ->
 * run (exit 0) -> verify (exit 0) -> undo (exit 0, RECOVERED) -> verify, replay.
 *
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { measureDatabase } from '../src/rehearsal/measure.js'
import { down, psql, up, writeNoPortsOverride } from '../src/rehearsal/compose.js'
import { EXIT } from '../src/cli/codes.js'

const enabled = process.platform === 'linux' || process.env.JRM_DOCKER_TESTS === '1'
const DEMO = new URL('../demo/', import.meta.url).pathname
const CLI = new URL('../src/cli/index.js', import.meta.url).pathname

const DANGEROUS = 'CREATE TABLE orders_v2 AS SELECT id, patch_id, quantity FROM orders WHERE quantity >= 10;\nDROP TABLE orders;\nALTER TABLE orders_v2 RENAME TO orders;\n'
const SAFE = "ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'new';\n"

describe('Demo CLI: the whole mission through `justrunme`, with exit codes', { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-cli-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-cli-keys-'))
  const project = `jrm-democli-${randomBytes(4).toString('hex')}`
  const realTarget = { project, composeFile: path.join(repoDir, 'demo/docker-compose.yml'), dbService: 'db', dbUser: 'demo_user', dbName: 'pumpkin_patch', overrideFile: writeNoPortsOverride(['db', 'app']) }
  const measureReal = () => measureDatabase((sql) => psql(realTarget, { sql }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@demo.invalid', ...args], { cwd: repoDir, stdio: 'pipe' })
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repoDir], { encoding: 'utf8', env: { ...process.env, JUSTRUNME_HOME: home }, timeout: 300000 })
    return { code: r.status, out: JSON.parse(r.stdout) }
  }
  const contract = (file) =>
    writeFileSync(
      path.join(repoDir, 'justrunme.mission.yaml'),
      stringify({
        id: 'mission-demo-cli',
        objective: 'Add order status tracking to the demo service',
        allowed_paths: ['demo/migrations/'],
        protected_tables: ['orders', 'patches'],
        time_limit_seconds: 300,
        irreversible_actions: [],
        plan: [{ id: 'migrate', tool: 'sql_migration', args: [file], reversibility: true }],
        resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] },
      })
    )

  before(async () => {
    mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
    copyFileSync(path.join(DEMO, 'docker-compose.yml'), path.join(repoDir, 'demo/docker-compose.yml'))
    for (const f of ['001_init.sql', '002_seed_data.sql']) copyFileSync(path.join(DEMO, 'migrations', f), path.join(repoDir, 'demo/migrations', f))
    writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\n')
    writeFileSync(path.join(repoDir, 'justrunme.target.json'), JSON.stringify({ project, compose_file: 'demo/docker-compose.yml', db_service: 'db', db_user: 'demo_user', db_name: 'pumpkin_patch' }))
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'demo base')
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

  it('runs Rehearse -> Detect -> Replan -> Compare -> Authorize -> Run -> Undo -> Verify with the documented exit codes', async () => {
    assert.equal(cli('keys', 'init').code, EXIT.OK)
    const before = await measureReal()

    writeFileSync(path.join(repoDir, 'demo/migrations/003_consolidate_orders.sql'), DANGEROUS)
    contract('demo/migrations/003_consolidate_orders.sql')
    const danger = cli('rehearse')
    assert.equal(danger.code, EXIT.DATA_LOSS, JSON.stringify(danger.out))
    assert.equal(danger.out.result.verdict, 'DATA LOSS')
    assert.equal(danger.out.result.rows_lost.orders, 1)
    assert.deepEqual(await measureReal(), before, 'rehearsal did not touch the real database')

    unlinkSync(path.join(repoDir, 'demo/migrations/003_consolidate_orders.sql'))
    writeFileSync(path.join(repoDir, 'demo/migrations/003_add_order_status.sql'), SAFE)
    contract('demo/migrations/003_add_order_status.sql')
    const safe = cli('rehearse')
    assert.equal(safe.code, EXIT.OK, JSON.stringify(safe.out))
    assert.equal(safe.out.result.base_hash, danger.out.result.base_hash)

    const early = cli('authorize')
    assert.equal(early.code, EXIT.AUTHORIZATION_REFUSED)
    assert.equal(early.out.error.code, 'COMPARISON_REQUIRED')

    const cmp = cli('compare')
    assert.equal(cmp.code, EXIT.OK, JSON.stringify(cmp.out))
    assert.equal(cmp.out.result.recommended, safe.out.result.plan_id)
    assert.equal(cmp.out.result.decided_by, 'R15.4.1')

    contract('demo/migrations/003_consolidate_orders.sql')
    const wrong = cli('authorize')
    assert.equal(wrong.code, EXIT.AUTHORIZATION_REFUSED)
    assert.equal(wrong.out.error.code, 'DATA_LOSS')

    contract('demo/migrations/003_add_order_status.sql')
    const auth = cli('authorize')
    assert.equal(auth.code, EXIT.OK, JSON.stringify(auth.out))
    assert.equal(auth.out.result.selection.mode, 'selected')

    const run = cli('run')
    assert.equal(run.code, EXIT.OK, JSON.stringify(run.out))
    assert.ok((await measureReal()).columns.orders.some((c) => c.startsWith('status ')))
    assert.equal(cli('run').code, EXIT.RUN_REFUSED, 'authorization is single use')
    assert.equal(cli('verify').code, EXIT.OK)

    const undo = cli('undo', run.out.result.capture_id)
    assert.equal(undo.code, EXIT.OK, JSON.stringify(undo.out))
    assert.equal(undo.out.result.status, 'RECOVERED')
    const after = await measureReal()
    assert.deepEqual(after.tables, before.tables)
    assert.ok(!after.columns.orders.some((c) => c.startsWith('status ')))

    const v = cli('verify')
    assert.equal(v.code, EXIT.OK, JSON.stringify(v.out))
    assert.equal(v.out.result.selections.length, 1)
    assert.equal(cli('replay').code, EXIT.OK)
  })
})
