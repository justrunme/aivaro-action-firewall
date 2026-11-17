/**
 * T21: what an agent may put in a plan. Only sql_migration steps over .sql files
 * inside the operator's allowed_paths; nothing else can get into a contract.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { executeSteps } from '../src/rehearsal/steps.js'
import { MAX_SQL_BYTES, PlanRefused, loadStoredPlan, plansDir, proposePlan } from '../src/mission/plans.js'

const MISSION = {
  id: 'mission-plans-test',
  objective: 'Exercise agent plans in a temporary workspace',
  allowed_paths: ['demo/migrations/'],
  protected_tables: ['orders'],
  time_limit_seconds: 300,
  irreversible_actions: [],
  plan: [{ id: 'placeholder', tool: 'sql_migration', args: ['demo/migrations/001_init.sql'], reversibility: true }],
  resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] },
}

const dirs = []
function workspace(mission = MISSION) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jrm-plans-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'demo/migrations'), { recursive: true })
  writeFileSync(path.join(dir, 'demo/docker-compose.yml'), 'services: {}\n')
  writeFileSync(path.join(dir, 'justrunme.target.json'), JSON.stringify({ project: 'jrm-plans-test', compose_file: 'demo/docker-compose.yml', db_service: 'db', db_user: 'u', db_name: 'd' }))
  mkdirSync(path.join(dir, 'secrets'), { recursive: true })
  writeFileSync(path.join(dir, 'demo/migrations/001_init.sql'), 'SELECT 1;\n')
  writeFileSync(path.join(dir, 'demo/migrations/003_a.sql'), "ALTER TABLE orders ADD COLUMN a TEXT;\n")
  writeFileSync(path.join(dir, 'demo/migrations/003_b.sql'), "ALTER TABLE orders ADD COLUMN b TEXT;\n")
  writeFileSync(path.join(dir, 'secrets/stolen.sql'), 'SELECT 1;\n')
  writeFileSync(path.join(dir, 'justrunme.mission.yaml'), stringify(mission))
  return dir
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const refused = (fn, code) => assert.throws(fn, (err) => err instanceof PlanRefused && err.code === code, code)

describe('agent plans (T21)', () => {
  it('builds a contract from the operator mission and sql_migration steps only, and stores it', () => {
    const dir = workspace()
    const p = proposePlan({ repoDir: dir, migrations: ['demo/migrations/003_a.sql', 'demo/migrations/003_b.sql'] })
    assert.match(p.plan_id, /^plan-[0-9a-f]{12}$/)
    assert.deepEqual(p.contract.plan.map((s) => [s.tool, s.args, s.reversibility]), [['sql_migration', ['demo/migrations/003_a.sql'], true], ['sql_migration', ['demo/migrations/003_b.sql'], true]])
    for (const k of ['id', 'objective', 'allowed_paths', 'protected_tables', 'time_limit_seconds', 'resources']) assert.deepEqual(p.contract[k], MISSION[k], k)
    assert.deepEqual(p.contract.irreversible_actions, [])
    assert.deepEqual(parse(readFileSync(p.file, 'utf8')), p.contract)
    assert.equal(p.file, path.join(plansDir(dir, MISSION.id), `${p.plan_id}.yaml`))
    assert.equal(proposePlan({ repoDir: dir, migrations: ['demo/migrations/003_a.sql', 'demo/migrations/003_b.sql'] }).plan_id, p.plan_id, 'same plan, same id')
    assert.notEqual(proposePlan({ repoDir: dir, migrations: ['demo/migrations/003_a.sql'] }).plan_id, p.plan_id)
  })

  it('refuses everything that is not a plain .sql file inside allowed_paths', () => {
    const dir = workspace()
    symlinkSync(path.join(dir, 'secrets/stolen.sql'), path.join(dir, 'demo/migrations/003_link.sql'))
    writeFileSync(path.join(dir, 'demo/migrations/big.sql'), 'x'.repeat(MAX_SQL_BYTES + 1))
    writeFileSync(path.join(dir, 'demo/migrations/run.sh'), 'echo hi\n')
    mkdirSync(path.join(dir, 'demo/migrations/dir.sql'))
    const cases = [
      [['/etc/passwd'], 'MIGRATION_INVALID'],
      [[path.join(dir, 'demo/migrations/003_a.sql')], 'MIGRATION_INVALID'],
      [['demo/migrations/../../secrets/stolen.sql'], 'MIGRATION_INVALID'],
      [['secrets/stolen.sql'], 'MIGRATION_OUTSIDE_ALLOWED_PATHS'],
      [['demo/migrations/run.sh'], 'MIGRATION_INVALID'],
      [['demo/migrations/nope.sql'], 'MIGRATION_NOT_FOUND'],
      [['demo/migrations/003_link.sql'], 'MIGRATION_INVALID'],
      [['demo/migrations/dir.sql'], 'MIGRATION_INVALID'],
      [['demo/migrations/big.sql'], 'MIGRATION_TOO_LARGE'],
      [['demo/migrations/003_a.sql; rm -rf /'], 'MIGRATION_INVALID'],
      [['demo/migrations/003_a.sql', 'demo/migrations/./003_a.sql'], 'PLAN_INVALID'],
      [[], 'PLAN_INVALID'],
      [['demo/migrations/003_a.sql', 'demo/migrations/003_b.sql', 'demo/migrations/001_init.sql', 'demo/migrations/003_a.sql', 'demo/migrations/003_b.sql', 'demo/migrations/big.sql'], 'PLAN_INVALID'],
      ['demo/migrations/003_a.sql', 'PLAN_INVALID'],
      [[5], 'MIGRATION_INVALID'],
      [[null], 'MIGRATION_INVALID'],
    ]
    for (const [migrations, code] of cases) refused(() => proposePlan({ repoDir: dir, migrations }), code)
  })

  it('refuses a mission whose allowed_paths would let an agent write the Compose file, the gate or the mission', () => {
    for (const allowed of [['demo/'], ['demo'], ['.'], ['./'], ['demo/migrations/', 'demo/docker-compose.yml'], ['.kiro/hooks/'], ['.kiro/'], ['src/'], ['.git/hooks/'], ['justrunme.target.json']]) {
      const dir = workspace({ ...MISSION, allowed_paths: allowed })
      refused(() => proposePlan({ repoDir: dir, migrations: ['demo/migrations/003_a.sql'] }), 'MISSION_TOO_BROAD')
    }
    // The narrow mission used everywhere else is accepted, and so is one that names the migrations directory of another layout.
    assert.doesNotThrow(() => proposePlan({ repoDir: workspace(), migrations: ['demo/migrations/003_a.sql'] }))
  })

  it('follows links and ignores case when it checks allowed_paths against the Compose file and the gate', () => {
    // sql -> demo: the entry looks harmless, but writing there is writing demo/docker-compose.yml.
    const linked = workspace({ ...MISSION, allowed_paths: ['sql/'] })
    symlinkSync(path.join(linked, 'demo'), path.join(linked, 'sql'))
    refused(() => proposePlan({ repoDir: linked, migrations: ['demo/migrations/003_a.sql'] }), 'MISSION_TOO_BROAD')
    // Case: Demo/ is demo/ on a case-insensitive file system.
    refused(() => proposePlan({ repoDir: workspace({ ...MISSION, allowed_paths: ['Demo/'] }), migrations: ['demo/migrations/003_a.sql'] }), 'MISSION_TOO_BROAD')
    refused(() => proposePlan({ repoDir: workspace({ ...MISSION, allowed_paths: ['.KIRO/hooks/'] }), migrations: ['demo/migrations/003_a.sql'] }), 'MISSION_TOO_BROAD')
  })

  it('a migration swapped for a link after the plan was checked is not read by the step', async () => {
    const dir = workspace()
    writeFileSync(path.join(dir, 'real.sql'), 'SELECT 1;\n')
    symlinkSync(path.join(dir, 'secrets/stolen.sql'), path.join(dir, 'swapped.sql'))
    const target = { project: 'jrm-never-started', composeFile: path.join(dir, 'demo/docker-compose.yml'), dbService: 'db', dbUser: 'u', dbName: 'd' }
    const [r] = await executeSteps({ plan: [{ id: 'm1', tool: 'sql_migration', args: ['swapped.sql'], reversibility: true }], cwd: dir, target, mode: 'rehearsal' })
    assert.equal(r.status, 'failed')
    assert.match(r.detail, /symbolic link/)
  })

  it('reloads a stored plan only while it is still exactly what would be built today', () => {
    const dir = workspace()
    const p = proposePlan({ repoDir: dir, migrations: ['demo/migrations/003_a.sql'] })
    assert.deepEqual(loadStoredPlan(dir, p.plan_id).contract, p.contract)

    refused(() => loadStoredPlan(dir, 'plan-000000000000'), 'PLAN_UNKNOWN')
    refused(() => loadStoredPlan(dir, '../../etc/passwd'), 'PLAN_INVALID')

    // A shell step written into the stored file by anyone is refused, even with a matching id.
    const forged = { ...p.contract, plan: [{ id: 'm1', tool: 'shell', args: ['curl', 'https://example.invalid'], reversibility: true }] }
    writeFileSync(p.file, stringify(forged))
    refused(() => loadStoredPlan(dir, p.plan_id), 'PLAN_INVALID')

    // The operator mission changed (here: another protected table): the old plan is stale.
    writeFileSync(p.file, stringify(p.contract))
    writeFileSync(path.join(dir, 'justrunme.mission.yaml'), stringify({ ...MISSION, protected_tables: ['orders', 'patches'] }))
    refused(() => loadStoredPlan(dir, p.plan_id), 'PLAN_STALE')

    // The migration became a symlink after the plan was stored.
    writeFileSync(path.join(dir, 'justrunme.mission.yaml'), stringify(MISSION))
    rmSync(path.join(dir, 'demo/migrations/003_a.sql'))
    symlinkSync(path.join(dir, 'secrets/stolen.sql'), path.join(dir, 'demo/migrations/003_a.sql'))
    refused(() => loadStoredPlan(dir, p.plan_id), 'MIGRATION_INVALID')
  })

  it('property: whatever the agent sends, the result is a refusal or a plan of reversible sql_migration steps inside allowed_paths', () => {
    const dir = workspace()
    const names = fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.constantFrom('demo/migrations/003_a.sql', 'demo/migrations/003_b.sql', '../x.sql', '/etc/passwd', 'demo/migrations/', 'secrets/stolen.sql', 'demo/migrations/003_a.sql\n', '.sql')
    )
    fc.assert(
      fc.property(fc.oneof(fc.array(names, { maxLength: 7 }), fc.anything()), (migrations) => {
        try {
          const p = proposePlan({ repoDir: dir, migrations })
          return p.contract.irreversible_actions.length === 0 && p.contract.plan.every((s) => s.tool === 'sql_migration' && s.reversibility === true && /^demo\/migrations\/[^/]+\.sql$/.test(s.args[0]))
        } catch (err) {
          return err instanceof PlanRefused
        }
      }),
      { numRuns: 300 }
    )
  })
})
