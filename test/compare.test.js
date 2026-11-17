/**
 * T17 Counterfactual Replay (R15.1 to R15.5): comparability, deterministic choice,
 * signed selection receipt, replay. Reports are built and signed the way
 * src/rehearsal/engine.js stores them, so no Docker is needed.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { loadOrCreateKeys, publicKeyHex, signValue } from '../src/receipts/keys.js'
import { appendReceipt, chainPath, verifyChain } from '../src/receipts/chain.js'
import { checkPolicy } from '../src/receipts/policy.js'
import { hashValue } from '../src/util/canonical.js'
import { baseHash } from '../src/fidelity/gate.js'
import { reportPath } from '../src/rehearsal/engine.js'
import { rankPlans } from '../src/compare/rank.js'
import { comparePlans, comparisonPath, verifySelection } from '../src/compare/select.js'
import { selectionGate } from '../src/compare/gate.js'

const MISSION = 'mission-compare'
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}
const keys = loadOrCreateKeys(tmp('jrm-cmp-keys-'))
const otherKeys = loadOrCreateKeys(tmp('jrm-cmp-other-'))

const BASE = {
  target: { project: 'demo', db_service: 'db', db_name: 'pumpkin_patch', compose_file_hash: 'sha256:' + 'c'.repeat(64) },
  git_head: 'a'.repeat(40),
  tree_hash: 'b'.repeat(40),
  images: { db: 'sha256:' + 'd'.repeat(64) },
  postgres: { pumpkin_patch: { schema_hash: 'sha256:' + 'e'.repeat(64), tables: { orders: { rows: 3, checksum: 'x1' }, patches: { rows: 4, checksum: 'x2' } } } },
}
const CONDITIONS = { protected_tables: ['orders', 'patches'], impact_thresholds: {}, db_name: 'pumpkin_patch', tests_measured: false }
const pid = (n) => 'plan-' + String(n).padStart(12, '0')

/** Store a signed report and its rehearsal receipt, as engine.js does. */
function rehearsed(dir, { plan, verdict = 'SAFE', duration = 1000, irreversible = [], base = BASE, conditions = CONDITIONS, ordersLost = 0, signer = keys, record = true }) {
  const tables = {
    orders: { rows_before: 3, rows_after: 3 - ordersLost, rows_lost: ordersLost, content_changed: false, protected: true },
    patches: { rows_before: 4, rows_after: 4, rows_lost: 0, content_changed: false, protected: true },
  }
  const body = {
    version: 1,
    mission_id: MISSION,
    plan_id: plan,
    contract_hash: 'sha256:' + plan.slice(5).padEnd(64, '0'),
    base_hash: baseHash({ base }),
    fingerprint: { base, plan: { plan_hash: plan } },
    rehearsed_at: '2026-11-17T10:00:00.000Z',
    duration_ms: duration,
    steps: [{ id: 'migrate', status: verdict === 'FAILED' ? 'failed' : 'ok' }],
    irreversible_actions: irreversible,
    all_reversible: irreversible.length === 0,
    conditions,
    verdict,
    evidence: verdict === 'DATA LOSS' ? [{ kind: 'protected_rows_lost', table: 'orders' }] : [],
    tables: verdict === 'FAILED' ? undefined : tables,
    operator_pubkey: publicKeyHex(signer.publicKey),
  }
  if (conditions === null) delete body.conditions // a report from before conditions were recorded
  const report = { ...body, signature: signValue(signer.privateKey, body) }
  const file = reportPath(dir, MISSION, plan)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  if (record) {
    appendReceipt({ repoDir: dir, keys, missionId: MISSION, kind: 'rehearsal', verdict, subject: { plan_id: plan, report_hash: hashValue(report), base_hash: report.base_hash, duration_ms: duration, evidence: report.evidence } })
  }
  return report
}

