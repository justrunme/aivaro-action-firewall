/**
 * T27 Console: who may talk to the local server, what it shows, and that approving
 * through it is the CLI's `approve --passphrase-stdin` and nothing else.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendReceipt } from '../src/receipts/chain.js'
import { hashValue } from '../src/util/canonical.js'
import { archiveRehearsal, snapshotPlanFiles } from '../src/history/archive.js'
import { startConsole } from '../src/console/server.js'
import { READ_COMMANDS, createApi, readArgv } from '../src/console/api.js'
import { STAGES, focus, pipeline, sameBase } from '../src/console/static/model.js'
import { lineDiff, sqlOf } from '../src/console/static/ui.js'
import { loadOrCreateTestKeys } from './support/keys.js'

const MISSION = 'mission-console-test'
const PLAN = 'plan-0123456789ab'
const DANGER = 'CREATE TABLE orders_v2 AS SELECT id FROM orders WHERE quantity >= 10;\nDROP TABLE orders;\n'
const SAFE = "ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'new';\n"
const T0 = Date.parse('2026-11-18T12:00:00.000Z')
const FAKE_CLI = fileURLToPath(new URL('./support/fake-cli.js', import.meta.url))
const CLI = fileURLToPath(new URL('../src/cli/index.js', import.meta.url))
const CONSOLE_DIR = fileURLToPath(new URL('../src/console/', import.meta.url))

const dirs = []
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}

const repoDir = tmp('jrm-console-')
let keys
let savedHome
const plan = [{ id: 'm1', tool: 'sql_migration', args: ['demo/migrations/003.sql'], reversibility: true }]

function rehearseVersion(sql, verdict, { rowsAfter = 3, at = T0, removed = [] } = {}) {
  writeFileSync(path.join(repoDir, 'demo/migrations/003.sql'), sql)
  const snap = snapshotPlanFiles(plan, repoDir)
  const report = {
    plan_id: PLAN, verdict, base_hash: 'sha256:' + 'b'.repeat(64), plan_files: snap.files,
    tables: { orders: { protected: true, rows_before: 3, rows_after: rowsAfter, rows_lost: 3 - rowsAfter, content_changed: false } },
    schema_delta: { changed: true, added_tables: [], removed_tables: [], added_columns: verdict === 'SAFE' ? ['orders.status'] : [], removed_columns: removed },
    steps: [{ id: 'm1', status: 'ok' }], signature: 'x',
  }
  const reportHash = archiveRehearsal(repoDir, MISSION, report, snap.blobs)
  const r = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'rehearsal', verdict, subject: { plan_id: PLAN, report_hash: reportHash, base_hash: report.base_hash, files_hash: hashValue(snap.files) }, now: at })
  return { reportHash, files: snap.files, receipt: r.hash }
}

function approveAndRun(v) {
  const req = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'approval_requested', verdict: 'pending', subject: { request_id: 'apr-00000000000000aa', plan_id: PLAN, report_hash: v.reportHash, files_hash: hashValue(v.files), expires_at: new Date(T0 + 3600 * 1000).toISOString() }, refs: { rehearsal: v.receipt }, now: T0 + 2000 })
  const auth = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'authorization_issued', verdict: 'allow', subject: { plan_id: PLAN, report_hash: v.reportHash, plan_files_hash: hashValue(v.files), passphrase_source: 'stdin' }, refs: { rehearsal: v.receipt, approval: req.hash }, now: T0 + 3000 })
  appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'run_result', verdict: 'completed', subject: { plan_id: PLAN, capture_id: 'cap-20261118120000-abcdef', plan_files_hash: hashValue(v.files), report_hash: v.reportHash, matches_rehearsal: true, differences: 0 }, refs: { authorization: auth.hash }, now: T0 + 4000 })
}

/** node:http, because fetch does not let a test set Host. */
function call(port, { method = 'GET', path: p = '/api/state', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          // static files
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

let c
let fake
const auth = () => ({ authorization: `Bearer ${c.token}` })
const post = (port, p, body, extra = {}) => call(port, { method: 'POST', path: p, headers: { authorization: `Bearer ${port === c.port ? c.token : fake.token}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })

before(async () => {
  mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
  const home = tmp('jrm-console-keys-')
  keys = loadOrCreateTestKeys(home)
  savedHome = process.env.JUSTRUNME_HOME
  process.env.JUSTRUNME_HOME = home
  rehearseVersion(DANGER, 'DATA LOSS', { rowsAfter: 2, removed: ['orders.patch_id'] })
  const b = rehearseVersion(SAFE, 'SAFE', { at: T0 + 1000 })
  approveAndRun(b)
  c = await startConsole({ repoDir, mission: MISSION })
  fake = await startConsole({ repoDir, mission: MISSION, cliPath: FAKE_CLI, env: { ...process.env, JUSTRUNME_APPROVER_PASSPHRASE: 'must-not-reach-the-child' } })
})

after(async () => {
  await c?.close()
  await fake?.close()
  if (savedHome === undefined) delete process.env.JUSTRUNME_HOME
  else process.env.JUSTRUNME_HOME = savedHome
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
})

describe('Console access (T27)', () => {
  it('listens on 127.0.0.1 and serves the page with a strict CSP; the page holds no data', async () => {
    assert.match(c.url, new RegExp(`^http://127\\.0\\.0\\.1:${c.port}/#token=[0-9a-f]{64}$`))
    const page = await call(c.port, { path: '/' })
    assert.equal(page.status, 200)
    assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'/)
    assert.equal(page.headers['cache-control'], 'no-store')
    assert.equal(page.headers['x-frame-options'], 'DENY')
    assert.ok(page.text.includes('Missions') && !page.text.includes(MISSION))
    assert.equal((await call(c.port, { path: '/../package.json' })).status, 404)
    assert.equal((await call(c.port, { path: '//evil.example/api/state', headers: auth() })).status, 400)
  })

  it('an API call without the token, or with another token, is refused', async () => {
    assert.equal((await call(c.port)).status, 401)
    assert.equal((await call(c.port, { headers: { authorization: 'Bearer ' + '0'.repeat(64) } })).status, 401)
    assert.equal((await call(c.port, { headers: { authorization: c.token } })).status, 401)
  })

  it('a Host other than this server is refused even with the token (DNS rebinding)', async () => {
    for (const host of ['evil.example', `evil.example:${c.port}`, `127.0.0.1:${c.port + 1}`]) {
      const r = await call(c.port, { headers: { ...auth(), host } })
      assert.deepEqual([r.status, r.json.error.code], [403, 'BAD_HOST'], host)
    }
    assert.equal((await call(c.port, { headers: { ...auth(), host: `localhost:${c.port}` } })).status, 200)
  })

  it('a POST needs this Origin and a JSON body', async () => {
    const body = { request_id: 'apr-00000000000000aa', reason: 'no' }
    assert.deepEqual((await post(c.port, '/api/deny', body, { origin: '' })).json.error.code, 'BAD_ORIGIN')
    assert.deepEqual((await post(c.port, '/api/deny', body, { origin: 'http://evil.example' })).json.error.code, 'BAD_ORIGIN')
    assert.deepEqual((await post(c.port, '/api/deny', body, { 'content-type': 'text/plain' })).status, 415)
    assert.deepEqual((await call(c.port, { method: 'DELETE', headers: auth() })).status, 405)
  })
})

describe('justrunme console (T27)', () => {
  it('starts from the CLI, prints the URL with the token and serves the API until stopped', { timeout: 20000 }, async () => {
    const child = spawn(process.execPath, [CLI, 'console', '--port', '0', '--repo', repoDir, '--mission', MISSION], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      const [line] = await once(createInterface({ input: child.stdout }), 'line')
      const out = JSON.parse(line)
      assert.equal(out.ok, true, line)
      const url = new URL(out.result.url)
      assert.equal(url.hostname, '127.0.0.1')
      const r = await call(Number(url.port), { headers: { authorization: `Bearer ${url.hash.replace('#token=', '')}` } })
      assert.deepEqual([r.status, r.json.story.result.mission_id], [200, MISSION])
    } finally {
      child.kill('SIGTERM')
    }
    const [code] = await once(child, 'exit')
    assert.equal(code, 0)
  })

  it('refuses a bad port or mission before starting', () => {
    for (const args of [['--port', 'x'], ['--port', '70000'], ['--mission', '../x'], ['--nope']]) {
      const r = spawnSync(process.execPath, [CLI, 'console', ...args], { encoding: 'utf8', timeout: 10000 })
      assert.deepEqual([r.status, JSON.parse(r.stdout).error.code], [2, 'USAGE'], args.join(' '))
    }
  })
})

describe('Console data (T27)', () => {
  it('shows the story, verification and approvals the CLI computes, without local paths', async () => {
    const r = await call(c.port, { headers: auth() })
    assert.equal(r.status, 200)
    const { story, verify, approvals, status } = r.json
    assert.deepEqual([story.command, story.ok], ['history', true])
    const s = story.result
    assert.deepEqual(s.versions.map((v) => [v.verdict, v.impact.rows_lost, v.files[0].sql]), [['DATA LOSS', 1, DANGER], ['SAFE', 0, SAFE]])
    assert.deepEqual(s.links[0].links.map((l) => [l.code, l.ok]), [['APPROVED_VERSION_SAFE', true], ['AUTHORIZED_AS_REQUESTED', true], ['EXECUTED_AS_AUTHORIZED', true], ['RESULT_AS_REHEARSED', true]])
    assert.deepEqual(s.timeline.map((t) => t.kind), ['rehearsal', 'rehearsal', 'approval_requested', 'authorization_issued', 'run_result'])
    assert.ok(s.timeline.every((t) => /^sha256:[0-9a-f]{64}$/.test(t.hash)))
    assert.equal(verify.command, 'verify')
    assert.equal(verify.result.history.ok, true)
    assert.deepEqual(approvals.result.requests, [])
    assert.equal(status.result.mission_id, MISSION)
    assert.ok(!r.text.includes(repoDir) && !r.text.includes(process.env.JUSTRUNME_HOME), 'no local path')
  })

  it('one receipt by seq, and bad ids are refused before anything runs', async () => {
    const one = await call(c.port, { path: '/api/receipt/0', headers: auth() })
    assert.deepEqual([one.status, one.json.result.receipt.kind], [200, 'rehearsal'])
    assert.equal((await call(c.port, { path: '/api/receipt/x1', headers: auth() })).json.error.code, 'INVALID_SEQ')
    assert.equal((await call(c.port, { path: '/api/approvals/apr-..%2F..', headers: auth() })).json.error.code, 'REQUEST_INVALID')
  })

  it('the Missions screen model: Plan A denied, Plan B safe, approved, executed, verified', async () => {
    const s = (await call(c.port, { headers: auth() })).json.story.result
    const f = focus(s)
    assert.deepEqual([f.a.verdict, f.b.verdict, f.approved.request_id, f.run.seq], ['DATA LOSS', 'SAFE', 'apr-00000000000000aa', 4])
    assert.deepEqual(pipeline(s).map((p) => [p.name, p.state]), [['PROPOSED', 'done'], ['REHEARSED', 'done'], ['DENIED', 'denied'], ['REVISED', 'done'], ['SAFE', 'done'], ['APPROVED', 'done'], ['EXECUTED', 'done'], ['VERIFIED', 'done']])
    assert.equal(sameBase(f.a, f.b), true)
    // A broken link shows as broken, not as done.
    const broken = structuredClone(s)
    broken.links[0].links[3].ok = false
    assert.equal(pipeline(broken).find((p) => p.name === 'VERIFIED').state, 'broken')
    assert.deepEqual(pipeline({ versions: [], requests: [], runs: [], links: [] }).map((p) => p.state), ['waiting', 'waiting', 'none', 'none', 'waiting', 'waiting', 'waiting', 'waiting'])
    assert.equal(STAGES.length, 8)
    // The Impact Diff line diff: Plan A's lines removed, Plan B's added, shared lines kept.
    assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nx\nc\n'), [{ sign: ' ', text: 'a' }, { sign: '-', text: 'b' }, { sign: '+', text: 'x' }, { sign: ' ', text: 'c' }])
    assert.deepEqual(lineDiff(sqlOf(f.a), sqlOf(f.b)).filter((l) => l.sign !== ' ').map((l) => l.sign + l.text), ['-' + DANGER.split('\n')[0], '-' + DANGER.split('\n')[1], '+' + SAFE.trim()])
  })
})

describe('Console writes go through the CLI (T27)', () => {
  it('approve starts `approve --passphrase-stdin`; the passphrase is on stdin only, never in argv or the environment', async () => {
    const pass = 'a passphrase typed in the console'
    const r = await post(fake.port, '/api/approve', { request_id: 'apr-00000000000000aa', confirm: PLAN, passphrase: pass })
    assert.equal(r.status, 200, r.text)
    const got = r.json.result
    assert.deepEqual(got.argv.slice(0, 5), ['approve', 'apr-00000000000000aa', '--confirm', PLAN, '--passphrase-stdin'])
    assert.ok(got.argv.includes('--repo') && got.argv.includes(MISSION))
    assert.ok(!got.argv.some((a) => a.includes(pass)))
    assert.equal(got.stdin_sha256, createHash('sha256').update(pass + '\n').digest('hex'), 'the passphrase went to the child on stdin')
    assert.ok(!r.text.includes(pass), 'and it is not in the response')
    assert.equal(got.env_has_passphrase, false, 'JUSTRUNME_APPROVER_PASSPHRASE is removed from the child environment')
    assert.equal(got.env_has_home, true)
  })

  it('a missing passphrase, a multi-line passphrase, a wrong confirmation or a malformed id never starts the CLI', async () => {
    const cases = [
      [{ request_id: 'apr-00000000000000aa', confirm: PLAN }, 'PASSPHRASE_REQUIRED'],
      [{ request_id: 'apr-00000000000000aa', confirm: PLAN, passphrase: 'one\ntwo' }, 'PASSPHRASE_REQUIRED'],
      [{ request_id: 'apr-00000000000000aa', confirm: 'yes', passphrase: 'p' }, 'CONFIRMATION_REQUIRED'],
      [{ request_id: '--repo', confirm: PLAN, passphrase: 'p' }, 'REQUEST_INVALID'],
    ]
    for (const [body, code] of cases) {
      const r = await post(fake.port, '/api/approve', body)
      assert.deepEqual([r.status, r.json.error.code], [400, code], JSON.stringify(body))
    }
    const undo = await post(fake.port, '/api/undo', { capture_id: 'cap-20261118120000-abcdef', confirm: 'cap-20261118120000-abcdee' })
    assert.deepEqual([undo.status, undo.json.error.code], [400, 'CONFIRMATION_REQUIRED'])
    const deny = await post(fake.port, '/api/deny', { request_id: 'apr-00000000000000aa', reason: '' })
    assert.deepEqual([deny.status, deny.json.error.code], [400, 'REASON_REQUIRED'])
    // A reason that looks like an option stays one argument: the reason.
    for (const reason of ['--confirm plan-0123456789ab', '-x is why', '-- end']) {
      const d = await post(fake.port, '/api/deny', { request_id: 'apr-00000000000000aa', reason })
      assert.deepEqual(d.json.result.argv.slice(0, 3), ['deny', 'apr-00000000000000aa', `--reason=${reason}`])
    }
    const okUndo = await post(fake.port, '/api/undo', { capture_id: 'cap-20261118120000-abcdef', confirm: 'cap-20261118120000-abcdef' })
    assert.deepEqual(okUndo.json.result.argv.slice(0, 2), ['undo', 'cap-20261118120000-abcdef'])
    assert.equal(okUndo.json.result.stdin_bytes, 0)
  })

  it('in-process the Console can run only read commands, and its source never touches the approver key', async () => {
    assert.deepEqual([...READ_COMMANDS].sort(), ['approvals', 'evidence', 'history', 'receipt', 'replay', 'status', 'verify'])
    const files = []
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name))
        else if (e.name.endsWith('.js')) files.push(path.join(d, e.name))
      }
    }
    walk(CONSOLE_DIR)
    assert.ok(files.length >= 6)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      assert.doesNotMatch(src, /approver\.js|approveCmd|authorizeCmd|authorizeMission|loadApproverKey|createApproverKey|commands\.js/, path.basename(f))
    }
    // The CLI code loaded in this process includes approve; the read path refuses it and every other write.
    for (const w of ['approve', 'authorize', 'deny', 'undo', 'run', 'approver', 'keys', 'reanchor', 'lock', 'gate-probe']) assert.throws(() => readArgv(w, [], []), /not a read command/)
    assert.deepEqual(readArgv('history', [], ['--repo', 'x']), ['history', '--repo', 'x'])
    // Every in-process call the API makes is a read command.
    const seen = []
    const api = createApi({ repoDir, mission: MISSION, runMain: async (argv) => (seen.push(argv[0]), { output: { ok: true, result: {} } }) })
    await api.state()
    await api.replay()
    await api.receipt('0')
    await api.approval('apr-00000000000000aa')
    assert.ok(seen.length === 8 && seen.every((c) => READ_COMMANDS.includes(c)), seen.join())
    assert.equal(Object.keys(api).includes('read'), false)
  })
})
