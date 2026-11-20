/**
 * Chaos Twin Lite end to end against real Docker and Postgres 16 (the demo stack).
 *
 * The plan changes data (a migration), a file (a script) and, through a shell step that
 * uses only the environment JustRunMe gives plan steps (COMPOSE_PROJECT_NAME and COMPOSE_FILE),
 * the database it finds there. The twin runs it, the twin's database is killed with SIGKILL,
 * the undo restores the capture, the verification passes: RECOVERY PROVEN. The real database
 * keeps the same checksums throughout, and nothing of the twin is left afterwards.
 *
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { parseContract } from '../src/contract/parser.js'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { verifyChain } from '../src/receipts/chain.js'
import { checkPolicy } from '../src/receipts/policy.js'
import { down, psql, up, writeNoPortsOverride } from '../src/rehearsal/compose.js'
import { measureDatabase } from '../src/rehearsal/measure.js'
import { rehearseRecovery, TWIN_PREFIX } from '../src/chaos/twin.js'
import { run } from '../src/util/exec.js'

const enabled = process.platform === 'linux' || process.env.JRM_DOCKER_TESTS === '1'
const DEMO = new URL('../demo/', import.meta.url).pathname
const MIGRATION = `-- Chaos twin test: change and remove order data.
UPDATE orders SET quantity = quantity + 10;
DELETE FROM orders WHERE id = 3;
`
// A file change, and a database write through the environment the plan step is given.
const SCRIPT = `import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
writeFileSync('demo/app.config.json', JSON.stringify({ feature: 'on' }) + '\\n')
execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'demo_user', '-d', 'pumpkin_patch', '-c', 'UPDATE patches SET available_count = 99'], { stdio: 'pipe' })
`

describe('Chaos Twin Lite: recovery rehearsed on a disposable twin', { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-chaos-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-chaos-keys-'))
  const target = { project: `jrm-chaosreal-${randomBytes(4).toString('hex')}`, composeFile: 'demo/docker-compose.yml', dbService: 'db', dbUser: 'demo_user', dbName: 'pumpkin_patch' }
  const realTarget = { ...target, composeFile: path.join(repoDir, target.composeFile), overrideFile: writeNoPortsOverride(['db', 'app']) }
  const measureReal = () => measureDatabase((sql) => psql(realTarget, { sql }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@demo.invalid', ...args], { cwd: repoDir, stdio: 'pipe' })
  const keys = loadOrCreateKeys(home)
  const twinKeyDirs = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith('jrm-twin-keys-'))
  let parsed

  before(async () => {
    cpSync(DEMO, path.join(repoDir, 'demo'), { recursive: true, filter: (src) => !src.includes('node_modules') && !src.endsWith('.test.js') && !src.includes('recorded-run') })
    mkdirSync(path.join(repoDir, 'demo/scripts'), { recursive: true })
    writeFileSync(path.join(repoDir, 'demo/scripts/change.mjs'), SCRIPT)
    writeFileSync(path.join(repoDir, 'demo/migrations/003_chaos.sql'), MIGRATION)
    writeFileSync(path.join(repoDir, 'demo/app.config.json'), JSON.stringify({ feature: 'off' }) + '\n')
    writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\nnode_modules/\n')
    const text = stringify({
      id: 'mission-demo-chaos',
      objective: 'Rehearse the recovery of a damaging plan',
      allowed_paths: ['demo/'],
      protected_tables: ['orders', 'patches'],
      time_limit_seconds: 300,
      irreversible_actions: [],
      plan: [
        { id: 'migrate', tool: 'sql_migration', args: ['demo/migrations/003_chaos.sql'], reversibility: true },
        { id: 'change', tool: 'shell', args: ['node', 'demo/scripts/change.mjs'], reversibility: true },
      ],
      resources: { databases: ['pumpkin_patch'], config_files: ['demo/app.config.json'], compose_services: ['db'] },
    })
    writeFileSync(path.join(repoDir, 'justrunme.mission.yaml'), text)
    parsed = parseContract(text)
    assert.equal(parsed.ok, true)
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'chaos base')
    await up(realTarget, ['db'])
    for (const f of ['001_init.sql', '002_seed_data.sql']) {
      const r = await psql(realTarget, { input: readFileSync(path.join(repoDir, 'demo/migrations', f)) })
      assert.equal(r.code, 0, r.stderr)
    }
  })
  after(async () => {
    await down(realTarget)
    rmSync(path.dirname(realTarget.overrideFile), { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('RECOVERY PROVEN; the real database is unchanged; no twin container, volume, network, worktree or key is left', async () => {
    const realBefore = await measureReal()
    const keysBefore = twinKeyDirs()
    let isolated = null
    const r = await rehearseRecovery({
      repoDir,
      contract: parsed.contract,
      contractHash: parsed.hash,
      target,
      keys,
      inspect: async (twin) => {
        // While the twin runs: no published port and only an internal network.
        const ps = await run('docker', ['compose', '-p', twin.project, '-f', twin.composeFile, '-f', twin.overrideFile, 'ps', '-q', 'db'])
        const id = ps.stdout.trim()
        const ports = await run('docker', ['port', id])
        const nets = await run('docker', ['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}', id])
        const internal = []
        for (const n of nets.stdout.trim().split(/\s+/).filter(Boolean)) internal.push((await run('docker', ['network', 'inspect', '--format', '{{.Internal}}', n])).stdout.trim())
        isolated = { ports: ports.stdout.trim(), internal }
      },
    })
    assert.equal(r.verdict, 'RECOVERY PROVEN', JSON.stringify({ failure: r.failure, diverged: r.diverged, undo: r.undo }))
    assert.ok(r.twin_project.startsWith(TWIN_PREFIX))
    assert.deepEqual(r.steps.map((s) => s.status), ['ok', 'ok'])
    // The plan changed the twin: data by the migration, a file, and the database reached through the step's environment.
    assert.ok(r.diverged.tables_with_other_rows.includes('orders'))
    assert.ok(r.diverged.tables_with_other_checksums.includes('patches'), 'the shell step reached the twin database')
    assert.ok(r.diverged.files_changed.includes('changed: demo/app.config.json'))
    assert.equal(r.undo.status, 'RECOVERED')
    assert.equal(r.undo.verification.status, 'PASS')
    assert.ok(r.undo.verification.checked.includes('table_checksum'))
    assert.deepEqual(isolated, { ports: '', internal: ['true'] })

    // The real database: same schema, rows and checksums; patches untouched by the shell step.
    const realAfter = await measureReal()
    assert.deepEqual(realAfter, realBefore)
    assert.equal((await psql(realTarget, { sql: 'SELECT count(*) FROM patches WHERE available_count = 99' })).stdout.trim(), '0')
    assert.equal(readFileSync(path.join(repoDir, 'demo/app.config.json'), 'utf8'), JSON.stringify({ feature: 'off' }) + '\n', 'the real workspace file is untouched')

    // Nothing of the twin is left.
    assert.equal(r.cleanup.clean, true, JSON.stringify(r.cleanup))
    const filter = `label=com.docker.compose.project=${r.twin_project}`
    for (const args of [['ps', '-a', '-q', '--filter', filter], ['volume', 'ls', '-q', '--filter', filter], ['network', 'ls', '-q', '--filter', filter]]) assert.equal((await run('docker', args)).stdout.trim(), '', args[0])
    assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: repoDir, encoding: 'utf8' }).trim().split('\n').length, 1, 'no worktree left')
    assert.deepEqual(twinKeyDirs(), keysBefore, 'no throwaway key directory left')

    // One signed receipt in the real chain, and the ordering rules still hold.
    const c = verifyChain({ repoDir, home, publicKey: keys.publicKey, missionId: parsed.contract.id })
    assert.equal(c.ok, true)
    assert.deepEqual(c.receipts.map((x) => [x.kind, x.verdict]), [['recovery_rehearsal', 'RECOVERY PROVEN']])
    assert.deepEqual(checkPolicy(c.receipts).findings, [])
  })
})