const chainOf = (dir) => verifyChain({ repoDir: dir, home: keys.home, publicKey: keys.publicKey, missionId: MISSION })
const compare = (dir, planIds) => comparePlans({ repoDir: dir, keys, missionId: MISSION, planIds })
const refusedWith = (code, check = () => true) => (e) => e.code === code && check(e)

describe('T17 ranking rule (R15.4, R15.5)', () => {
  const row = (plan_id, o = {}) => ({ plan_id, verdict: 'SAFE', rows_lost: {}, failing_tests: null, duration_ms: 100, all_reversible: true, irreversible_actions: [], ...o })

  it('removes DATA LOSS and FAILED, and the rule that left one plan decides', () => {
    const r = rankPlans([row(pid(1), { verdict: 'DATA LOSS', duration_ms: 1 }), row(pid(2), { duration_ms: 900 }), row(pid(3), { verdict: 'FAILED', duration_ms: 2 })])
    assert.equal(r.recommended, pid(2))
    assert.equal(r.decided_by, 'R15.4.1')
    assert.deepEqual(r.removed.map((x) => [x.plan_id, x.rule]), [[pid(1), 'R15.4.1'], [pid(3), 'R15.4.1']])
  })

  it('prefers reversible plans, but keeps irreversible ones when every remaining plan has them', () => {
    const a = rankPlans([row(pid(1), { all_reversible: false, irreversible_actions: ['send_email'], duration_ms: 1 }), row(pid(2), { duration_ms: 500 })])
    assert.deepEqual([a.recommended, a.decided_by], [pid(2), 'R15.4.3'])
    const b = rankPlans([row(pid(1), { all_reversible: false, irreversible_actions: ['x'], duration_ms: 7 }), row(pid(2), { all_reversible: false, irreversible_actions: ['y'], duration_ms: 5 })])
    assert.deepEqual([b.recommended, b.decided_by], [pid(2), 'R15.4.4'])
    assert.match(b.rules.find((x) => x.rule === 'R15.4.3').note, /every remaining plan has irreversible actions/)
  })

  it('lowest duration wins; equal duration goes to the smallest plan_id; the test rule says it was not measured', () => {
    const d = rankPlans([row(pid(9), { duration_ms: 10 }), row(pid(5), { duration_ms: 10 }), row(pid(7), { duration_ms: 11 })])
    assert.deepEqual([d.recommended, d.decided_by], [pid(5), 'R15.4.5'])
    assert.match(d.rules.find((x) => x.rule === 'R15.4.2').note, /no plan had its tests measured/)
  })

  it('R15.5: when nothing survives, nothing is recommended and each plan names the rule that removed it', () => {
    const r = rankPlans([row(pid(1), { verdict: 'DATA LOSS' }), row(pid(2), { verdict: 'FAILED' })])
    assert.equal(r.recommended, null)
    assert.equal(r.decided_by, 'R15.4.1')
    assert.deepEqual(r.removed, [
      { plan_id: pid(1), rule: 'R15.4.1', reason: 'verdict DATA LOSS' },
      { plan_id: pid(2), rule: 'R15.4.1', reason: 'verdict FAILED' },
    ])
  })

  it('measured failing tests remove plans; tests measured for only some plans is refused', () => {
    const r = rankPlans([row(pid(1), { failing_tests: 2, duration_ms: 1 }), row(pid(2), { failing_tests: 0 })])
    assert.deepEqual([r.recommended, r.decided_by], [pid(2), 'R15.4.2'])
    assert.throws(() => rankPlans([row(pid(1), { failing_tests: 0 }), row(pid(2))]), /some plans only/)
  })

  const arbRow = fc.record({
    plan_id: fc.integer({ min: 0, max: 40 }).map(pid),
    verdict: fc.constantFrom('SAFE', 'DATA LOSS', 'FAILED'),
    duration_ms: fc.integer({ min: 0, max: 50 }),
    all_reversible: fc.boolean(),
  }).map((r) => row(r.plan_id, { ...r, irreversible_actions: r.all_reversible ? [] : ['ext'] }))
  const arbRows = fc.uniqueArray(arbRow, { minLength: 2, maxLength: 8, selector: (r) => r.plan_id })

  it('property: input order never changes the result, and a plan that is not SAFE is never recommended', () => {
    fc.assert(
      fc.property(arbRows, fc.integer(), (rows, seed) => {
        const shuffled = [...rows].sort((a, b) => ((a.duration_ms * 31 + seed) % 7) - ((b.duration_ms * 31 + seed) % 7) || (a.plan_id < b.plan_id ? 1 : -1))
        const x = rankPlans(rows)
        assert.deepEqual(rankPlans(shuffled), x)
        if (x.recommended !== null) {
          const pick = rows.find((r) => r.plan_id === x.recommended)
          assert.equal(pick.verdict, 'SAFE')
          const safe = rows.filter((r) => r.verdict === 'SAFE')
          const pool = safe.some((r) => r.all_reversible) ? safe.filter((r) => r.all_reversible) : safe
          assert.equal(pick.duration_ms, Math.min(...pool.map((r) => r.duration_ms)))
          assert.equal(pick.all_reversible, pool[0].all_reversible)
        } else {
          assert.ok(rows.every((r) => r.verdict !== 'SAFE'))
          assert.equal(x.removed.length, rows.length)
        }
      }),
      { numRuns: 300 }
    )
  })
})

