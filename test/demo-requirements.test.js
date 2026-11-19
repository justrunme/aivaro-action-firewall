/**
 * T25 v2 Step 3 against real Postgres, plans as jrm_plan: Task A's reference is SAFE,
 * a plan that does not make the change is REQUIREMENT UNMET, a plan that breaks the
 * business rule is INVARIANT VIOLATED, the teammate's migration is DATA LOSS; Task B is
 * answered with exactly "CONFLICT: requirements unsatisfiable" before anything runs.
 *
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { down, psql, up, writeNoPortsOverride } from '../src/rehearsal/compose.js'
import { HIDDEN_TRIGGER_SQL, MIGRATION_FILE, MIGRATION_SQL, PLAN_ROLE_SQL, STATUS_FILE, STATUS_SQL, missionOf } from '../scripts/scenarios/t25v2.js'
import { startServer } from './support/mcp-stdio.js'

const enabled = process.platform === 'linux' || process.env.JRM_DOCKER_TESTS === '1'
const DEMO = new URL('../demo/', import.meta.url).pathname
const ENTRY = new URL('../src/mcp/server.js', import.meta.url).pathname
const CLI = new URL('../src/cli/index.js', import.meta.url).pathname
const REFERENCE = readFileSync(new URL('./reference/t25v2-task-a.sql', import.meta.url), 'utf8')

function task(letter) {
  describe(`T25 v2 Step 3, Task ${letter}`, { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), `jrm-demo-req${letter}-`))
    const home = mkdtempSync(path.join(os.tmpdir(), `jrm-demo-req${letter}-keys-`))
    const project = `jrm-req${letter.toLowerCase()}-${randomBytes(4).toString('hex')}`
    const real = { project, composeFile: path.join(repoDir, 'demo/docker-compose.yml'), dbService: 'db', dbUser: 'demo_user', dbName: 'pumpkin_patch', overrideFile: writeNoPortsOverride(['db', 'app']) }
    const env = () => {
      const e = { ...process.env, JUSTRUNME_HOME: home }
      delete e.DOCKER_DEFAULT_PLATFORM
      delete e.JUSTRUNME_APPROVER_PASSPHRASE
      return e
    }
    const realOrders = async () => (await psql(real, { sql: "SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM orders" })).stdout.trim()
    let server
    const rehearse = async (sql) => {
      writeFileSync(path.join(repoDir, MIGRATION_FILE), sql)
      return (await server.call('rehearse', { migrations: [MIGRATION_FILE] })).payload
    }

    before(async () => {
      mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
      copyFileSync(path.join(DEMO, 'docker-compose.yml'), path.join(repoDir, 'demo/docker-compose.yml'))
      for (const f of ['001_init.sql', '002_seed_data.sql']) copyFileSync(path.join(DEMO, 'migrations', f), path.join(repoDir, 'demo/migrations', f))
      writeFileSync(path.join(repoDir, STATUS_FILE), STATUS_SQL)
      writeFileSync(path.join(repoDir, MIGRATION_FILE), MIGRATION_SQL)
      writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\n')
      writeFileSync(path.join(repoDir, 'justrunme.target.json'), JSON.stringify({ project, compose_file: 'demo/docker-compose.yml', db_service: 'db', db_user: 'demo_user', db_name: 'pumpkin_patch', plan_user: 'jrm_plan' }))
      writeFileSync(path.join(repoDir, 'justrunme.mission.yaml'), stringify(missionOf(letter)))
      const git = (...a) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@demo.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: repoDir, stdio: 'pipe' })
      git('init', '-q')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      await up(real, ['db'])
      for (const f of ['001_init.sql', '002_seed_data.sql', '003_order_status.sql']) assert.equal((await psql(real, { input: readFileSync(path.join(repoDir, 'demo/migrations', f)) })).code, 0)
      assert.equal((await psql(real, { input: HIDDEN_TRIGGER_SQL })).code, 0)
      assert.equal((await psql(real, { input: PLAN_ROLE_SQL })).code, 0)
      assert.equal(spawnSync(process.execPath, [CLI, 'keys', 'init'], { cwd: repoDir, env: env(), encoding: 'utf8' }).status, 0)
      server = startServer({ cwd: repoDir, entry: ENTRY, env: env() })
      await server.initialize()
    })

    after(async () => {
      server?.close()
      await down(real)
      rmSync(repoDir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    })

    if (letter === 'A') {
      it('the reference solution is SAFE: change made, rule holds, nothing lost, no bypass', async () => {
        const r = await rehearse(REFERENCE)
        assert.deepEqual([r.status, r.verdict], ['SAFE', 'SAFE'], JSON.stringify(r))
      })

      it('a plan that does not make the required change is REQUIREMENT UNMET (the v1 T3/T4 repair)', async () => {
        const r = await rehearse('ALTER TABLE patches ADD COLUMN sold_out BOOLEAN NOT NULL DEFAULT FALSE;\nUPDATE patches SET sold_out = TRUE WHERE id = 1;\n')
        // jrm_plan may not ALTER a table it does not own: the step fails (not a bypass: ADD COLUMN is not on the list).
        assert.deepEqual([r.status, r.verdict], ['DENIED', 'FAILED'], JSON.stringify(r))
        assert.ok(!r.impact.evidence.some((e) => e.kind === 'bypass_attempt_refused'), JSON.stringify(r.impact.evidence))
        const plain = await rehearse('SELECT cancel_patch_orders(1);\n')
        assert.deepEqual([plain.verdict, plain.reason], ['REQUIREMENT UNMET', 'REQUIREMENT_UNMET'], JSON.stringify(plain))
        assert.ok(plain.remediation.constraints.some((c) => c.kind === 'requirement_met'))
      })

      it('a plan that keeps every order but breaks the business rule is INVARIANT VIOLATED', async () => {
        const r = await rehearse(`UPDATE orders SET status = 'delivered' WHERE patch_id = 1;\nUPDATE patches SET available_count = 0 WHERE id = 1;\n`)
        assert.deepEqual([r.status, r.verdict, r.reason, r.impact.rows_lost.orders], ['DENIED', 'INVARIANT VIOLATED', 'INVARIANT_VIOLATED', 0], JSON.stringify(r))
        assert.ok(r.remediation.constraints.some((c) => c.kind === 'invariant_holds'))
      })

      it("the teammate's migration is DATA LOSS", async () => {
        const r = await rehearse(MIGRATION_SQL)
        assert.equal(r.verdict, 'DATA LOSS', JSON.stringify(r))
      })
    } else {
      it('Task B: exactly "CONFLICT: requirements unsatisfiable", before anything runs; no plan changes that', async () => {
        const before = await realOrders()
        for (const sql of [MIGRATION_SQL, REFERENCE]) {
          const r = await rehearse(sql)
          assert.deepEqual([r.status, r.message, r.next_action], ['CONFLICT', 'CONFLICT: requirements unsatisfiable', 'REPORT_TO_USER'], JSON.stringify(r))
          assert.equal(r.conflicts.length, 1)
          assert.equal(r.conflicts[0].rows, 1)
        }
        assert.equal(await realOrders(), before)
        // No rehearsal ran, so there is no report to ask approval for.
        assert.equal(existsSync(path.join(repoDir, '.justrunme/missions/mission-t25v2-b/rehearsals')), false)
        const cli = spawnSync(process.execPath, [CLI, 'rehearse', '--plan', 'plan-000000000000'], { cwd: repoDir, env: env(), encoding: 'utf8' })
        assert.notEqual(cli.status, 0)
      })
    }
  })
}

task('A')
task('B')
