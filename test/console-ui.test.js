/**
 * T28 Console design: every screen renders from real-shaped demo data and from the empty
 * and error states; a step the chain does not show is greyed, never filled in; the colour
 * pairs meet WCAG AA; the page needs nothing from the network.
 *
 * Screens are built with a small fake DOM (test/support/fake-dom.js). It proves what each
 * screen says and which classes it sets; it does not prove layout (see the screenshots).
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendReceipt } from '../src/receipts/chain.js'
import { hashValue } from '../src/util/canonical.js'
import { archiveRehearsal, snapshotPlanFiles } from '../src/history/archive.js'
import { createApi } from '../src/console/api.js'
import { startConsole } from '../src/console/server.js'
import { counterfactual, flight, headline, missionVerdict, receiptRows, toneOf } from '../src/console/static/model.js'
import { loadOrCreateTestKeys } from './support/keys.js'
import { findAll, hasClass, installFakeDom } from './support/fake-dom.js'

const STATIC_DIR = fileURLToPath(new URL('../src/console/static/', import.meta.url))
const MISSION = 'mission-ui-test'
const PLAN = 'plan-0123456789ab'
const REQUEST = 'apr-00000000000000bb'
const DANGER = 'UPDATE patches SET available_count = 0 WHERE id = 1;\n'
const SAFE = 'ALTER TABLE patches ADD COLUMN sold_out BOOLEAN NOT NULL DEFAULT FALSE;\n'
const T0 = Date.parse('2026-11-18T12:00:00.000Z')
const plan = [{ id: 'm1', tool: 'sql_migration', args: ['demo/migrations/003.sql'], reversibility: true }]

const dirs = []
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}
const repoDir = tmp('jrm-ui-')
let keys
let savedHome
let state
let restoreDom

function rehearse(sql, verdict, { rowsAfter = 3, at = T0, removed = [] } = {}) {
  writeFileSync(path.join(repoDir, 'demo/migrations/003.sql'), sql)
  const snap = snapshotPlanFiles(plan, repoDir)
  const report = {
    plan_id: PLAN, verdict, base_hash: 'sha256:' + 'b'.repeat(64), plan_files: snap.files,
    tables: { orders: { protected: true, rows_before: 3, rows_after: rowsAfter, rows_lost: 3 - rowsAfter, content_changed: false } },
    schema_delta: { changed: true, added_tables: [], removed_tables: [], added_columns: verdict === 'SAFE' ? ['patches.sold_out'] : [], removed_columns: removed },
    steps: [{ id: 'm1', status: 'ok' }], signature: 'x',
  }
  const reportHash = archiveRehearsal(repoDir, MISSION, report, snap.blobs)
  const r = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'rehearsal', verdict, subject: { plan_id: PLAN, report_hash: reportHash, base_hash: report.base_hash, files_hash: hashValue(snap.files) }, now: at })
  return { reportHash, files: snap.files, receipt: r.hash }
}

function approveAndRun(v, source) {
  const req = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'approval_requested', verdict: 'pending', subject: { request_id: REQUEST, plan_id: PLAN, report_hash: v.reportHash, files_hash: hashValue(v.files), expires_at: new Date(T0 + 3600 * 1000).toISOString() }, refs: { rehearsal: v.receipt }, now: T0 + 2000 })
  const auth = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'authorization_issued', verdict: 'allow', subject: { plan_id: PLAN, report_hash: v.reportHash, plan_files_hash: hashValue(v.files), passphrase_source: source }, refs: { rehearsal: v.receipt, approval: req.hash }, now: T0 + 3000 })
  appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'run_result', verdict: 'completed', subject: { plan_id: PLAN, capture_id: 'cap-20261118120000-abcdef', plan_files_hash: hashValue(v.files), report_hash: v.reportHash, matches_rehearsal: true, differences: 0 }, refs: { authorization: auth.hash }, now: T0 + 4000 })
}

before(async () => {
  mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
  const home = tmp('jrm-ui-keys-')
  keys = loadOrCreateTestKeys(home)
  savedHome = process.env.JUSTRUNME_HOME
  process.env.JUSTRUNME_HOME = home
  rehearse(DANGER, 'DATA LOSS', { rowsAfter: 2 })
  approveAndRun(rehearse(SAFE, 'SAFE', { at: T0 + 1000 }), 'env')
  state = await createApi({ repoDir, mission: MISSION }).state()
  restoreDom = installFakeDom()
})

after(() => {
  restoreDom?.()
  if (savedHome === undefined) delete process.env.JUSTRUNME_HOME
  else process.env.JUSTRUNME_HOME = savedHome
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const text = (n) => n.textContent.replace(/\s+/g, ' ')
const ctxOf = (route = { screen: 'missions', arg: null, sub: null }, api = async () => ({ ok: false, error: { code: 'NOT_USED', message: 'not used' } })) => ({ api, reload: async () => {}, rerender: () => {}, ui: {}, route })
const tick = () => new Promise((r) => setTimeout(r, 0))
const clone = (x) => structuredClone(x)

async function screens() {
  return import('../src/console/static/screens.js')
}

describe('Console screens render demo data (T28)', () => {
  it('Missions: a compact card with the mission, its verdict, the revisions, one outcome, the last step and time', async () => {
    const { missionsScreen } = await screens()
    const root = missionsScreen(state, ctxOf())
    const t = text(root)
    assert.ok(t.includes(MISSION) && t.includes('COMPLETED · VERIFIED'))
    const card = findAll(root, (e) => e.tag === 'a' && hasClass(e, 'card'))[0]
    const revs = findAll(card, (e) => hasClass(e, 'revs'))[0]
    assert.ok(/#0 DATA LOSS\s*→\s*#\d SAFE/.test(text(revs)), text(revs))
    assert.ok(text(card).includes('approved, executed, and the real result equals the rehearsal'), 'one outcome')
    assert.equal(findAll(card, (e) => hasClass(e, 'story')).length, 0, 'the four narrative cards are gone')
    assert.ok(text(card).includes('Open Flight Recorder'))
    assert.ok(t.includes('last step: #4 run_result · completed') && t.includes('2026-11-18 12:00:04Z'))
    assert.equal(findAll(root, (e) => e.tag === 'a' && e.attrs.href === `#/missions/${MISSION}`).length, 1)
    for (const label of ['SAFE · VERIFIED · RECOVERED', 'NEEDS APPROVAL · CONFLICT', 'DATA LOSS · LOGIC BYPASS', 'REPAIRED', 'UNVERIFIABLE']) assert.ok(t.includes(label), label)
  })

  it('Flight Recorder: seven nodes in order, each a link; the selected one shows SQL, rows lost, receipt hash and signature', async () => {
    const { missionsScreen } = await screens()
    const root = missionsScreen(state, ctxOf({ screen: 'missions', arg: MISSION, sub: 'denied' }))
    const nodes = findAll(root, (e) => e.tag === 'li' && hasClass(e, 'node'))
    assert.deepEqual(nodes.map((n) => text(findAll(n, (e) => hasClass(e, 'name'))[0])), ['PROPOSED', 'REHEARSED', 'DENIED', 'REPAIRED', 'APPROVED', 'EXECUTED', 'VERIFIED'])
    assert.deepEqual(nodes.map((n) => n.className.split(' ')[1]), ['info', 'ok', 'bad', 'fix', 'ok', 'ok', 'ok'])
    assert.equal(findAll(root, (e) => e.tag === 'a' && /^#\/missions\/mission-ui-test\/\w+$/.test(e.attrs.href ?? '')).length, 7)
    const ev = findAll(root, (e) => hasClass(e, 'evidence'))[0]
    const t = text(ev)
    assert.ok(t.includes('UPDATE patches SET available_count = 0'), 'the denied SQL')
    assert.ok(t.includes('3 → 2') && t.includes('DATA LOSS'), 'rows lost')
    const s = state.story.result
    const hashOf = s.versions[0].receipt
    assert.ok(findAll(ev, (e) => e.tag === 'code' && e.attrs.title === hashOf).length === 1, 'the receipt hash, copyable')
    assert.ok(findAll(ev, (e) => e.tag === 'button' && e.attrs['aria-label'] === `Copy ${hashOf}`).length === 1)
    assert.ok(t.includes('verified by the chain check'), 'signature status')
    // The repaired node shows the SQL difference between the two plans.
    const sparks = findAll(root, (e) => hasClass(e, 'spark'))
    assert.equal(sparks.length, 1, 'one spark, on VERIFIED')
    const fixed = missionsScreen(state, ctxOf({ screen: 'missions', arg: MISSION, sub: 'repaired' }))
    assert.ok(findAll(fixed, (e) => hasClass(e, 'sqlpanel') && hasClass(e, 'compare')).length === 1, 'the repaired node compares the two plans')
    // The approval node says how the passphrase was given: this fixture used the environment.
    const appr = text(missionsScreen(state, ctxOf({ screen: 'missions', arg: MISSION, sub: 'approved' })))
    assert.ok(appr.includes('SCRIPTED') && appr.includes('not a person at a keyboard'))
  })

  it('a step the chain does not show is greyed with its reason and shows no evidence', async () => {
    const { missionsScreen } = await screens()
    const only = clone(state)
    const s = only.story.result
    s.requests = []
    s.runs = []
    s.links = []
    s.versions = s.versions.slice(0, 1)
    s.timeline = s.timeline.slice(0, 1)
    const root = missionsScreen(only, ctxOf({ screen: 'missions', arg: MISSION, sub: 'executed' }))
    const nodes = findAll(root, (e) => e.tag === 'li' && hasClass(e, 'node'))
    assert.deepEqual(nodes.map((n) => n.className.split(' ')[1]), ['info', 'ok', 'bad', 'missing', 'missing', 'missing', 'missing'])
    const ev = text(findAll(root, (e) => hasClass(e, 'evidence'))[0])
    assert.ok(ev.includes('Not in the signed chain') && ev.includes('not run') && !ev.includes('cap-'), ev)
    assert.equal(missionVerdict(s).label, 'DENIED')
    assert.deepEqual(flight(s).filter((n) => n.state === 'missing').map((n) => [n.name, n.receipt]), [['REPAIRED', null], ['APPROVED', null], ['EXECUTED', null], ['VERIFIED', null]])
  })

  it('Impact Diff: the Counterfactual Replay has both columns from signed data, then plan against plan', async () => {
    const { impactScreen } = await screens()
    const root = impactScreen(state, ctxOf())
    const t = text(root)
    assert.ok(t.includes('Counterfactual Replay') && t.includes('WITHOUT JUSTRUNME') && t.includes('WITH JUSTRUNME'))
    assert.ok(t.includes('DENIED · DATA LOSS') && t.includes('the real result equals the rehearsal'))
    assert.ok(t.includes('Recorded experiment T25 v1 (other runs, not this mission)') && t.includes('5 of 5 reviews said REVIEW: APPROVE') && t.includes('5 of 5 runs lost 1 of 3 orders') && t.includes('docs/agent-runs/T25-results-v1.md'), 'the published number, labelled as another experiment')
    assert.ok(readFileSync(new URL('../docs/agent-runs/T25-results-v1.md', import.meta.url), 'utf8').includes('| Verdict on the teammate\'s SQL | 5 of 5 `REVIEW: APPROVE`') && readFileSync(new URL('../docs/agent-runs/T25-results-v1.md', import.meta.url), 'utf8').includes('| Orders lost on the real database | 1 of 3 in every run (5 of 5)'), 'both numbers are in the results file')
    const [without, withJrm] = findAll(root, (e) => hasClass(e, 'col') && (hasClass(e, 'without') || hasClass(e, 'with')))
    assert.ok(text(without).includes('1protected rows lost') && text(without).includes('orders') && text(without).includes('3 → 2'))
    assert.ok(text(withJrm).includes('3 → 3'))
    assert.ok(!/REVIEW/.test(text(withJrm)), 'no review verdict in the mission\'s own columns: the chain records none')
    const c = counterfactual(state.story.result)
    assert.deepEqual([c.without.tables[0].lost, c.with.tables[0].lost, c.with.ran, c.with.matched], [1, 0, true, true])
    assert.ok(findAll(root, (e) => hasClass(e, 'sqlpanel') && hasClass(e, 'compare')).length === 1 && t.includes('Revision against revision'))
  })

  it('Approval Center: risk verdict, SQL, Approve and Reject for a pending request; the source for an approved one', async () => {
    const { approvalsScreen } = await screens()
    const detail = (stateName) => ({
      ok: true, command: 'approvals',
      result: {
        request_id: REQUEST, plan_id: PLAN, state: stateName, expires_at: new Date(Date.now() + 1800_000).toISOString(),
        agent_note: 'Adds a flag column.', agent_note_is: 'written by the agent; not verified',
        files: [{ path: 'demo/migrations/003.sql', sql: SAFE, matches_now: true }],
        report: { valid: true, verdict: 'SAFE', rows_deleted: 0, schema_delta: { added_columns: ['patches.sold_out'], removed_columns: [], removed_tables: [] } },
      },
    })
    const pending = clone(state)
    pending.approvals = { ok: true, result: { requests: [{ request_id: REQUEST, plan_id: PLAN, state: 'pending', requested_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 3600_000).toISOString() }] } }
    pending.story.result.requests[0].state = 'pending'
    pending.story.result.requests[0].authorization = null
    const root = approvalsScreen(pending, ctxOf({ screen: 'approvals', arg: null, sub: null }, async () => detail('pending')))
    assert.ok(text(root).includes('Loading the request'), 'loading state while the request is read')
    await tick()
    const t = text(root)
    assert.ok(t.includes('SAFE · READY FOR YOUR DECISION') && t.includes('0 rows deleted in rehearsal'))
    assert.ok(t.includes('Approve this plan') && t.includes('Reject') && t.includes('ALTER TABLE patches ADD COLUMN sold_out'))
    assert.ok(t.includes('records the passphrase source "stdin"') && t.includes('SCRIPTED'), 'scripted against human is explained')
    assert.ok(t.includes('written by the agent; not verified'))
    // Approved by a script: the receipt says env.
    const approved = clone(state)
    approved.approvals = { ok: true, result: { requests: [{ request_id: REQUEST, plan_id: PLAN, state: 'approved', requested_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 3600_000).toISOString() }] } }
    const done = approvalsScreen(approved, ctxOf({ screen: 'approvals', arg: null, sub: null }, async () => detail('approved')))
    await tick()
    assert.ok(text(done).includes('SCRIPTED') && !text(done).includes('Approve this plan'))
    // A refused read shows an error state, not a blank page.
    const failing = approvalsScreen(pending, ctxOf({ screen: 'approvals', arg: null, sub: null }, async () => { throw new Error('HTTP 500') }))
    await tick()
    assert.ok(text(failing).includes('The request could not be read') && text(failing).includes('HTTP 500'))
  })

  it('Receipts: one row per receipt with its signature mark and a copyable hash; a broken chain shows its findings', async () => {
    const { recoveryScreen } = await screens()
    const root = recoveryScreen(state, ctxOf())
    const rows = findAll(root, (e) => e.tag === 'ol' && hasClass(e, 'chain'))[0].children
    assert.equal(rows.length, 5)
    assert.ok(rows.every((r) => findAll(r, (e) => hasClass(e, 'sig') && hasClass(e, 'y')).length === 1))
    assert.equal(findAll(root, (e) => e.tag === 'button' && /^Copy sha256:/.test(e.attrs['aria-label'] ?? '')).length, 5)
    const t = text(root)
    assert.ok(t.includes('chain verified · 5 receipts') && t.includes('Runs and undo') && t.includes('cap-20261118120000-abcdef'))
    const broken = clone(state)
    broken.story.result = { mission_id: MISSION, chain_ok: false, chain_findings: [{ seq: 2, problem: 'signature does not verify' }], versions: [], requests: [], runs: [], links: [], timeline: [], history: null }
    const bt = recoveryScreen(broken, ctxOf())
    assert.ok(text(bt).includes('signature does not verify') && findAll(bt, (e) => hasClass(e, 'sig') && hasClass(e, 'n')).length === 1)
    assert.equal(missionVerdict(broken.story.result).label, 'UNVERIFIABLE')
    assert.deepEqual(receiptRows(broken.story.result).map((r) => [r.seq, r.sig]), [[2, false]])
  })
})

describe('Console confirmation survives the reload (round 3)', () => {
  const REQ = 'apr-00000000000000b2'
  const PLAN_ID = 'plan-0123456789ab'
  const SQL_TEXT = 'SELECT 1;\n'
  const pending = () => ({
    ...state,
    approvals: { ok: true, result: { requests: [{ request_id: REQ, plan_id: PLAN_ID, state: 'pending', requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1800_000).toISOString() }] } },
  })
  const detail = {
    ok: true, command: 'approvals',
    result: {
      request_id: REQ, plan_id: PLAN_ID, state: 'pending', expires_at: new Date(Date.now() + 1800_000).toISOString(), agent_note: '', agent_note_is: 'written by the agent; not verified',
      files: [{ path: 'demo/migrations/004.sql', sql: SQL_TEXT, matches_now: true }],
      report: { valid: true, verdict: 'SAFE', rows_deleted: 0, tables: { orders: { protected: true, rows_before: 3, rows_after: 3, rows_lost: 0 } }, schema_delta: { added_columns: [], removed_columns: [], removed_tables: [] } },
    },
  }
  const txt = (n) => n.textContent.replace(/\s+/g, ' ')
  const fire = (el, type, ev = {}) => Promise.all((el.listeners[type] ?? []).map((fn) => fn({ preventDefault() {}, target: el, ...ev })))
  const tickOnce = () => new Promise((r) => setTimeout(r, 0))

  it('Approve keeps a notice in ctx.ui.notice; it shows after the reload with the receipt, a Flight Recorder link and a dismiss button', async () => {
    const { approvalsScreen, noticeBar } = await screens()
    const HASH = 'ab'.repeat(32)
    const ctx = { ui: {}, mission: MISSION, route: { screen: 'approvals' }, rerender: () => {}, api: null, reload: null }
    const posted = []
    ctx.api = async (p, o) => (o?.method === 'POST' ? (posted.push([p, o.body]), { ok: true, command: 'approve', result: { request_id: REQ, plan_id: PLAN_ID, expires_at: new Date().toISOString(), passphrase_source: 'stdin', receipt_hash: HASH } }) : detail)
    let afterReload = null
    ctx.reload = async () => {
      // what app.js render() does: the view is rebuilt, the notice comes from ctx.ui
      afterReload = noticeBar(ctx.ui.notice, state, ctx, MISSION)
    }
    const root = approvalsScreen(pending(), ctx)
    await tickOnce()
    await tickOnce()
    const box = findAll(root, (e) => e.attrs.id === 'reviewed')[0]
    const pass = findAll(root, (e) => e.attrs.id === 'passphrase')[0]
    box.checked = true
    await fire(box, 'change')
    pass.value = 'demo-only passphrase'
    await fire(pass, 'input')
    // duplicate submit: two Enter presses at once send one request
    await Promise.all([fire(pass, 'keydown', { key: 'Enter' }), fire(pass, 'keydown', { key: 'Enter' })])
    assert.equal(posted.length, 1, 'one POST only')
    assert.equal(posted[0][1].confirm, PLAN_ID)
    assert.ok(ctx.ui.notice && ctx.ui.notice.tone === 'good' && ctx.ui.notice.mission === MISSION)
    assert.ok(afterReload, 'the notice is built after the reload')
    const t = txt(afterReload)
    assert.ok(t.includes(`Approved ${REQ}`) && t.includes('signed receipt'), t)
    assert.ok(findAll(afterReload, (e) => e.textContent.includes(HASH.slice(0, 8))).length > 0, 'the receipt hash is shown')
    const link = findAll(afterReload, (e) => e.tag === 'a')[0]
    assert.equal(link.attrs.href, `#/missions/${MISSION}`)
    assert.ok(hasClass(afterReload, 'pop') && hasClass(afterReload, 'good'))
    assert.equal(pass.value, '', 'the passphrase is not kept')
    // dismiss clears it
    let rerendered = 0
    ctx.rerender = () => { rerendered += 1 }
    const dismiss = findAll(afterReload, (e) => e.tag === 'button' && hasClass(e, 'dismiss'))[0]
    await fire(dismiss, 'click')
    assert.equal(ctx.ui.notice, null)
    assert.equal(rerendered, 1)
    // a fresh render of the approval screen starts with the box unticked and Approve disabled
    const again = approvalsScreen(pending(), { ...ctx, ui: {} })
    await tickOnce()
    await tickOnce()
    assert.ok(!findAll(again, (e) => e.attrs.id === 'reviewed')[0].checked, 'unticked after the reload')
    assert.ok(findAll(again, (e) => e.tag === 'button' && hasClass(e, 'approve'))[0].attrs.disabled !== undefined)
  })

  it('a notice is shown only for its own mission, and a failure is not a notice', async () => {
    const { noticeBar, setNotice } = await screens()
    const ctx = { ui: {}, rerender: () => {} }
    setNotice(ctx, MISSION, 'bad', { command: 'undo', result: { capture_id: 'cap-20261119120000-abcdef', status: 'FAILED', verification: { status: 'FAIL' } } })
    assert.equal(noticeBar(ctx.ui.notice, state, ctx, 'another-mission'), null, 'other mission: nothing')
    const bar = noticeBar(ctx.ui.notice, state, ctx, MISSION)
    assert.ok(hasClass(bar, 'bad') && !hasClass(bar, 'good'), 'a failed undo is not drawn green')
    assert.ok(txt(bar).includes('newest in the chain'), 'without a returned hash the newest receipt is labelled as such')
    assert.equal(noticeBar(null, state, ctx, MISSION), null)
    const css = readFileSync(path.join(STATIC_DIR, 'style.css'), 'utf8')
    assert.match(css, /\.notice\.good\s*\{[^}]*box-shadow/)
    assert.match(readFileSync(path.join(STATIC_DIR, 'app.js'), 'utf8'), /ui\.notice\.mission !== cur\) ui\.notice = null/)
  })
})

describe('Console empty and error states (T28)', () => {
  it('every screen has an empty state and an error state', async () => {
    const { missionsScreen, impactScreen, approvalsScreen, recoveryScreen } = await screens()
    const none = { story: { ok: false, command: 'history', error: { code: 'NO_RECEIPTS', message: 'mission x has no receipts' } }, verify: null, approvals: { ok: true, result: { requests: [] } }, status: null }
    for (const [name, fn] of Object.entries({ missionsScreen, impactScreen, recoveryScreen })) {
      const n = fn(none, ctxOf())
      assert.ok(hasClass(n, 'statebox') && hasClass(n, 'empty'), name)
      assert.ok(text(n).includes('No mission recorded yet'), name)
    }
    assert.ok(text(approvalsScreen(none, ctxOf())).includes('Nothing to approve'))
    const broken = { ...none, story: { ok: false, command: 'history', error: { code: 'CHAIN_BROKEN', message: 'receipt 3 does not verify' } }, approvals: { ok: false, error: { code: 'X', message: 'cannot read' } } }
    for (const fn of [missionsScreen, impactScreen, recoveryScreen]) {
      const n = fn(broken, ctxOf())
      assert.ok(hasClass(n, 'statebox') && hasClass(n, 'error') && n.attrs.role === 'alert')
      assert.ok(text(n).includes('CHAIN_BROKEN'))
    }
    assert.ok(hasClass(approvalsScreen(broken, ctxOf()), 'error'))
    // Impact with a mission but no denial: the replay says so instead of inventing one.
    const safeOnly = clone(state)
    safeOnly.story.result.versions = safeOnly.story.result.versions.filter((v) => v.verdict === 'SAFE')
    assert.ok(text(impactScreen(safeOnly, ctxOf())).includes('Nothing to replay'))
    assert.equal(counterfactual(safeOnly.story.result), null)
  })

  it('the loading state is in the page before any script runs', () => {
    const html = readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8')
    assert.match(html, /class="statebox loading"/)
  })
})

describe('Console model (T28)', () => {
  it('colour language: one tone per verdict, the same everywhere', () => {
    assert.deepEqual(['SAFE', 'DATA LOSS', 'LOGIC CHANGE', 'pending', 'something-else'].map(toneOf), ['ok', 'bad', 'bad', 'warn', 'warn'])
    // T25 v2 verdicts: denials are red, an untrusted rehearsal is grey.
    assert.deepEqual(['LOGIC BYPASS', 'INVARIANT VIOLATED', 'REQUIREMENT UNMET', 'UNVERIFIABLE'].map(toneOf), ['bad', 'bad', 'bad', 'mute'])
    assert.deepEqual(headline(state.story.result).map((b) => [b.step, b.tone]), [['Plan proposed', 'info'], ['JustRunMe rehearsed', 'bad'], ['Blocked, then repaired', 'fix'], ['COMPLETED · VERIFIED', 'ok']])
    assert.deepEqual(missionVerdict(state.story.result), { label: 'COMPLETED · VERIFIED', tone: 'ok' })
    const pending = clone(state.story.result)
    pending.requests[0].state = 'pending'
    pending.runs = []
    pending.links = []
    assert.deepEqual(missionVerdict(pending), { label: 'NEEDS APPROVAL', tone: 'warn' })
    const off = clone(state.story.result)
    off.links[0].links[3].ok = false
    assert.deepEqual(missionVerdict(off), { label: 'NOT AS REHEARSED', tone: 'bad' })
  })
})

describe('Console look: contrast, offline, header (T28)', () => {
  const css = readFileSync(path.join(STATIC_DIR, 'style.css'), 'utf8')
  const vars = Object.fromEntries([...css.matchAll(/--([a-z0-9]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]))
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
  }

  it('every text and badge colour pair is at least 4.5:1 (WCAG AA)', () => {
    const pairs = []
    for (const bg of ['bg', 'panel', 'panel2', 'code']) for (const fg of ['text', 'muted', 'green', 'red', 'link']) pairs.push([fg, bg])
    for (const bg of ['bg', 'panel', 'panel2', 'code']) for (const fg of ['amber', 'violet']) pairs.push([fg, bg])
    for (const tone of ['green', 'amber', 'red', 'violet', 'grey', 'link']) pairs.push(['ink', tone])
    pairs.push(['text', 'neutral'], ['grey', 'bg'], ['ink', 'green'])
    for (const [fg, bg] of pairs) assert.ok(ratio(vars[fg], vars[bg]) >= 4.5, `${fg} on ${bg}: ${ratio(vars[fg], vars[bg]).toFixed(2)}`)
    // The Kiro-native palette: obsidian base, violet-tinted surfaces, violet accent; emerald, amber, crimson for status.
    assert.deepEqual([vars.bg, vars.bg2, vars.panel, vars.accent, vars.accent2, vars.violet], ['#0b0a10', '#13111c', '#1a1726', '#8b5cf6', '#9046ff', '#a78bfa'])
    assert.deepEqual([vars.green, vars.amber, vars.red], ['#34d399', '#fbbf24', '#fb7185'])
  })

  it('motion is purposeful and switched off under prefers-reduced-motion', () => {
    for (const k of ['@keyframes glow', '@keyframes grow', '@keyframes reveal', '@keyframes pop', '@keyframes shake']) assert.ok(css.includes(k), k)
    assert.match(css, /\.node\.on \.disc \{ animation: glow/)
    assert.match(css, /\.pill\.warn\.pulse/)
    assert.match(css, /\.track \.fill \{ animation: grow/)
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([^}]*\{[^}]*\})/.exec(css)
    assert.ok(reduced && /animation: none !important/.test(reduced[1]) && /transition: none !important/.test(reduced[1]), 'all motion off')
  })

  it('the page and its scripts load nothing from outside: no URL, import or font file', () => {
    for (const f of readdirSync(STATIC_DIR)) {
      const src = readFileSync(path.join(STATIC_DIR, f), 'utf8')
      // Links (never loaded) to the project's own public repository are allowed in the Setup and Built with Kiro module only.
      const own = (u) => f === 'onboarding.js' && /^https:\/\/github\.com\/justrunme\/justrunme-zero(\/|\\|$)/.test(u)
      const urls = [...src.matchAll(/https?:\/\/[^\s'")`]+/g)].map((m) => m[0]).filter((u) => u !== 'http://www.w3.org/2000/svg' && !u.startsWith('http://127.0.0.1') && !own(u))
      assert.deepEqual(urls, [], f)
      assert.doesNotMatch(src, /@import|@font-face|url\(|\.innerHTML|insertAdjacentHTML|outerHTML|document\.write|\beval\(|new Function/, f)
    }
  })

  it('the header carries the brand line and the tagline; every static file is served', async () => {
    const html = readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8')
    assert.ok(html.includes('JustRunMe') && html.includes('Rehearse. Run. Recover.'))
    assert.ok(html.includes('AI agents can write code. JustRunMe proves what happens when they run it.'))
    const c = await startConsole({ repoDir, mission: MISSION })
    try {
      for (const f of readdirSync(STATIC_DIR)) {
        const res = await fetch(`http://127.0.0.1:${c.port}/${f}`)
        assert.equal(res.status, 200, f)
        assert.equal(await res.text(), readFileSync(path.join(STATIC_DIR, f), 'utf8'), f)
      }
    } finally {
      await c.close()
    }
  })
})