describe('T17 comparison of stored rehearsals (R15.1 to R15.3)', () => {
  it('compares two plans on the same base, records a signed choice, and the replay agrees', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS', duration: 400, ordersLost: 1 })
    rehearsed(dir, { plan: pid(2), duration: 900 })
    const r = compare(dir, [pid(2), pid(1)])
    assert.equal(r.comparison.ranking.recommended, pid(2))
    assert.equal(r.comparison.ranking.decided_by, 'R15.4.1')
    // R15.3: measured values only, per plan.
    assert.deepEqual(r.comparison.plans.map((p) => [p.plan_id, p.verdict, p.rows_lost.orders, p.failing_tests, p.duration_ms, p.all_reversible]), [
      [pid(1), 'DATA LOSS', 1, null, 400, true],
      [pid(2), 'SAFE', 0, null, 900, true],
    ])
    const v = chainOf(dir)
    assert.equal(v.ok, true, JSON.stringify(v.findings))
    const sel = v.receipts.at(-1)
    assert.deepEqual([sel.kind, sel.verdict, sel.subject.recommended, sel.subject.decided_by], ['plan_selected', 'selected', pid(2), 'R15.4.1'])
    assert.equal(sel.subject.comparison_hash, r.comparison_hash)
    assert.equal(checkPolicy(v.receipts).ok, true, JSON.stringify(checkPolicy(v.receipts).findings))
    const replay = verifySelection({ repoDir: dir, home: keys.home, publicKey: keys.publicKey, missionId: MISSION })
    assert.deepEqual(replay, { ok: true, findings: [], recommended: pid(2), decided_by: 'R15.4.1', reports_rechecked: 2 })
    // Same inputs, same choice.
    assert.deepEqual(compare(dir, [pid(1), pid(2)]).comparison.ranking, r.comparison.ranking)
  })

  it('records "none" when no plan survives', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS', ordersLost: 1 })
    rehearsed(dir, { plan: pid(2), verdict: 'FAILED' })
    const r = compare(dir, [pid(1), pid(2)])
    assert.equal(r.comparison.ranking.recommended, null)
    assert.equal(chainOf(dir).receipts.at(-1).verdict, 'none')
    assert.equal(r.comparison.plans[1].rows_lost.orders, null, 'a failed rehearsal has no measured row counts')
  })

  it('R15.2: refuses plans rehearsed on a different source state and names the component', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1) })
    const drifted = structuredClone(BASE)
    drifted.postgres.pumpkin_patch.tables.orders.checksum = 'x9'
    rehearsed(dir, { plan: pid(2), base: drifted })
    assert.throws(() => compare(dir, [pid(1), pid(2)]), refusedWith('BASE_MISMATCH', (e) => e.detail[0].diffs.some((d) => d.component === 'base.postgres.pumpkin_patch.tables.orders.checksum')))
    const last = chainOf(dir).receipts.at(-1)
    assert.deepEqual([last.kind, last.verdict], ['plan_comparison_refused', 'BASE_MISMATCH'])
    assert.equal(chainOf(dir).receipts.some((r) => r.kind === 'plan_selected'), false)
  })

  it('refuses plans rehearsed against another environment with identical data', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1) })
    rehearsed(dir, { plan: pid(2), base: { ...BASE, target: { ...BASE.target, project: 'twin' } } })
    assert.throws(() => compare(dir, [pid(1), pid(2)]), refusedWith('BASE_MISMATCH', (e) => e.detail[0].diffs.some((d) => d.component === 'base.target.project')))
  })

  it('refuses plans judged under different rehearsal conditions, or with unknown conditions', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1) })
    rehearsed(dir, { plan: pid(2), conditions: { ...CONDITIONS, protected_tables: ['patches'] } })
    assert.throws(() => compare(dir, [pid(1), pid(2)]), refusedWith('CONDITIONS_MISMATCH', (e) => e.detail[0].diffs[0].component === 'conditions.protected_tables'))
    rehearsed(dir, { plan: pid(3), conditions: null })
    assert.throws(() => compare(dir, [pid(1), pid(3)]), refusedWith('CONDITIONS_UNKNOWN'))
  })

  it('refuses an edited report, a report signed by another key, and a report the chain does not record', () => {
    const dir = tmp('jrm-cmp-')
    const danger = rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS', ordersLost: 1 })
    rehearsed(dir, { plan: pid(2) })
    const file = reportPath(dir, MISSION, pid(1))
    writeFileSync(file, JSON.stringify({ ...danger, verdict: 'SAFE', evidence: [] }))
    assert.throws(() => compare(dir, [pid(1), pid(2)]), refusedWith('REPORT_INVALID'))
    rehearsed(dir, { plan: pid(1), signer: otherKeys, record: false })
    assert.throws(() => compare(dir, [pid(1), pid(2)]), refusedWith('REPORT_INVALID', (e) => /different key/.test(e.message)))
    // Operator-signed, but never recorded by a rehearsal receipt.
    rehearsed(dir, { plan: pid(3), record: false })
    assert.throws(() => compare(dir, [pid(2), pid(3)]), refusedWith('NOT_IN_CHAIN'))
    // An older genuine report put back after a newer rehearsal of the same plan.
    const old = readFileSync(reportPath(dir, MISSION, pid(2)), 'utf8')
    rehearsed(dir, { plan: pid(2), duration: 5 })
    writeFileSync(reportPath(dir, MISSION, pid(2)), old)
    writeFileSync(file, JSON.stringify(danger))
    assert.throws(() => compare(dir, [pid(1), pid(2)]), refusedWith('NOT_IN_CHAIN', (e) => /latest rehearsal receipt/.test(e.message)))
  })

  it('refuses too few, duplicate and malformed plan ids, and a chain that does not verify (without writing to it)', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1) })
    rehearsed(dir, { plan: pid(2) })
    assert.throws(() => compare(dir, [pid(1)]), refusedWith('TOO_FEW_PLANS'))
    assert.throws(() => compare(dir, [pid(1), pid(1)]), refusedWith('DUPLICATE_PLAN'))
    assert.throws(() => compare(dir, [pid(1), '../../etc/passwd']), refusedWith('INVALID_PLAN_ID'))
    const before = readFileSync(chainPath(dir, MISSION))
    const bytes = Buffer.from(before)
    bytes[25] = bytes[25] ^ 1
    writeFileSync(chainPath(dir, MISSION), bytes)
    assert.throws(() => compare(dir, [pid(1), pid(2)]), refusedWith('CHAIN_INVALID'))
    assert.deepEqual(readFileSync(chainPath(dir, MISSION)), bytes)
  })
})

