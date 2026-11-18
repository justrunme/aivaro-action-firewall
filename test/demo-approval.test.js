/**
 * T23 against real Docker and Postgres. The agent side uses only the MCP server; the
 * human side uses only the CLI (approvals, approve, deny), in a separate process that
 * is the only one holding the approver passphrase. In the third case the human approves
 * in the Console (T27), whose process never has the passphrase in its environment.
 *
 *   rehearse (DENIED) -> revise -> rehearse (SAFE) -> request_approval (PENDING)
 *   -> run_mission refused -> approve --confirm -> run_mission COMPLETED, matches the
 *   rehearsal -> second approve and second run refused -> undo_mission RECOVERED
 *   -> verify_recovery PASS -> replay_mission PASS
 *
 * and: a file changed after the request cannot be approved; a denied request cannot
 * be approved afterwards and the run stays refused.
 *
 * The MCP server runs without the passphrase, and while it works the sealed approver
 * key file is unreadable, so a passing run shows the server never needs that file.
 *
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
const CLI = new URL('../src/cli/index.js', import.meta.url).pathname

const DANGEROUS = 'CREATE TABLE orders_v2 AS SELECT id, patch_id, quantity FROM orders WHERE quantity >= 10;\nDROP TABLE orders;\nALTER TABLE orders_v2 RENAME TO orders;\n'
const SAFE = "ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'new';\n"

describe('Demo approval: the agent asks, the operator approves once, the run matches the rehearsal, undo restores', { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-apr-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'jrm-demo-apr-keys-'))
  const passphrase = randomBytes(18).toString('hex')
  const project = `jrm-demoapr-${randomBytes(4).toString('hex')}`
  const real = { project, composeFile: path.join(repoDir, 'demo/docker-compose.yml'), dbService: 'db', dbUser: 'demo_user', dbName: 'pumpkin_patch', overrideFile: writeNoPortsOverride(['db', 'app']) }
  const measureReal = () => measureDatabase((sql) => psql(real, { sql }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@demo.invalid', ...args], { cwd: repoDir, stdio: 'pipe' })
  const sealed = path.join(home, 'approver.key.enc')
  // Root reads files regardless of their mode; the lock-out check is meaningful only for a normal user.
  const canLockOut = typeof process.getuid !== 'function' || process.getuid() !== 0
  const lockKey = () => chmodSync(sealed, 0o000)
  const unlockKey = () => chmodSync(sealed, 0o600)
  const baseEnv = () => {
    const env = { ...process.env, JUSTRUNME_HOME: home }
    delete env.DOCKER_DEFAULT_PLATFORM
    delete env.JUSTRUNME_APPROVER_PASSPHRASE
    return env
  }
  /** The operator at a terminal: the only process that gets the passphrase. */
  const operator = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repoDir, env: { ...baseEnv(), JUSTRUNME_APPROVER_PASSPHRASE: passphrase }, encoding: 'utf8' })
    return { code: r.status, out: JSON.parse(r.stdout) }
  }
  let server
  let serverEnv

  before(async () => {
    mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
    copyFileSync(path.join(DEMO, 'docker-compose.yml'), path.join(repoDir, 'demo/docker-compose.yml'))
    for (const f of ['001_init.sql', '002_seed_data.sql']) copyFileSync(path.join(DEMO, 'migrations', f), path.join(repoDir, 'demo/migrations', f))
    // *.local.sql is ignored by git, so the source fingerprint does not see those files (case 3).
    writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\ndemo/migrations/*.local.sql\n')
    writeFileSync(path.join(repoDir, 'justrunme.target.json'), JSON.stringify({ project, compose_file: 'demo/docker-compose.yml', db_service: 'db', db_user: 'demo_user', db_name: 'pumpkin_patch' }))
    writeFileSync(
      path.join(repoDir, 'justrunme.mission.yaml'),
      stringify({
        id: 'mission-demo-approval',
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
    assert.equal(operator('keys', 'init').code, 0)
    const init = operator('approver', 'init')
    assert.equal(init.code, 0, JSON.stringify(init.out))
    serverEnv = baseEnv()
    server = startServer({ cwd: repoDir, entry: ENTRY, env: serverEnv })
    await server.initialize()
  })

  after(async () => {
    server?.close()
    await down(real)
    try {
      unlockKey()
    } catch {
      // already gone
    }
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('denied, revised, requested, refused before approval, approved once, run as rehearsed, undone, verified, replayed', async () => {
    assert.equal(serverEnv.JUSTRUNME_APPROVER_PASSPHRASE, undefined, 'the MCP server never gets the approver passphrase')
    if (canLockOut) lockKey()
    const before = await measureReal()

    // The agent: a dangerous plan is denied with measurements, a revised plan is SAFE.
    writeFileSync(path.join(repoDir, 'demo/migrations/003_consolidate_orders.sql'), DANGEROUS)
    const denied = (await server.call('rehearse', { migrations: ['demo/migrations/003_consolidate_orders.sql'] })).payload
    assert.deepEqual([denied.status, denied.reason], ['DENIED', 'DATA_LOSS'], JSON.stringify(denied))
    // A denied plan cannot even be asked about.
    const notSafe = (await server.call('request_approval', { plan_id: denied.plan_id })).payload
    assert.equal(notSafe.error.code, 'NOT_SAFE')
    unlinkSync(path.join(repoDir, 'demo/migrations/003_consolidate_orders.sql'))
    writeFileSync(path.join(repoDir, 'demo/migrations/003_add_order_status.sql'), SAFE)
    const safe = (await server.call('rehearse', { migrations: ['demo/migrations/003_add_order_status.sql'] })).payload
    assert.deepEqual([safe.status, safe.next_action], ['SAFE', 'REQUEST_APPROVAL'], JSON.stringify(safe))

    // The agent asks. Asking twice returns the request that is already waiting.
    const asked = (await server.call('request_approval', { plan_id: safe.plan_id, note: 'Adds a status column; no rows change.' })).payload
    assert.deepEqual([asked.status, asked.plan_id, asked.already_requested, asked.next_action], ['PENDING_APPROVAL', safe.plan_id, false, 'WAIT_FOR_OPERATOR'], JSON.stringify(asked))
    assert.match(asked.request_id, /^apr-[0-9a-f]{16}$/)
    const again = (await server.call('request_approval', { plan_id: safe.plan_id })).payload
    assert.deepEqual([again.request_id, again.already_requested], [asked.request_id, true])

    // Running before the operator answered is refused and changes nothing.
    const early = (await server.call('run_mission', { plan_id: safe.plan_id })).payload
    assert.deepEqual([early.status, early.error.code, early.next_action], ['REFUSED', 'NO_AUTHORIZATION', 'WAIT_FOR_OPERATOR'], JSON.stringify(early))
    assert.deepEqual(early.approval_requests.map((x) => [x.request_id, x.state]), [[asked.request_id, 'pending']])
    assert.deepEqual(await measureReal(), before, 'nothing ran before approval')

    // The operator: reads the request with the exact SQL and the measured impact.
    if (canLockOut) unlockKey()
    const shown = operator('approvals', asked.request_id)
    assert.equal(shown.code, 0, JSON.stringify(shown.out))
    assert.equal(shown.out.result.state, 'pending')
    assert.deepEqual(shown.out.result.files.map((f) => [f.path, f.matches_now, f.sql]), [['demo/migrations/003_add_order_status.sql', true, SAFE]])
    assert.deepEqual([shown.out.result.report.valid, shown.out.result.report.verdict], [true, 'SAFE'])
    assert.equal(shown.out.result.agent_note, 'Adds a status column; no rows change.')
    // Approval needs the plan id typed again.
    const unconfirmed = operator('approve', asked.request_id)
    assert.deepEqual([unconfirmed.code, unconfirmed.out.error.code], [2, 'CONFIRMATION_REQUIRED'])
    const approved = operator('approve', asked.request_id, '--confirm', safe.plan_id)
    assert.equal(approved.code, 0, JSON.stringify(approved.out))
    assert.deepEqual([approved.out.result.request_id, approved.out.result.plan_id], [asked.request_id, safe.plan_id])
    // One request, one approval.
    const twice = operator('approve', asked.request_id, '--confirm', safe.plan_id)
    assert.deepEqual([twice.code, twice.out.error.code], [26, 'REQUEST_APPROVED'])
    if (canLockOut) lockKey()

    // The agent runs the approved plan; the real result is what the rehearsal predicted.
    const ran = (await server.call('run_mission', { plan_id: safe.plan_id })).payload
    assert.deepEqual([ran.status, ran.matches_rehearsal, ran.next_action], ['COMPLETED', true, 'REPORT_TO_USER'], JSON.stringify(ran))
    assert.deepEqual(ran.differences, [])
    assert.match(ran.capture_id, /^cap-\d{14}-[0-9a-f]{6}$/)
    const afterRun = await measureReal()
    assert.notEqual(afterRun.schema_hash, before.schema_hash, 'the column was added')
    assert.equal(afterRun.tables.orders.rows, before.tables.orders.rows, 'no order was lost')
    // The authorization was single-use: a second run is refused and changes nothing.
    const second = (await server.call('run_mission', { plan_id: safe.plan_id })).payload
    assert.deepEqual([second.status, second.error.code], ['REFUSED', 'NO_AUTHORIZATION'], JSON.stringify(second))
    assert.deepEqual(await measureReal(), afterRun)

    // Undo, then an independent read-only check, then a replay of the whole chain.
    const undone = (await server.call('undo_mission', { capture_id: ran.capture_id })).payload
    assert.deepEqual([undone.status, undone.verification.status, undone.next_action], ['RECOVERED', 'PASS', 'REPORT_TO_USER'], JSON.stringify(undone))
    assert.deepEqual(await measureReal(), before, 'the database is back to the captured state')
    const checked = (await server.call('verify_recovery', { capture_id: ran.capture_id })).payload
    assert.deepEqual([checked.status, checked.failed], ['PASS', []], JSON.stringify(checked))
    // The used authorization file put back (the state matches it again after undo) is refused from the chain.
    const stateDir = path.join(repoDir, '.justrunme')
    const used = readdirSync(stateDir).find((n) => n.startsWith('authorization.used-'))
    copyFileSync(path.join(stateDir, used), path.join(stateDir, 'authorization.json'))
    const replayed = (await server.call('run_mission', { plan_id: safe.plan_id })).payload
    assert.deepEqual([replayed.status, replayed.error.code], ['REFUSED', 'AUTHORIZATION_USED'], JSON.stringify(replayed))
    unlinkSync(path.join(stateDir, 'authorization.json'))
    assert.deepEqual(await measureReal(), before)
    const replay = (await server.call('replay_mission', {})).payload
    assert.deepEqual([replay.status, replay.ok], ['PASS', true], JSON.stringify(replay))
    const kinds = (await server.call('get_receipt', {})).payload
    assert.equal(kinds.chain_ok, true)

    // T27.1: the story from the signed chain and the history archive, for the operator.
    const story = operator('history')
    assert.equal(story.code, 0, JSON.stringify(story.out))
    const s = story.out.result
    assert.deepEqual(s.versions.map((v) => [v.plan_id, v.verdict, v.impact.rows_lost]), [[denied.plan_id, 'DATA LOSS', 1], [safe.plan_id, 'SAFE', 0]])
    assert.deepEqual(s.versions.map((v) => v.files[0].sql), [DANGEROUS, SAFE])
    assert.ok(s.versions[0].impact.schema_delta.removed_columns.some((c) => c.startsWith('orders.')), 'the denied version removed a column')
    assert.deepEqual(s.requests.map((q) => [q.request_id, q.state, q.authorization.passphrase_source]), [[asked.request_id, 'approved', 'env']])
    assert.deepEqual(s.runs.map((r) => [r.verdict, r.matches_rehearsal, r.request_id, r.undo?.verdict]), [['completed', true, asked.request_id, 'undo']])
    assert.equal(s.runs[0].undo.verification, 'PASS')
    assert.deepEqual(s.links.map((l) => [l.ok, l.links.map((x) => x.code)]), [[true, ['APPROVED_VERSION_SAFE', 'AUTHORIZED_AS_REQUESTED', 'EXECUTED_AS_AUTHORIZED', 'RESULT_AS_REHEARSED']]])
    assert.deepEqual([s.history.ok, s.history.versions], [true, 2])

    const text = JSON.stringify([asked, early, ran, undone, checked, replay])
    assert.ok(!text.includes(repoDir) && !text.includes(home), 'no local path in anything the agent sees')
    assert.ok(!text.includes(passphrase))
    if (canLockOut) unlockKey()
  })

  it('a file changed after the request cannot be approved; a denied request stays denied and the run stays refused', async () => {
    if (canLockOut) lockKey()
    const before = await measureReal()
    const file = path.join(repoDir, 'demo/migrations/003_add_order_status.sql')
    writeFileSync(file, SAFE)
    const safe = (await server.call('rehearse', { migrations: ['demo/migrations/003_add_order_status.sql'] })).payload
    assert.equal(safe.status, 'SAFE', JSON.stringify(safe))
    const asked = (await server.call('request_approval', { plan_id: safe.plan_id })).payload
    assert.equal(asked.status, 'PENDING_APPROVAL', JSON.stringify(asked))
    assert.equal(asked.already_requested, false, 'a new rehearsal makes a new request')

    // The file is edited after it was rehearsed and requested.
    appendFileSync(file, 'UPDATE orders SET quantity = 0;\n')
    if (canLockOut) unlockKey()
    const changed = operator('approve', asked.request_id, '--confirm', safe.plan_id)
    assert.deepEqual([changed.code, changed.out.error.code, changed.out.error.detail?.files], [26, 'FILES_CHANGED', ['demo/migrations/003_add_order_status.sql']], JSON.stringify(changed.out))
    const shown = operator('approvals', asked.request_id)
    assert.deepEqual([shown.out.result.state, shown.out.result.files[0].matches_now], ['pending', false])

    // The operator denies; refusing needs a reason and no passphrase.
    const noReason = operator('deny', asked.request_id)
    assert.deepEqual([noReason.code, noReason.out.error.code], [2, 'REASON_REQUIRED'])
    const d = spawnSync(process.execPath, [CLI, 'deny', asked.request_id, '--reason', 'file changed after rehearsal'], { cwd: repoDir, env: baseEnv(), encoding: 'utf8' })
    assert.equal(d.status, 0, d.stdout)
    assert.equal(JSON.parse(d.stdout).result.denied, true)
    writeFileSync(file, SAFE)
    const late = operator('approve', asked.request_id, '--confirm', safe.plan_id)
    assert.deepEqual([late.code, late.out.error.code], [26, 'REQUEST_DENIED'])
    if (canLockOut) lockKey()

    const run = (await server.call('run_mission', { plan_id: safe.plan_id })).payload
    assert.deepEqual([run.status, run.error.code, run.next_action], ['REFUSED', 'NO_AUTHORIZATION', 'REQUEST_APPROVAL'], JSON.stringify(run))
    assert.deepEqual(run.approval_requests.find((x) => x.request_id === asked.request_id)?.state, 'denied')
    assert.deepEqual(await measureReal(), before, 'nothing ran')
    const replay = (await server.call('replay_mission', {})).payload
    assert.deepEqual([replay.status, replay.ok], ['PASS', true], JSON.stringify(replay))
    if (canLockOut) unlockKey()
  })

  it('a git-ignored migration never rehearses SAFE; a migration edited after approval stops the run', async () => {
    if (canLockOut) lockKey()
    const before = await measureReal()
    // A file git ignores is invisible to the source fingerprint, and it is not in the rehearsal copy either:
    // the rehearsal fails, so such a plan can never be asked about, let alone approved.
    const ignored = 'demo/migrations/004_order_note.local.sql'
    writeFileSync(path.join(repoDir, ignored), 'ALTER TABLE orders ADD COLUMN note TEXT;\n')
    assert.equal(execFileSync('git', ['check-ignore', ignored], { cwd: repoDir, encoding: 'utf8' }).trim(), ignored)
    const hidden = (await server.call('rehearse', { migrations: [ignored] })).payload
    assert.deepEqual([hidden.status, hidden.reason], ['DENIED', 'REHEARSAL_FAILED'], JSON.stringify(hidden))
    assert.equal((await server.call('request_approval', { plan_id: hidden.plan_id })).payload.error.code, 'NOT_SAFE')
    unlinkSync(path.join(repoDir, ignored))

    // The plan of the earlier cases, rehearsed again on the current workspace.
    const rel = 'demo/migrations/003_add_order_status.sql'
    writeFileSync(path.join(repoDir, rel), SAFE)
    const rehearsed = (await server.call('rehearse', { migrations: [rel] })).payload
    assert.equal(rehearsed.status, 'SAFE', JSON.stringify(rehearsed))
    // Several plans were rehearsed on this database state (the failed one above): the fixed rule decides which can be asked about.
    const cmp = (await server.call('compare', {})).payload
    assert.equal(cmp.recommended, rehearsed.plan_id, JSON.stringify(cmp))
    const safe = { plan_id: rehearsed.plan_id }
    // A workspace change after the rehearsal makes the plan not current: no request the operator could not approve.
    writeFileSync(path.join(repoDir, 'demo/migrations/005_draft.sql'), '-- draft\n')
    const stale = (await server.call('request_approval', { plan_id: safe.plan_id })).payload
    assert.deepEqual([stale.status, stale.error.code], ['REFUSED', 'PLAN_NOT_CURRENT'], JSON.stringify(stale))
    unlinkSync(path.join(repoDir, 'demo/migrations/005_draft.sql'))
    const asked = (await server.call('request_approval', { plan_id: safe.plan_id })).payload
    assert.equal(asked.status, 'PENDING_APPROVAL', JSON.stringify(asked))
    if (canLockOut) unlockKey()
    // T27: this time the operator approves in the Console. The Console process has no
    // passphrase in its environment; the passphrase is posted once and reaches
    // `justrunme approve --passphrase-stdin` on stdin.
    const consoleEnv = baseEnv()
    assert.equal(consoleEnv.JUSTRUNME_APPROVER_PASSPHRASE, undefined)
    const con = spawn(process.execPath, [CLI, 'console', '--port', '0'], { cwd: repoDir, env: consoleEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      const [line] = await once(createInterface({ input: con.stdout }), 'line')
      const started = JSON.parse(line)
      assert.equal(started.ok, true, line)
      const url = new URL(started.result.url)
      const token = url.hash.replace('#token=', '')
      const headers = { authorization: `Bearer ${token}`, origin: url.origin, 'content-type': 'application/json' }
      const shownInConsole = await (await fetch(new URL(`/api/approvals/${asked.request_id}`, url.origin), { headers })).json()
      assert.deepEqual([shownInConsole.result.state, shownInConsole.result.report.verdict], ['pending', 'SAFE'], JSON.stringify(shownInConsole))
      const res = await fetch(new URL('/api/approve', url.origin), { method: 'POST', headers, body: JSON.stringify({ request_id: asked.request_id, confirm: safe.plan_id, passphrase }) })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      assert.ok(!text.includes(passphrase), 'the passphrase is not echoed')
      const approved = JSON.parse(text)
      assert.deepEqual([approved.command, approved.ok, approved.result.request_id, approved.result.passphrase_source], ['approve', true, asked.request_id, 'stdin'], text)
      const story = await (await fetch(new URL('/api/state', url.origin), { headers })).json()
      const q = story.story.result.requests.find((x) => x.request_id === asked.request_id)
      assert.deepEqual([q.state, q.authorization.passphrase_source], ['approved', 'stdin'])
    } finally {
      con.kill('SIGTERM')
    }
    if (canLockOut) lockKey()

    // Edited after approval: the source fingerprint catches it first; the authorization's own file
    // hashes are checked again right before execution (test/authorization.test.js covers that check).
    appendFileSync(path.join(repoDir, asked.files[0]), 'DROP TABLE orders;\n')
    const run = (await server.call('run_mission', { plan_id: safe.plan_id })).payload
    assert.equal(run.status, 'REFUSED', JSON.stringify(run))
    assert.ok(['FIDELITY_MISMATCH', 'FILES_CHANGED'].includes(run.error.code), JSON.stringify(run))
    assert.deepEqual(await measureReal(), before, 'nothing ran')
    if (canLockOut) unlockKey()
  })
})
