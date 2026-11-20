/**
 * Console, several missions in one workspace: the API lists and scopes them, the Missions
 * screen shows one card per mission, a recovered run is RECOVERED · VERIFIED, the Impact
 * Diff starts from the worst measured loss and names the trigger that fired, and the
 * Approval Center and the undo need no typed ids. Built from real receipt chains; the
 * screens run on the small fake DOM (test/support/fake-dom.js), which checks no layout.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendReceipt } from '../src/receipts/chain.js'
import { hashValue } from '../src/util/canonical.js'
import { archiveRehearsal, snapshotPlanFiles } from '../src/history/archive.js'
import { createApi, listMissions } from '../src/console/api.js'
import { startConsole } from '../src/console/server.js'
import { latestSafe, missionVerdict, runOutcome, severest } from '../src/console/static/model.js'
import { loadOrCreateTestKeys } from './support/keys.js'
import { findAll, hasClass, installFakeDom } from './support/fake-dom.js'

const A = 'mission-task-a'
const B = 'mission-task-b'
const C = 'mission-demo-b'
const PLAN = 'plan-0123456789ab'
const PLAN_C = 'plan-00000000000c'
const REQUEST = 'apr-00000000000000a1'
const CAPTURE = 'cap-20261119120000-abcdef'
const T0 = Date.parse('2026-11-19T12:00:00.000Z')
const FIRED = { kind: 'trigger_fired', trigger: 'patches_release_sold_out', table: 'public.patches', timing: 'AFTER', event: 'UPDATE OF available_count', level: 'ROW', fired: 1 }
const SQL = {
  loss: 'UPDATE patches SET available_count = 0 WHERE id = 1;\nSELECT cancel_patch_orders(1);\n',
  bypass: 'DROP TRIGGER IF EXISTS patches_release_sold_out ON patches;\nSELECT cancel_patch_orders(1);\nUPDATE patches SET available_count = 0 WHERE id = 1;\n',
  safe: 'SELECT cancel_patch_orders(1);\nUPDATE patches SET available_count = 0 WHERE id = 1;\n',
  backfill: 'UPDATE orders SET quantity = quantity * 2;\n',
}

const dirs = []
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}
const repoDir = tmp('jrm-console-missions-')
let keys
let savedHome
let restoreDom
let api

function rehearse(missionId, planId, file, sql, verdict, { rowsAfter = 3, evidence = [], at }) {
  writeFileSync(path.join(repoDir, file), sql)
  const plan = [{ id: 'm1', tool: 'sql_migration', args: [file], reversibility: true }]
  const snap = snapshotPlanFiles(plan, repoDir)
  const report = {
    plan_id: planId, verdict, base_hash: 'sha256:' + 'b'.repeat(64), plan_files: snap.files, evidence,
    tables: { orders: { protected: true, rows_before: 3, rows_after: rowsAfter, rows_lost: 3 - rowsAfter, content_changed: true }, patches: { protected: true, rows_before: 5, rows_after: 5, rows_lost: 0, content_changed: true } },
    schema_delta: { changed: false, added_tables: [], removed_tables: [], added_columns: [], removed_columns: [] },
    rows_deleted: 3 - rowsAfter, steps: [{ id: 'm1', status: 'ok' }], signature: 'x',
  }
  const reportHash = archiveRehearsal(repoDir, missionId, report, snap.blobs)
  const r = appendReceipt({ repoDir, keys, missionId, kind: 'rehearsal', verdict, subject: { plan_id: planId, report_hash: reportHash, base_hash: report.base_hash, files_hash: hashValue(snap.files), evidence }, now: at })
  return { reportHash, files: snap.files, receipt: r.hash }
}

before(async () => {
  mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
  const home = tmp('jrm-console-missions-keys-')
  keys = loadOrCreateTestKeys(home)
  savedHome = process.env.JUSTRUNME_HOME
  process.env.JUSTRUNME_HOME = home
  // Task A: DATA LOSS (the trigger fired), LOGIC BYPASS (drop the trigger), SAFE, waiting for approval.
  const f = 'demo/migrations/004.sql'
  rehearse(A, PLAN, f, SQL.loss, 'DATA LOSS', { rowsAfter: 2, evidence: [{ kind: 'protected_rows_lost', table: 'orders', rows_before: 3, rows_after: 2 }, FIRED], at: T0 })
  rehearse(A, PLAN, f, SQL.bypass, 'LOGIC BYPASS', { evidence: [{ kind: 'bypass_statement', what: 'drops a trigger', statement: 'DROP TRIGGER' }], at: T0 + 1000 })
  const safe = rehearse(A, PLAN, f, SQL.safe, 'SAFE', { at: T0 + 2000 })
  appendReceipt({ repoDir, keys, missionId: A, kind: 'approval_requested', verdict: 'pending', subject: { request_id: REQUEST, plan_id: PLAN, report_hash: safe.reportHash, files_hash: hashValue(safe.files), expires_at: new Date(Date.now() + 1800_000).toISOString() }, refs: { rehearsal: safe.receipt }, now: Date.now() })
  // Task B: refused before any rehearsal (CONFLICT), so the mission directory holds no receipt.
  mkdirSync(path.join(repoDir, '.justrunme/missions', B, 'plans'), { recursive: true })
  // Demo B: SAFE, authorized at the CLI (no request), run completed as rehearsed, undone, recovery verified.
  const c = rehearse(C, PLAN_C, 'demo/migrations/005.sql', SQL.backfill, 'SAFE', { at: T0 })
  const auth = appendReceipt({ repoDir, keys, missionId: C, kind: 'authorization_issued', verdict: 'allow', subject: { plan_id: PLAN_C, report_hash: c.reportHash, plan_files_hash: hashValue(c.files), passphrase_source: 'stdin' }, refs: { rehearsal: c.receipt }, now: T0 + 1000 })
  const run = appendReceipt({ repoDir, keys, missionId: C, kind: 'run_result', verdict: 'completed', subject: { plan_id: PLAN_C, capture_id: CAPTURE, plan_files_hash: hashValue(c.files), report_hash: c.reportHash, matches_rehearsal: true, differences: 0 }, refs: { authorization: auth.hash }, now: T0 + 2000 })
  const undo = appendReceipt({ repoDir, keys, missionId: C, kind: 'undo', verdict: 'undo', subject: { capture_id: CAPTURE }, refs: { run: run.hash }, now: T0 + 3000 })
  appendReceipt({ repoDir, keys, missionId: C, kind: 'verification', verdict: 'PASS', subject: { capture_id: CAPTURE, checks: 9, checked: ['container_image', 'file_sha256', 'privileges', 'row_count', 'schema_hash', 'table_checksum'], failed: [] }, refs: { undo: undo.hash }, now: T0 + 4000 })
  api = createApi({ repoDir })
  restoreDom = installFakeDom()
})

after(() => {
  restoreDom?.()
  if (savedHome === undefined) delete process.env.JUSTRUNME_HOME
  else process.env.JUSTRUNME_HOME = savedHome
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const text = (n) => n.textContent.replace(/\s+/g, ' ')
const tick = () => new Promise((r) => setTimeout(r, 0))
const screens = () => import('../src/console/static/screens.js')
const fire = (el, type, ev = {}) => Promise.all((el.listeners[type] ?? []).map((fn) => fn({ preventDefault() {}, target: el, ...ev })))
const all = async () => Promise.all([A, B, C].map(async (id) => ({ mission_id: id, state: await api.state(id) })))

describe('Console with several missions in one workspace', () => {
  it('the API lists the missions under .justrunme/missions/ and scopes every read to the one asked for', async () => {
    assert.deepEqual(listMissions(repoDir).map((m) => [m.mission_id, m.has_receipts]), [[C, true], [A, true], [B, false]])
    assert.deepEqual(api.missions().missions.map((m) => m.mission_id), [C, A, B])
    const a = await api.state(A)
    assert.deepEqual([a.mission, a.story.result.mission_id, a.story.result.versions.map((v) => v.verdict)], [A, A, ['DATA LOSS', 'LOGIC BYPASS', 'SAFE']])
    assert.equal((await api.state(B)).story.error.code, 'NO_RECEIPTS')
    assert.equal((await api.state(C)).story.result.runs[0].undo.verification, 'PASS')
    // A mission that is not in this workspace, or not a mission id, never reaches the CLI.
    for (const [m, code] of [['mission-nope', 'MISSION_UNKNOWN'], ['../x', 'MISSION_INVALID'], ['--repo', 'MISSION_INVALID']]) {
      await assert.rejects(api.state(m), (e) => e.code === code, m)
      await assert.rejects(api.approve({ request_id: REQUEST, confirm: PLAN, passphrase: 'p', mission: m }), (e) => e.code === code, m)
      await assert.rejects(api.undo({ capture_id: CAPTURE, confirm: CAPTURE, mission: m }), (e) => e.code === code, m)
    }
  })

  it('the server answers GET /api/missions and /api/state?mission=, and refuses an unknown mission', async () => {
    const c = await startConsole({ repoDir })
    const get = (p) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: c.port, path: p, headers: { host: `127.0.0.1:${c.port}`, authorization: `Bearer ${c.token}` } }, (res) => {
        const chunks = []
        res.on('data', (x) => chunks.push(x))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
      }).on('error', reject)
    })
    try {
      assert.deepEqual((await get('/api/missions')).json.missions.map((m) => m.mission_id), [C, A, B])
      const st = await get(`/api/state?mission=${C}`)
      assert.deepEqual([st.status, st.json.story.result.mission_id], [200, C])
      const bad = await get('/api/state?mission=mission-nope')
      assert.deepEqual([bad.status, bad.json.error.code], [400, 'MISSION_UNKNOWN'])
      const one = await get(`/api/receipt/0?mission=${A}`)
      assert.equal(one.json.result.receipt.subject.evidence[1].trigger, 'patches_release_sold_out')
    } finally {
      await c.close()
    }
  })

  it('Missions: one card per mission; Demo B reads RECOVERED · VERIFIED, never "not run yet"', async () => {
    const { missionsScreen } = await screens()
    const list = await all()
    const root = missionsScreen(list[0].state, { all: list, route: { screen: 'missions', arg: null, sub: null }, ui: {}, api: async () => ({}) })
    const cards = findAll(root, (e) => hasClass(e, 'card'))
    assert.equal(cards.length, 3)
    const byId = Object.fromEntries(cards.map((c) => [[A, B, C].find((id) => text(c).includes(id)), text(c)]))
    assert.ok(byId[A].includes('NEEDS APPROVAL') && byId[A].includes('DATA LOSS'), byId[A])
    assert.ok(byId[B].includes('NO SIGNED RECORD') && byId[B].includes('writes no receipt'), byId[B])
    assert.ok(byId[C].includes('RECOVERED · VERIFIED') && byId[C].includes('recovery verification PASS') && !byId[C].includes('not run yet'), byId[C])
    assert.ok(text(root).includes('3 in this workspace'))
    const s = list[2].state.story.result
    assert.deepEqual(missionVerdict(s), { label: 'RECOVERED · VERIFIED', tone: 'ok' })
    // Before the undo the same run is COMPLETED · VERIFIED.
    const done = structuredClone(s)
    done.runs[0].undo = null
    assert.equal(runOutcome(done).label, 'COMPLETED · VERIFIED')
    // Opening a card shows that mission's Flight Recorder: authorized at the CLI, executed, verified.
    const fr = missionsScreen(list[2].state, { all: list, route: { screen: 'missions', arg: C, sub: 'verified' }, ui: {}, api: async () => ({}) })
    const nodes = findAll(fr, (e) => e.tag === 'li' && hasClass(e, 'node'))
    assert.deepEqual(nodes.map((n) => n.className.split(' ')[1]).slice(4), ['ok', 'ok', 'ok'])
    assert.ok(text(fr).includes('authorized at the command line') && text(fr).includes('recovery check PASS'))
  })

  it('Impact Diff starts with the worst DATA LOSS on the left, the latest SAFE on the right, and names the trigger that fired', async () => {
    const { impactScreen } = await screens()
    const st = await api.state(A)
    const s = st.story.result
    assert.deepEqual([severest(s).seq, severest(s).verdict, latestSafe(s).seq], [0, 'DATA LOSS', 2])
    const asked = []
    const root = impactScreen(st, { ui: {}, rerender: () => {}, route: { screen: 'impact' }, api: async (p) => (asked.push(p), api.receipt(p.split('/').pop(), A)) })
    const versus = text(findAll(root, (e) => hasClass(e, 'versus'))[0])
    assert.ok(versus.includes('Revision #0 · DATA LOSS') && versus.includes('Revision #2 · SAFE'), versus)
    assert.deepEqual(findAll(findAll(root, (e) => hasClass(e, 'versus'))[0], (e) => hasClass(e, 'big')).map(text), ['1', '0'])
    assert.deepEqual(findAll(root, (e) => e.tag === 'h3' && /^Plan [AB] · Revision #/.test(text(e))).map(text), ['Plan A · Revision #0', 'Plan B · Revision #2'])
    // The counterfactual is the plan that lost a row, not the bypass attempt (which lost none).
    const without = text(findAll(root, (e) => hasClass(e, 'without'))[0])
    assert.ok(without.includes('3 → 2'), without)
    await tick()
    await tick()
    assert.deepEqual(asked, ['/api/receipt/0'])
    const callout = text(findAll(root, (e) => hasClass(e, 'callout'))[0])
    assert.ok(callout.includes('patches_release_sold_out') && callout.includes('public.patches') && callout.includes('AFTER UPDATE OF available_count') && callout.includes('fired 1 time'), callout)
    assert.doesNotMatch(callout, /release_sold_out_patch|DELETE FROM/)
  })

  it('Approval Center: a review checkbox instead of a typed plan id; Approve stays disabled until ready; Enter submits; errors show in the card', async () => {
    const { approvalsScreen } = await screens()
    // The signed request file is written by the MCP tool; here the list and the detail are what `approvals` prints for it.
    const st = await api.state(A)
    st.approvals = { ok: true, result: { requests: [{ request_id: REQUEST, plan_id: PLAN, state: 'pending', requested_at: new Date(T0).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() }] } }
    const detail = {
      ok: true, command: 'approvals',
      result: {
        request_id: REQUEST, plan_id: PLAN, state: 'pending', expires_at: new Date(Date.now() + 1800_000).toISOString(), agent_note: 'Cancels first, then marks the patch sold out.', agent_note_is: 'written by the agent; not verified',
        files: [{ path: 'demo/migrations/004.sql', sql: SQL.safe, matches_now: true }],
        report: { valid: true, verdict: 'SAFE', rows_deleted: 0, tables: { orders: { protected: true, rows_before: 3, rows_after: 3, rows_lost: 0 }, patches: { protected: true, rows_before: 5, rows_after: 5, rows_lost: 0 } }, schema_delta: { added_columns: [], removed_columns: [], removed_tables: [] } },
      },
    }
    const posted = []
    let answer = { ok: false, command: 'approve', error: { code: 'APPROVER_KEY_INVALID', message: 'wrong passphrase' } }
    const ctx = {
      ui: {}, rerender: () => {}, reload: async () => {}, route: { screen: 'approvals' },
      api: async (p, o) => {
        if (o?.method === 'POST') return (posted.push([p, o.body]), answer)
        return detail
      },
    }
    const root = approvalsScreen(st, ctx)
    await tick()
    await tick()
    const t = text(root)
    assert.ok(t.includes('I reviewed the SQL and the measured rehearsal diff') && t.includes(`(${PLAN})`), t)
    assert.ok(t.includes('0 rows deleted in rehearsal') && t.includes('protected tables checked'))
    assert.ok(t.includes('SQL: denied #0 DATA LOSS → requested #2 SAFE'), 'the comparison against the plan that lost data')
    assert.ok(t.includes('How approval is signed') && findAll(root, (e) => e.tag === 'details').length === 1, 'technical notes are in a disclosure')
    assert.equal(findAll(root, (e) => e.tag === 'input' && e.attrs.id === 'confirm').length, 0, 'no typed plan id')
    const box = findAll(root, (e) => e.tag === 'input' && e.attrs.type === 'checkbox')[0]
    const pass = findAll(root, (e) => e.attrs.id === 'passphrase')[0]
    const approve = findAll(root, (e) => e.tag === 'button' && text(e) === 'Approve this plan')[0]
    const eye = findAll(root, (e) => e.tag === 'button' && hasClass(e, 'eye'))[0]
    assert.equal(approve.attrs.disabled, '', 'disabled at first')
    pass.value = 'correct horse'
    await fire(pass, 'input')
    assert.equal(approve.disabled, true, 'still disabled: not reviewed')
    await fire(pass, 'keydown', { key: 'Enter' })
    assert.equal(posted.length, 0, 'Enter does nothing before the box is ticked')
    assert.ok(text(root).includes('Tick the review box first'))
    box.checked = true
    await fire(box, 'change')
    assert.equal(approve.disabled, false)
    await fire(eye, 'click')
    assert.equal(pass.attrs.type, 'text')
    await fire(eye, 'click')
    assert.equal(pass.attrs.type, 'password')
    await fire(pass, 'keydown', { key: 'Enter' })
    assert.deepEqual(posted, [['/api/approve', { request_id: REQUEST, confirm: PLAN, passphrase: 'correct horse' }]], 'the checkbox supplies the plan id')
    const msg = text(findAll(root, (e) => e.attrs.id === 'approve-msg')[0])
    assert.ok(msg.includes('APPROVER_KEY_INVALID: wrong passphrase'), msg)
    assert.equal(pass.value, '', 'the passphrase is cleared after every attempt')
    answer = { ok: true, command: 'approve', result: { request_id: REQUEST, plan_id: PLAN, expires_at: new Date(T0).toISOString(), passphrase_source: 'stdin' } }
    pass.value = 'correct horse'
    await fire(pass, 'input')
    await fire(approve, 'click')
    assert.ok(text(findAll(root, (e) => e.attrs.id === 'approve-msg')[0]).includes(`Approved ${REQUEST}`))
  })

  it('Undo: two clicks, "Undo Mission" then "Confirm Undo <capture>", which sends the capture id as the confirmation', async () => {
    const { recoveryScreen } = await screens()
    const st = structuredClone(await api.state(C))
    st.story.result.runs[0].undo = null
    const posted = []
    const root = recoveryScreen(st, { ui: {}, rerender: () => {}, reload: async () => {}, route: { screen: 'recovery' }, api: async (p, o) => (posted.push([p, o?.body]), { ok: true, command: 'undo', result: { capture_id: CAPTURE, status: 'RECOVERED', verification: { status: 'PASS' } } }) })
    assert.equal(findAll(root, (e) => e.tag === 'input' && /capture/.test(e.attrs.placeholder ?? '')).length, 0, 'no typed capture id')
    const first = findAll(root, (e) => e.tag === 'button' && text(e) === 'Undo Mission')[0]
    await fire(first, 'click')
    assert.equal(posted.length, 0, 'the first click only asks')
    const confirm = findAll(root, (e) => e.tag === 'button' && text(e) === `Confirm Undo ${CAPTURE}`)[0]
    assert.ok(confirm)
    await fire(confirm, 'click')
    assert.deepEqual(posted, [['/api/undo', { capture_id: CAPTURE, confirm: CAPTURE }]])
    assert.ok(text(root).includes(`Undo ${CAPTURE}: RECOVERED; recovery check PASS`))
  })
})

describe('Console round 2: decision first, safe approval, honest labels, SQL panels', () => {
  const pendingDetail = (over = {}) => ({
    ok: true, command: 'approvals',
    result: {
      request_id: REQUEST, plan_id: PLAN, state: 'pending', expires_at: new Date(Date.now() + 1800_000).toISOString(), agent_note: '', agent_note_is: 'written by the agent; not verified',
      files: [{ path: 'demo/migrations/004.sql', sql: SQL.safe, matches_now: true }],
      report: { valid: true, verdict: 'SAFE', rows_deleted: 0, tables: { orders: { protected: true, rows_before: 3, rows_after: 3, rows_lost: 0 } }, schema_delta: { added_columns: [], removed_columns: [], removed_tables: [] } },
      ...over,
    },
  })
  const withPending = async () => {
    const st = await api.state(A)
    st.approvals = { ok: true, result: { requests: [{ request_id: REQUEST, plan_id: PLAN, state: 'pending', requested_at: new Date(T0).toISOString(), expires_at: new Date(Date.now() + 1800_000).toISOString() }] } }
    return st
  }
  const render = async (detail, apiPost = async () => ({ ok: true, command: 'approve', result: { request_id: REQUEST, plan_id: PLAN, passphrase_source: 'stdin' } })) => {
    const { approvalsScreen } = await screens()
    const posted = []
    const root = approvalsScreen(await withPending(), { ui: {}, rerender: () => {}, reload: async () => {}, route: { screen: 'approvals' }, api: async (p, o) => (o?.method === 'POST' ? (posted.push(o.body), apiPost()) : detail) })
    await tick()
    await tick()
    return { root, posted, box: findAll(root, (e) => e.attrs.id === 'reviewed')[0], pass: findAll(root, (e) => e.attrs.id === 'passphrase')[0], approve: findAll(root, (e) => e.tag === 'button' && hasClass(e, 'approve'))[0] }
  }

  it('Approve is never offered for a request that is not eligible: DENIED report, STALE files, EXPIRED, not pending', async () => {
    const { eligibility } = await import('../src/console/static/model.js')
    const cases = [
      [{ report: { valid: true, verdict: 'DATA LOSS', rows_deleted: 1, tables: {} } }, /verdict is DATA LOSS/],
      [{ files: [{ path: 'demo/migrations/004.sql', sql: SQL.safe, matches_now: false }] }, /STALE: demo\/migrations\/004\.sql changed/],
      [{ expires_at: new Date(Date.now() - 1000).toISOString() }, /EXPIRED/],
      [{ state: 'approved' }, /request is APPROVED/],
      [{ report: { valid: false, problem: 'report signature is invalid' } }, /cannot be verified \(report signature is invalid\)/],
    ]
    for (const [over, why] of cases) {
      const d = pendingDetail(over)
      const e = eligibility(d.result)
      assert.equal(e.ok, false, JSON.stringify(over))
      assert.match(e.reasons.join(' | '), why)
      if (d.result.state !== 'pending') continue
      const { root, box, pass, approve, posted } = await render(d)
      assert.ok(text(root).includes('Approve is not offered'), JSON.stringify(over))
      assert.equal(box.attrs.disabled, '', 'the review box is disabled')
      assert.equal(approve.attrs.disabled, '', 'Approve is disabled')
      box.checked = true
      pass.value = 'x'
      await fire(box, 'change')
      await fire(pass, 'keydown', { key: 'Enter' })
      assert.equal(approve.disabled, true)
      assert.equal(posted.length, 0, 'nothing is submitted')
    }
    assert.deepEqual(eligibility(pendingDetail().result), { ok: true, reasons: [] })
    assert.equal(eligibility(pendingDetail().result, { verifyOk: false }).ok, false, 'a chain that does not verify blocks it too')
    assert.equal(eligibility(pendingDetail().result, { storyState: 'denied' }).ok, false)
  })

  it('the review box starts unticked on every render: a new request, report or mission never inherits a tick', async () => {
    const first = await render(pendingDetail())
    first.box.checked = true
    await fire(first.box, 'change')
    const second = await render(pendingDetail({ report: { ...pendingDetail().result.report, rows_deleted: 0 } }))
    assert.notEqual(second.box, first.box)
    assert.equal(second.box.checked ?? false, false)
    assert.equal(second.approve.attrs.disabled, '')
  })

  it('one submission at a time: Enter and clicks while approving post once; after success Approve stays off', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const { box, pass, approve, posted, root } = await render(pendingDetail(), async () => (await gate, { ok: true, command: 'approve', result: { request_id: REQUEST, plan_id: PLAN, passphrase_source: 'stdin', expires_at: new Date().toISOString() } }))
    box.checked = true
    pass.value = 'correct horse'
    await fire(box, 'change')
    const a = fire(pass, 'keydown', { key: 'Enter' })
    const b = fire(approve, 'click')
    const c = fire(pass, 'keydown', { key: 'Enter' })
    assert.equal(approve.textContent, 'Approving…', 'an explicit pending state')
    release()
    await Promise.all([a, b, c])
    for (let i = 0; i < 5; i++) await tick()
    assert.equal(posted.length, 1)
    assert.deepEqual(posted[0], { request_id: REQUEST, confirm: PLAN, passphrase: 'correct horse' })
    assert.equal(approve.textContent, 'Approved')
    assert.equal(approve.disabled, true)
    pass.value = 'again'
    await fire(approve, 'click')
    assert.equal(posted.length, 1, 'no second authorization from this page')
    assert.equal(pass.value, 'again', 'the field is only read, never stored')
    assert.ok(!JSON.stringify(text(root)).includes('correct horse'), 'the passphrase is not shown anywhere')
  })

  it('decision first: DATA LOSS and LOGIC BYPASS heroes say what happened, why and what next; the trigger comes from the signed receipt', async () => {
    const { heroOf } = await import('../src/console/static/model.js')
    const s = (await api.state(A)).story.result
    const [loss, bypass, safe] = s.versions
    const hl = heroOf(loss)
    assert.deepEqual([hl.label, hl.headline], ['DATA LOSS DETECTED', '1 protected row would be deleted'])
    assert.ok(hl.why.includes('orders: 3 → 2 (1 lost)') && /^BLOCKED/.test(hl.execution), JSON.stringify(hl))
    const hb = heroOf(bypass)
    assert.equal(hb.label, 'LOGIC BYPASS DETECTED')
    assert.ok(hb.why.some((w) => w.includes('JustRunMe\'s observers recorded')) && !hb.why.some((w) => w.includes('PostgreSQL refused')), 'this receipt has no permission error, so none is claimed')
    const refused = structuredClone(bypass)
    refused.impact.evidence.push({ kind: 'bypass_attempt_refused' })
    assert.ok(heroOf(refused).why.some((w) => w.startsWith('PostgreSQL refused')))
    assert.equal(heroOf(safe).label, 'SAFE · MEASURED')
    const executed = heroOf(safe, { runs: [{ report_hash: safe.report_hash, verdict: 'completed', undo: { verification: 'PASS' } }], requests: [] })
    assert.match(executed.execution, /executed, then undone/)
    assert.doesNotMatch(executed.next, /approve or reject/)
    const pending = heroOf(safe, { runs: [], requests: [{ report_hash: safe.report_hash, state: 'pending' }] })
    assert.match(pending.next, /approve or reject the pending request/)
    assert.equal(heroOf({ ...loss, available: false, problem: 'gone' }).label, 'NOT VERIFIED')
    // Rendered: the hero comes before the technical panels of the Flight Recorder node.
    const { missionsScreen } = await screens()
    const st = await api.state(A)
    const asked = []
    const fr = missionsScreen(st, { all: [{ mission_id: A, state: st }], route: { screen: 'missions', arg: A, sub: 'rehearsed' }, ui: {}, api: async (p) => (asked.push(p), api.receipt(p.split('/').pop(), A)) })
    const ev = findAll(fr, (e) => hasClass(e, 'evidence'))[0]
    const kids = ev.children[0].children
    assert.ok(hasClass(kids[1], 'hero') && text(kids[1]).includes('DATA LOSS DETECTED'), 'hero right after the heading')
    await tick()
    await tick()
    assert.deepEqual(asked, ['/api/receipt/0'])
    assert.ok(text(kids[1]).includes('patches_release_sold_out') && text(kids[1]).includes('from signed receipt #0'))
    // A SAFE version names no trigger and asks for no receipt.
    const none = []
    const fr2 = missionsScreen(st, { all: [{ mission_id: A, state: st }], route: { screen: 'missions', arg: A, sub: 'repaired' }, ui: {}, api: async (p) => (none.push(p), {}) })
    await tick()
    assert.ok(!text(fr2).includes('Reading which database trigger'))
    assert.deepEqual(none.filter((p) => p.startsWith('/api/receipt/2')), [])
  })

  it('honest labels: no green without a passing verify, and an undo without a verification receipt is not RECOVERED', async () => {
    const { missionVerdict, runOutcome, urgency } = await import('../src/console/static/model.js')
    const c = (await api.state(C)).story.result
    assert.equal(missionVerdict(c, true).label, 'RECOVERED · VERIFIED')
    assert.deepEqual(missionVerdict(c, false), { label: 'NOT VERIFIED', tone: 'mute' })
    const noCheck = structuredClone(c)
    noCheck.runs[0].undo.verification = null
    assert.deepEqual([runOutcome(noCheck).label, runOutcome(noCheck).tone], ['UNDONE · NOT VERIFIED', 'mute'])
    const failed = structuredClone(c)
    failed.runs[0].undo.verification = 'FAIL'
    assert.equal(runOutcome(failed).label, 'RECOVERY FAILED')
    // The card of a mission whose verify fails is grey, whatever its receipts say.
    const { missionsScreen } = await screens()
    const st = await api.state(C)
    st.verify = { ok: false, result: { ok: false } }
    const root = missionsScreen(st, { all: [{ mission_id: C, state: st }], route: { screen: 'missions' }, ui: {}, api: async () => ({}) })
    const card = findAll(root, (e) => hasClass(e, 'card'))[0]
    assert.ok(text(card).includes('NOT VERIFIED') && !text(card).includes('RECOVERED · VERIFIED') && hasClass(card, 'tone-mute'), text(card))
    // Triage puts the mission that needs a person first.
    const a = (await api.state(A)).story.result
    assert.ok(urgency(a, true) < urgency(c, true))
  })

  it('Missions: the triage strip counts the states and the cards are ordered by urgency', async () => {
    const { missionsScreen } = await screens()
    const list = await all()
    const root = missionsScreen(list[0].state, { all: list, route: { screen: 'missions', arg: null, sub: null }, ui: {}, api: async () => ({}) })
    const tiles = findAll(root, (e) => hasClass(e, 'tri')).map((t) => text(t))
    assert.deepEqual(tiles, ['1need your decision', '0blocked or broken', '1safe, proven or recovered', '1no signed record or not verified'])
    const order = findAll(root, (e) => hasClass(e, 'card')).map((c) => [A, B, C].find((id) => text(c).includes(id)))
    assert.deepEqual(order, [A, C, B])
  })

  it('unknown mission and Flight Recorder view show explicit navigation, while existing mission opens', async () => {
    const { missionsScreen } = await screens()
    const list = await all()
    const ctx = { all: list, route: { screen: 'missions', arg: 'mission-not-recorded', sub: null }, ui: {}, api: async () => ({}) }
    const missing = missionsScreen(list[0].state, ctx)
    assert.ok(text(missing).includes('Mission mission-not-recorded is not in this recording'))
    for (const id of [A, B, C]) assert.ok(findAll(missing, (e) => e.tag === 'a' && e.attrs.href === `#/missions/${id}`).length)
    assert.ok(findAll(missing, (e) => e.tag === 'a' && e.attrs.href === '#/missions').length)
    const existing = missionsScreen(list[0].state, { ...ctx, route: { screen: 'missions', arg: A, sub: null } })
    assert.ok(text(existing).includes('Flight Recorder'))
    const unknownView = missionsScreen(list[0].state, { ...ctx, route: { screen: 'missions', arg: A, sub: 'nonexistent' } })
    assert.ok(text(unknownView).includes('Unknown Flight Recorder view: nonexistent'))
    assert.ok(findAll(unknownView, (e) => e.tag === 'a' && e.attrs.href === `#/missions/${A}`).length)
  })

  it('legacy PASS recovery does not ask for approval and its VERIFIED node says checks unknown', async () => {
    const { missionsScreen } = await screens()
    const st = structuredClone(await api.state(C))
    st.story.result.runs[0].undo.receipt_format = 'legacy'
    st.story.result.runs[0].undo.checked = null
    const ctx = { all: [{ mission_id: C, state: st }], route: { screen: 'missions', arg: null }, ui: {}, api: async () => ({}) }
    const root = missionsScreen(st, ctx)
    const tiles = findAll(root, (e) => hasClass(e, 'tri')).map((t) => text(t))
    assert.equal(tiles[0], '0need your decision')
    assert.ok(text(root).includes('RECOVERED · CHECKS UNKNOWN'))
    const { flight } = await import('../src/console/static/model.js')
    const verified = flight(st.story.result).find((n) => n.name === 'VERIFIED')
    assert.equal(verified.checks_unknown, true)
    const current = structuredClone(st.story.result)
    current.runs[0].undo.receipt_format = 'current'
    assert.equal(flight(current).find((n) => n.name === 'VERIFIED').checks_unknown, false)
    const fr = missionsScreen(st, { ...ctx, route: { screen: 'missions', arg: C, sub: 'verified' } })
    const panel = findAll(fr, (e) => hasClass(e, 'evidence'))[0]
    const header = findAll(panel, (e) => e.tag === 'h2' && text(e) === 'VERIFIED')[0]
    assert.ok(header, 'VERIFIED evidence header exists')
    const badge = findAll(panel, (e) => hasClass(e, 'pill'))[0]
    assert.ok(badge, 'VERIFIED evidence badge exists')
    assert.equal(text(badge), 'CHECKS UNKNOWN')
    assert.ok(!text(badge).includes('ATTENTION REQUIRED'))
    assert.ok(!text(fr).includes('NEEDS APPROVAL'), text(fr))
  })

  it('SQL panels: line numbers, highlighting as text only, Copy SQL, Full width; compare switches side by side and unified', async () => {
    const { sqlTokens, sqlView, sqlCompare } = await import('../src/console/static/ui.js')
    assert.deepEqual(sqlTokens("UPDATE t SET a = 'x<b>' -- note").filter((t) => t.kind !== 'space').map((t) => [t.kind, t.text]), [['keyword', 'UPDATE'], ['ident', 't'], ['keyword', 'SET'], ['ident', 'a'], ['punct', '='], ['string', "'x<b>'"], ['comment', '-- note']])
    const v = sqlView('SELECT 1;\n  SELECT 2;\n', { title: 'SQL' })
    const lines = findAll(v, (e) => hasClass(e, 'ln'))
    assert.deepEqual(lines.map((l) => text(findAll(l, (e) => hasClass(e, 'no'))[0])), ['1', '2'])
    assert.equal(findAll(lines[1], (e) => hasClass(e, 'src'))[0].textContent, '  SELECT 2;', 'whitespace kept')
    assert.ok(findAll(v, (e) => e.tag === 'button' && text(e).includes('Copy SQL')).length === 1)
    const expand = findAll(v, (e) => e.tag === 'button' && text(e).includes('Full width'))[0]
    await fire(expand, 'click')
    assert.equal(expand.attrs['aria-pressed'], 'true')
    const ui = {}
    const cmp = sqlCompare('a\nb\nc\n', 'a\nx\nc\n', { left: 'L', right: 'R', ui })
    const rows = findAll(cmp, (e) => hasClass(e, 'sbs-row'))
    assert.equal(rows.length, 3, 'side by side by default, changed lines paired')
    assert.ok(hasClass(rows[1].children[0], 'rm') && hasClass(rows[1].children[1], 'add'))
    const uni = findAll(cmp, (e) => e.tag === 'button' && text(e) === 'Unified')[0]
    await fire(uni, 'click')
    assert.equal(ui.sqlMode, 'unified')
    assert.deepEqual(findAll(cmp, (e) => hasClass(e, 'ln')).map((l) => l.className), ['ln ', 'ln rm', 'ln add', 'ln '])
    // The chosen mode survives a re-render.
    assert.equal(findAll(sqlCompare('a', 'b', { ui }), (e) => hasClass(e, 'sbs-row')).length, 0)
  })
})