describe('T17 replay of a recorded selection', () => {
  it('detects an edited comparison file', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS', ordersLost: 1 })
    rehearsed(dir, { plan: pid(2) })
    const r = compare(dir, [pid(1), pid(2)])
    const file = comparisonPath(dir, MISSION, r.comparison_hash)
    const edited = structuredClone(r.comparison)
    edited.ranking.recommended = pid(1)
    writeFileSync(file, JSON.stringify(edited))
    const v = verifySelection({ repoDir: dir, home: keys.home, publicKey: keys.publicKey, missionId: MISSION })
    assert.equal(v.ok, false)
    assert.ok(v.findings.includes('comparison file differs from the one the receipt recorded'))
    assert.ok(v.findings.includes('comparison signature does not verify'))
    assert.ok(v.findings.includes('replayed ranking differs from the recorded one'))
  })

  it('a choice that does not follow the rule is caught by replay and by policy, even when signed by the operator', () => {
    const dir = tmp('jrm-cmp-')
    const danger = rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS', ordersLost: 1 })
    const safe = rehearsed(dir, { plan: pid(2) })
    const receipts = chainOf(dir).receipts
    const plans = [
      { plan_id: pid(1), verdict: 'DATA LOSS', rows_lost: { orders: 1, patches: 0 }, failing_tests: null, duration_ms: 1000, all_reversible: true, irreversible_actions: [] },
      { plan_id: pid(2), verdict: 'SAFE', rows_lost: { orders: 0, patches: 0 }, failing_tests: null, duration_ms: 1000, all_reversible: true, irreversible_actions: [] },
    ]
    const compared = [
      { plan_id: pid(1), report_hash: hashValue(danger), rehearsal_receipt: hashValue(receipts[0]) },
      { plan_id: pid(2), report_hash: hashValue(safe), rehearsal_receipt: hashValue(receipts[1]) },
    ]
    const body = { version: 1, mission_id: MISSION, base_hash: danger.base_hash, conditions: CONDITIONS, compared, plans, ranking: { recommended: pid(1), decided_by: 'R15.4.5', removed: [], rules: [] }, compared_at: '2026-11-17T10:00:00.000Z', operator_pubkey: publicKeyHex(keys.publicKey) }
    const signed = { ...body, signature: signValue(keys.privateKey, body) }
    const h = hashValue(signed)
    mkdirSync(path.dirname(comparisonPath(dir, MISSION, h)), { recursive: true })
    writeFileSync(comparisonPath(dir, MISSION, h), JSON.stringify(signed))
    appendReceipt({
      repoDir: dir,
      keys,
      missionId: MISSION,
      kind: 'plan_selected',
      verdict: 'selected',
      subject: { base_hash: danger.base_hash, comparison_hash: h, recommended: pid(1), decided_by: 'R15.4.5', compared: compared.map(({ plan_id, report_hash }) => ({ plan_id, report_hash })), removed: [] },
      refs: { [`rehearsal:${pid(1)}`]: compared[0].rehearsal_receipt, [`rehearsal:${pid(2)}`]: compared[1].rehearsal_receipt },
    })
    const v = verifySelection({ repoDir: dir, home: keys.home, publicKey: keys.publicKey, missionId: MISSION })
    assert.equal(v.ok, false)
    assert.ok(v.findings.includes('replayed ranking differs from the recorded one'))
    assert.ok(v.findings.includes('receipt names a different choice than the rule gives'))
    const p = checkPolicy(chainOf(dir).receipts)
    assert.equal(p.ok, false)
    assert.match(p.findings[0].rule, /verdict is DATA LOSS/)
  })
})

