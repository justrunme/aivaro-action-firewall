/**
 * Demo B end to end (R4.1 to R4.4, R4.6, R5.1 to R5.3, R5.6, R5.7, R14.1 to R14.4).
 *
 * The real stack runs the demo app and Postgres. A plan rehearses SAFE, then in the
 * real run its second step fails because of a difference the rehearsal could not
 * see (a notification service that is unreachable in this environment, simulated
 * by DEMO_NOTIFY_FAIL=1 for the real run only). By then step 1 has changed data
 * and the script has changed files. Undo restores everything and verification
 * checks each value separately, including /health. Negative controls make sure
 * verification fails when it should and that a failed restore keeps the data.
 *
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { parseContract } from '../src/contract/parser.js'
import { loadOrCreateKeys, signValue } from '../src/receipts/keys.js'
import { rehearse } from '../src/rehearsal/engine.js'
import { measureDatabase } from '../src/rehearsal/measure.js'
import { down, psql, up, writeNoPortsOverride } from '../src/rehearsal/compose.js'
import { authorizeMission, runMission } from '../src/run/mission.js'
import { captureDir } from '../src/capture/capture.js'
import { undoMission, UndoRefused } from '../src/undo/undo.js'
import { verifyRecovery } from '../src/undo/verify.js'
import { loadManifest } from '../src/capture/capture.js'
import { verifyChain } from '../src/receipts/chain.js'
import { checkPolicy } from '../src/receipts/policy.js'

const enabled = process.platform === 'linux' || process.env.JRM_DOCKER_TESTS === '1'
const DEMO = new URL('../demo/', import.meta.url).pathname
const HEALTH = { service: 'app', url: 'http://localhost:3000/health' }

const BACKFILL = `-- Double every order quantity and add a region column (no rows or columns removed).
UPDATE orders SET quantity = quantity * 2;
ALTER TABLE patches ADD COLUMN region TEXT NOT NULL DEFAULT 'north';
`
const NOTIFY = `import { appendFileSync, writeFileSync } from 'node:fs'
appendFileSync('demo/migrations/applied.log', 'backfill applied\\n')
writeFileSync('demo/app.config.json', JSON.stringify({ feature: 'on', backfill: true }) + '\\n')
if (process.env.DEMO_NOTIFY_FAIL === '1') {
  console.error('notification service unreachable')
  process.exit(1)
}
`

describe('Demo B: a failed run is undone and the recovery is verified', { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-b-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-b-keys-'))
  const target = {
    project: `jrm-demob-real-${randomBytes(4).toString('hex')}`,
    composeFile: 'demo/docker-compose.yml',
    dbService: 'db',
    dbUser: 'demo_user',
    dbName: 'pumpkin_patch',
  }
  const realTarget = { ...target, composeFile: path.join(repoDir, target.composeFile), overrideFile: writeNoPortsOverride(['db', 'app']) }
  const measureReal = () => measureDatabase((sql) => psql(realTarget, { sql }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@demo.invalid', ...args], { cwd: repoDir, stdio: 'pipe' })
  const fileText = (rel) => (existsSync(path.join(repoDir, rel)) ? readFileSync(path.join(repoDir, rel), 'utf8') : null)
  const keys = loadOrCreateKeys(home)
  let contract
  let baseline
  let captureId

  before(async () => {
    cpSync(DEMO, path.join(repoDir, 'demo'), { recursive: true, filter: (src) => !src.includes('node_modules') && !src.endsWith('.test.js') })
    rmSync(path.join(repoDir, 'demo/migrations/003_backfill.sql'), { force: true })
    mkdirSync(path.join(repoDir, 'demo/scripts'), { recursive: true })
    writeFileSync(path.join(repoDir, 'demo/scripts/notify.js'), NOTIFY)
    writeFileSync(path.join(repoDir, 'demo/app.config.json'), JSON.stringify({ feature: 'off' }) + '\n')
    writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\nnode_modules/\n')
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'demo base')
    // The app applies 001 and 002 itself at start; --wait returns once /health is healthy.
    await up(realTarget, ['db', 'app'])
  })

  after(async () => {
    await down(realTarget)
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('R14.1: the plan rehearses SAFE, then fails in the real run after changing data and files', async () => {
    writeFileSync(path.join(repoDir, 'demo/migrations/003_backfill.sql'), BACKFILL)
    const text = stringify({
      id: 'mission-demo-b',
      objective: 'Backfill order quantities and record the change',
      allowed_paths: ['demo/migrations/'],
      protected_tables: ['orders', 'patches'],
      time_limit_seconds: 300,
      irreversible_actions: [],
      plan: [
        { id: 'backfill', tool: 'sql_migration', args: ['demo/migrations/003_backfill.sql'], reversibility: true },
        { id: 'notify', tool: 'shell', args: ['node', 'demo/scripts/notify.js'], reversibility: true },
      ],
      resources: { databases: ['pumpkin_patch'], config_files: ['demo/app.config.json'], compose_services: ['db', 'app'] },
    })
    writeFileSync(path.join(repoDir, 'justrunme.mission.yaml'), text)
    const parsed = parseContract(text)
    assert.equal(parsed.ok, true)
    contract = parsed

    const report = await rehearse({ repoDir, contract: parsed.contract, contractHash: parsed.hash, target, keys })
    assert.equal(report.verdict, 'SAFE', JSON.stringify(report.evidence))
    await authorizeMission({ repoDir, contract: parsed.contract, contractHash: parsed.hash, target, keys })

    baseline = { db: await measureReal(), log: fileText('demo/migrations/applied.log'), config: fileText('demo/app.config.json') }
    process.env.DEMO_NOTIFY_FAIL = '1'
    let result
    try {
      result = await runMission({ repoDir, contract: parsed.contract, contractHash: parsed.hash, target, keys })
    } finally {
      delete process.env.DEMO_NOTIFY_FAIL
    }
    assert.equal(result.ok, false)
    assert.deepEqual(result.steps.map((s) => s.status), ['ok', 'failed'])
    assert.match(result.steps[1].detail, /notification service unreachable/)
    captureId = result.capture_id

    // The failure left real damage behind.
    const after = await measureReal()
    assert.notEqual(after.tables.orders.checksum, baseline.db.tables.orders.checksum)
    assert.notEqual(after.schema_hash, baseline.db.schema_hash)
    assert.equal(fileText('demo/migrations/applied.log'), 'backfill applied\n')
    assert.notEqual(fileText('demo/app.config.json'), baseline.config)
    // The capture is intact and signed.
    assert.equal(loadManifest(repoDir, 'mission-demo-b', captureId, keys.publicKey).problem, null)
  })

  it('R14.2, R14.3, R4.3: undo restores files, config and Postgres; every check is asserted', async () => {
    const r = await undoMission({ repoDir, missionId: 'mission-demo-b', captureId, target, keys, health: HEALTH })
    assert.deepEqual(r.resources.map((x) => x.resource), ['config_files', 'containers', 'postgres', 'files'])
    assert.ok(r.resources.every((x) => x.status === 'succeeded'), JSON.stringify(r.resources))
    assert.equal(r.verification.status, 'PASS', JSON.stringify(r.verification.failed))
    assert.equal(r.status, 'RECOVERED')

    const kinds = (check) => r.verification.checks.filter((c) => c.check === check)
    assert.equal(kinds('schema_hash').length, 1)
    for (const t of ['orders', 'patches']) {
      assert.ok(kinds('row_count').some((c) => c.resource === `pumpkin_patch.${t}` && c.ok))
      assert.ok(kinds('table_checksum').some((c) => c.resource === `pumpkin_patch.${t}` && c.ok))
    }
    assert.ok(kinds('file_sha256').some((c) => c.resource === 'demo/app.config.json' && c.ok))
    assert.equal(kinds('file_absent').length, 0)
    assert.deepEqual(kinds('health').map((c) => c.actual), [200])
    assert.ok(kinds('container_image').length >= 2)

    // Independently of the verifier: the live state equals the state before the run.
    const now = await measureReal()
    assert.equal(now.schema_hash, baseline.db.schema_hash)
    assert.deepEqual(now.tables, baseline.db.tables)
    assert.equal(fileText('demo/migrations/applied.log'), baseline.log)
    assert.equal(fileText('demo/app.config.json'), baseline.config)
  })

  it('R4.3: running undo again gives the same verified state', async () => {
    const r = await undoMission({ repoDir, missionId: 'mission-demo-b', captureId, target, keys, health: HEALTH })
    assert.equal(r.status, 'RECOVERED', JSON.stringify(r.verification.failed))
    assert.deepEqual((await measureReal()).tables, baseline.db.tables)
  })

  it('R14.4, R5.6, R5.7: corrupting one restored value makes verification FAIL with expected and actual', async () => {
    const r1 = await psql(realTarget, { sql: 'UPDATE orders SET quantity = 999 WHERE id = 1' })
    assert.equal(r1.code, 0, r1.stderr)
    writeFileSync(path.join(repoDir, 'demo/migrations/stray.sql'), '-- left behind\n')
    const { manifest } = loadManifest(repoDir, 'mission-demo-b', captureId, keys.publicKey)
    const v = await verifyRecovery({ repoDir, manifest, target: realTarget, health: HEALTH })
    assert.equal(v.status, 'FAIL')
    const bad = v.failed.find((c) => c.check === 'table_checksum' && c.resource === 'pumpkin_patch.orders')
    assert.ok(bad && bad.expected !== bad.actual && typeof bad.expected === 'string')
    assert.ok(v.failed.some((c) => c.check === 'file_absent' && c.resource === 'demo/migrations/stray.sql'))
    // Row counts are unchanged, so a count-only check would have passed.
    assert.ok(v.checks.some((c) => c.check === 'row_count' && c.resource === 'pumpkin_patch.orders' && c.ok))
  })

  it('criterion 6: a restore that fails keeps the live data and the capture, and a retry succeeds', async () => {
    const dumpFile = path.join(captureDir(repoDir, 'mission-demo-b', captureId), 'pg', 'pumpkin_patch.sql')
    const manifestFile = path.join(captureDir(repoDir, 'mission-demo-b', captureId), 'manifest.json')
    const goodDump = readFileSync(dumpFile)
    const goodManifest = readFileSync(manifestFile)
    const liveBefore = await measureReal()

    // (a) a dump that no longer matches its checksum is refused before anything is touched.
    writeFileSync(dumpFile, goodDump.subarray(0, Math.floor(goodDump.length / 2)))
    let r = await undoMission({ repoDir, missionId: 'mission-demo-b', captureId, target, keys, resources: ['postgres'] })
    const pg = r.resources.find((x) => x.resource === 'postgres')
    assert.equal(pg.status, 'failed')
    assert.match(pg.detail, /checksum; live database untouched/)
    assert.deepEqual(await measureReal(), liveBefore)

    // (b) a dump whose checksum matches but whose SQL fails to load (re-signed by the
    // operator to get past the checksum) also leaves the live database untouched.
    const broken = Buffer.concat([goodDump, Buffer.from('\nTHIS IS NOT SQL;\n')])
    writeFileSync(dumpFile, broken)
    const m = JSON.parse(goodManifest)
    const { signature, ...body } = m
    body.postgres[0].sha256 = 'sha256:' + (await import('../src/util/canonical.js')).sha256Hex(broken)
    writeFileSync(manifestFile, JSON.stringify({ ...body, signature: signValue(keys.privateKey, body) }))
    r = await undoMission({ repoDir, missionId: 'mission-demo-b', captureId, target, keys, resources: ['postgres'] })
    assert.equal(r.resources[0].status, 'failed')
    assert.match(r.resources[0].detail, /loading the dump failed.*live database untouched/)
    assert.deepEqual(await measureReal(), liveBefore)

    // (c) with the original capture back in place, the retry recovers fully.
    writeFileSync(dumpFile, goodDump)
    writeFileSync(manifestFile, goodManifest)
    r = await undoMission({ repoDir, missionId: 'mission-demo-b', captureId, target, keys, health: HEALTH })
    assert.equal(r.status, 'RECOVERED', JSON.stringify(r.verification.failed))
    assert.deepEqual((await measureReal()).tables, baseline.db.tables)
  })

  it('R7.1 to R7.3: the whole mission is one signed chain that verifies and follows the ordering rules', () => {
    const v = verifyChain({ repoDir, home, publicKey: keys.publicKey, missionId: 'mission-demo-b' })
    assert.equal(v.ok, true, JSON.stringify(v.findings))
    assert.equal(checkPolicy(v.receipts).ok, true, JSON.stringify(checkPolicy(v.receipts).findings))
    const story = v.receipts.map((r) => `${r.kind}:${r.verdict}`)
    // rehearsal SAFE -> authorization -> failed real run -> undo -> PASS, then the later undo / verification pairs.
    assert.deepEqual(story.slice(0, 5), ['rehearsal:SAFE', 'authorization_issued:allow', 'run_result:failed', 'undo:undo', 'verification:PASS'])
    const run = v.receipts.find((r) => r.kind === 'run_result')
    assert.deepEqual(run.subject.steps.map((s) => s.status), ['ok', 'failed'])
    // The failed restore attempts are on record too, with verification FAIL.
    assert.ok(story.includes('verification:FAIL'))
    assert.equal(story.at(-1), 'verification:PASS')
  })

  it('R4.6: undo refuses unsupported resource types and an unsigned capture', async () => {
    await assert.rejects(
      undoMission({ repoDir, missionId: 'mission-demo-b', captureId, target, keys, resources: ['email'] }),
      (e) => e instanceof UndoRefused && e.code === 'UNSUPPORTED_RESOURCE'
    )
    const other = loadOrCreateKeys(mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-b-other-')))
    await assert.rejects(
      undoMission({ repoDir, missionId: 'mission-demo-b', captureId, target, keys: other }),
      (e) => e.code === 'CAPTURE_INVALID'
    )
  })
})