// PR 9 review: integrity of the evidence and the binding of the choice to authorization.
const BASE_HASH = baseHash({ base: BASE })
const gate = (dir, plan, base = BASE_HASH) => {
  const report = JSON.parse(readFileSync(reportPath(dir, MISSION, plan), 'utf8'))
  return selectionGate({
    receipts: chainOf(dir).receipts,
    planId: plan,
    reportHash: hashValue(report),
    baseHash: base,
    replay: (h) => verifySelection({ repoDir: dir, home: keys.home, publicKey: keys.publicKey, missionId: MISSION, receiptHash: h }),
  })
}
const replayOf = (dir) => verifySelection({ repoDir: dir, home: keys.home, publicKey: keys.publicKey, missionId: MISSION })
const rehearsalHash = (dir, plan) => hashValue(chainOf(dir).receipts.filter((r) => r.kind === 'rehearsal' && r.subject.plan_id === plan).at(-1))

/** Write an operator-signed comparison file and its plan_selected receipt, bypassing comparePlans. */
function forgeSelection(dir, { plans, compared, ranking }) {
  const body = { version: 1, mission_id: MISSION, base_hash: BASE_HASH, conditions: CONDITIONS, compared, plans, ranking, compared_at: '2026-11-17T10:00:00.000Z', operator_pubkey: publicKeyHex(keys.publicKey) }
  const signed = { ...body, signature: signValue(keys.privateKey, body) }
  const h = hashValue(signed)
  mkdirSync(path.dirname(comparisonPath(dir, MISSION, h)), { recursive: true })
  writeFileSync(comparisonPath(dir, MISSION, h), JSON.stringify(signed))
  appendReceipt({
    repoDir: dir,
    keys,
    missionId: MISSION,
    kind: 'plan_selected',
    verdict: ranking.recommended ? 'selected' : 'none',
    subject: { base_hash: BASE_HASH, comparison_hash: h, recommended: ranking.recommended, decided_by: ranking.decided_by, compared: compared.map(({ plan_id, report_hash }) => ({ plan_id, report_hash })), removed: ranking.removed },
    refs: Object.fromEntries(compared.map((c) => [`rehearsal:${c.plan_id}`, c.rehearsal_receipt])),
  })
}

describe('PR 9 review: signed inputs cannot be changed or swapped', () => {
  it('editing conditions or a measured value in a stored report breaks its signature', () => {
    const dir = tmp('jrm-cmp-')
    const a = rehearsed(dir, { plan: pid(1) })
    rehearsed(dir, { plan: pid(2) })
    const file = reportPath(dir, MISSION, pid(1))
    writeFileSync(file, JSON.stringify({ ...a, conditions: { ...a.conditions, protected_tables: ['patches'] } }))
    assert.throws(() => compare(dir, [pid(1), pid(2)]), refusedWith('REPORT_INVALID', (e) => /signature/.test(e.message)))
    const edited = structuredClone(a)
    edited.tables.orders.rows_lost = 0
    edited.duration_ms = 1
    writeFileSync(file, JSON.stringify(edited))
    assert.throws(() => compare(dir, [pid(1), pid(2)]), refusedWith('REPORT_INVALID', (e) => /signature/.test(e.message)))
  })

  it('replay checks every compared plan, not only the winner, and the plan sets must agree', () => {
    const dir = tmp('jrm-cmp-')
    const loser = rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS', ordersLost: 1, duration: 300 })
    const winner = rehearsed(dir, { plan: pid(2), duration: 900 })
    const row = (r, over = {}) => ({ plan_id: r.plan_id, verdict: r.verdict, rows_lost: { orders: r.tables.orders.rows_lost, patches: 0 }, failing_tests: null, duration_ms: r.duration_ms, all_reversible: true, irreversible_actions: [], ...over })
    const compared = [loser, winner].map((r) => ({ plan_id: r.plan_id, report_hash: hashValue(r), rehearsal_receipt: rehearsalHash(dir, r.plan_id) }))
    // The loser's measured duration is changed in an otherwise consistent, operator-signed file.
    const plans = [row(loser, { duration_ms: 1 }), row(winner)]
    forgeSelection(dir, { plans, compared, ranking: rankPlans(plans) })
    const v = replayOf(dir)
    assert.equal(v.ok, false)
    assert.ok(v.findings.includes(`${pid(1)}: measured values differ from the rehearsal receipt`), JSON.stringify(v.findings))
    assert.ok(v.findings.includes(`${pid(1)}: measured values differ from the stored report`))

    // An extra measured row that no receipt refers to.
    const dir2 = tmp('jrm-cmp-')
    const l2 = rehearsed(dir2, { plan: pid(1), verdict: 'DATA LOSS', ordersLost: 1 })
    const w2 = rehearsed(dir2, { plan: pid(2) })
    const c2 = [l2, w2].map((r) => ({ plan_id: r.plan_id, report_hash: hashValue(r), rehearsal_receipt: rehearsalHash(dir2, r.plan_id) }))
    const p2 = [row(l2), row(w2), row(w2, { plan_id: pid(0), duration_ms: 1 })]
    forgeSelection(dir2, { plans: p2, compared: c2, ranking: rankPlans(p2) })
    assert.ok(replayOf(dir2).findings.includes('compared plans differ between receipt, comparison file, measured rows and refs'))
  })
})

describe('PR 9 review: the selection binds authorization', () => {
  it('only the selected plan passes; the other plan is refused', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1), duration: 900 })
    rehearsed(dir, { plan: pid(2), duration: 400 })
    compare(dir, [pid(1), pid(2)])
    assert.deepEqual(gate(dir, pid(2)).mode, 'selected')
    assert.throws(() => gate(dir, pid(1)), refusedWith('PLAN_NOT_SELECTED'))
  })

  it('one plan on this state keeps single-rehearsal mode; several plans without a selection are refused', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1) })
    assert.deepEqual(gate(dir, pid(1)), { mode: 'single_rehearsal', receipt: null, stale_selection_ignored: false })
    rehearsed(dir, { plan: pid(2) })
    assert.throws(() => gate(dir, pid(1)), refusedWith('COMPARISON_REQUIRED', (e) => e.detail.plans.length === 2))
  })

  it('a selection made on another state grants nothing: it neither authorizes its plan nor blocks a fresh one', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS', ordersLost: 1 })
    rehearsed(dir, { plan: pid(2) })
    compare(dir, [pid(1), pid(2)])
    const drifted = structuredClone(BASE)
    drifted.postgres.pumpkin_patch.tables.orders.rows = 4
    const newBase = baseHash({ base: drifted })
    // The selected plan was not rehearsed on the new state.
    assert.throws(() => gate(dir, pid(2), newBase), refusedWith('REHEARSAL_NOT_ON_BASE'))
    // A plan rehearsed on the new state stands on its own rehearsal.
    rehearsed(dir, { plan: pid(3), base: drifted })
    assert.deepEqual(gate(dir, pid(3), newBase), { mode: 'single_rehearsal', receipt: null, stale_selection_ignored: true })
  })

  it('cherry-picking fails: leaving a plan out of the comparison, or rehearsing one afterwards, voids the selection', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1), duration: 900 })
    rehearsed(dir, { plan: pid(2), duration: 400 })
    rehearsed(dir, { plan: pid(3), verdict: 'DATA LOSS', ordersLost: 1 })
    compare(dir, [pid(1), pid(3)]) // pid(2), the faster SAFE plan, left out
    assert.throws(() => gate(dir, pid(1)), refusedWith('SELECTION_INCOMPLETE', (e) => e.detail.plans[0] === pid(2)))
    compare(dir, [pid(1), pid(2), pid(3)])
    assert.equal(gate(dir, pid(2)).mode, 'selected')
    rehearsed(dir, { plan: pid(4), duration: 100 })
    assert.throws(() => gate(dir, pid(2)), refusedWith('SELECTION_INCOMPLETE', (e) => e.detail.plans[0] === pid(4)))
  })

  it('a refused comparison changes nothing, and retrying cannot get around the gate', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1), duration: 900 })
    rehearsed(dir, { plan: pid(2), duration: 400 })
    compare(dir, [pid(1), pid(2)])
    assert.throws(() => compare(dir, [pid(1), pid(2), '../x']), refusedWith('INVALID_PLAN_ID'))
    assert.throws(() => compare(dir, [pid(1)]), refusedWith('TOO_FEW_PLANS'))
    assert.equal(chainOf(dir).receipts.at(-1).kind, 'plan_comparison_refused')
    // The earlier, valid selection still decides.
    assert.equal(gate(dir, pid(2)).mode, 'selected')
    assert.throws(() => gate(dir, pid(1)), refusedWith('PLAN_NOT_SELECTED'))
  })

  it('a plan rehearsed again after the comparison, an edited selection, and "none" are refused', () => {
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS', ordersLost: 1 })
    rehearsed(dir, { plan: pid(2) })
    const r = compare(dir, [pid(1), pid(2)])
    const file = comparisonPath(dir, MISSION, r.comparison_hash)
    const original = readFileSync(file)
    writeFileSync(file, original.toString().replace('"duration_ms": 1000', '"duration_ms": 999'))
    assert.throws(() => gate(dir, pid(2)), refusedWith('SELECTION_INVALID'))
    writeFileSync(file, original)
    rehearsed(dir, { plan: pid(2), duration: 1200 })
    assert.throws(() => gate(dir, pid(2)), refusedWith('SELECTION_OUTDATED'))

    const none = tmp('jrm-cmp-')
    rehearsed(none, { plan: pid(1), verdict: 'DATA LOSS', ordersLost: 1 })
    rehearsed(none, { plan: pid(2), verdict: 'FAILED' })
    compare(none, [pid(1), pid(2)])
    assert.throws(() => gate(none, pid(2)), refusedWith('NO_PLAN_SELECTED'))
  })

  it('policy checks the binding from the chain alone', () => {
    const add = (dir, plan, refs) => appendReceipt({ repoDir: dir, keys, missionId: MISSION, kind: 'authorization_issued', verdict: 'allow', subject: { plan_id: plan }, refs })
    const dir = tmp('jrm-cmp-')
    rehearsed(dir, { plan: pid(1), duration: 900 })
    rehearsed(dir, { plan: pid(2), duration: 400 })
    add(dir, pid(1), { rehearsal: rehearsalHash(dir, pid(1)) })
    assert.match(checkPolicy(chainOf(dir).receipts).findings.at(-1).rule, /several plans were rehearsed on this base, but none was selected/)

    const dir2 = tmp('jrm-cmp-')
    rehearsed(dir2, { plan: pid(1), duration: 900 })
    rehearsed(dir2, { plan: pid(2), duration: 400 })
    const sel = compare(dir2, [pid(1), pid(2)]).receipt_hash
    add(dir2, pid(1), { rehearsal: rehearsalHash(dir2, pid(1)), selection: sel })
    add(dir2, pid(1), { rehearsal: rehearsalHash(dir2, pid(1)) })
    add(dir2, pid(2), { rehearsal: rehearsalHash(dir2, pid(2)), selection: sel })
    const rules = checkPolicy(chainOf(dir2).receipts).findings.map((f) => f.rule)
    assert.deepEqual(rules, ['authorized a plan other than the selected one', 'a plan selection exists for this base but was not applied'])
  })
})
