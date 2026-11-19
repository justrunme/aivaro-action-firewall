/**
 * T25 v3 (docs/experiments/T25-v3-protocol.md), changes 1 and 2, without Docker: how the
 * delete audit and the fired triggers turn into a verdict and into what an agent is told.
 * The Docker tests (test/demo-t25v3.test.js) run the same against real Postgres.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { firedTriggers } from '../src/rehearsal/observe.js'
import { buildImpact } from '../src/rehearsal/impact.js'
import { explainReport } from '../src/explain/remediation.js'

const db = (orders) => ({ schema_hash: 'sha256:x', columns: { orders: ['id integer'], patches: ['id integer'] }, tables: { orders: { rows: orders, checksum: 'a' }, patches: { rows: 5, checksum: 'b' } } })
const ok = [{ id: 'step-1', status: 'ok' }]
const TRIGGER = { trigger: 'patches_release_sold_out', table: 'public.patches', timing: 'AFTER', event: 'UPDATE OF available_count', level: 'ROW', fired: 1 }
const bypass = (extra) => ({ evidence: [], unverifiable: [], ...extra })
const impact = (after, extra) => buildImpact({ before: db(3), after, protectedTables: ['orders', 'patches'], steps: ok, bypass: bypass(extra) })

describe('T25 v3 change 1: delete audit in the verdict', () => {
  it('a row deleted and inserted again (same count at the end) is DATA LOSS', () => {
    const r = impact(db(3), { deleted: { orders: 1 } })
    assert.equal(r.verdict, 'DATA LOSS')
    assert.deepEqual(r.evidence, [{ kind: 'protected_rows_deleted', table: 'orders', rows: 1 }])
    assert.equal(r.rows_deleted, 0, 'the end-state count alone shows nothing, which is the point')
  })

  it('no audited delete and an unchanged count: SAFE', () => {
    assert.equal(impact(db(3), { deleted: {} }).verdict, 'SAFE')
    assert.equal(impact(db(3), {}).verdict, 'SAFE')
  })

  it('a net loss reports the net loss and the number of rows deleted (3 deleted, 2 inserted back: 1 lost, 3 deleted)', () => {
    const r = impact(db(2), { deleted: { orders: 3 } })
    assert.deepEqual(r.evidence, [{ kind: 'protected_rows_lost', table: 'orders', rows_before: 3, rows_after: 2 }, { kind: 'protected_rows_deleted', table: 'orders', rows: 3 }])
  })

  it('a table that is not protected is not audited into a verdict', () => {
    assert.equal(buildImpact({ before: db(3), after: db(3), protectedTables: ['patches'], steps: ok, bypass: bypass({ deleted: { orders: 1 } }) }).verdict, 'SAFE')
  })
})

describe('T25 v3 change 2: the trigger that fired, in DATA LOSS only', () => {
  it('DATA LOSS carries the trigger with name, table, timing, event, level and count, and nothing else', () => {
    const r = impact(db(2), { deleted: { orders: 1 }, fired: [TRIGGER] })
    const e = r.evidence.find((x) => x.kind === 'trigger_fired')
    assert.deepEqual(e, { kind: 'trigger_fired', ...TRIGGER })
    assert.deepEqual(Object.keys(e).sort(), ['event', 'fired', 'kind', 'level', 'table', 'timing', 'trigger'])
  })

  it('a verdict other than DATA LOSS does not carry it', () => {
    assert.equal(impact(db(3), { fired: [TRIGGER] }).evidence.some((e) => e.kind === 'trigger_fired'), false)
    const bypassed = impact(db(2), { evidence: [{ kind: 'bypass_statement', what: 'x', statement: 'y' }], fired: [TRIGGER] })
    assert.equal(bypassed.verdict, 'LOGIC BYPASS')
    assert.equal(bypassed.evidence.some((e) => e.kind === 'trigger_fired'), false)
  })

  it('firedTriggers lists a trigger only when it should have fired and its function ran', () => {
    const w = (name, foid) => ({ trigger: `public.patches.${name}`, name, table: 'public.patches', timing: 'AFTER', event: 'UPDATE', level: 'ROW', foid })
    const installed = { watchers: [w('a', '1'), w('b', '2'), w('c', '3')] }
    const got = firedTriggers({
      installed,
      expected: { 'public.patches.a': 2, 'public.patches.b': 1 },
      callsBefore: { 1: 0, 2: 5, 3: 0 },
      callsAfter: { 1: 2, 2: 5, 3: 4 },
    })
    assert.deepEqual(got.map((x) => [x.trigger, x.fired]), [['a', 2]], 'b did not run, c was never expected')
  })

  it('what the agent is told: evidence and a constraint of facts, with no SQL, function or hint', () => {
    const report = { verdict: 'DATA LOSS', plan_id: 'plan-x', base_hash: 'h', tables: {}, steps: ok, ...impact(db(2), { deleted: { orders: 1 }, fired: [TRIGGER] }) }
    const out = explainReport(report, { used: 1 })
    assert.equal(out.status, 'DENIED')
    const c = out.remediation.constraints.find((x) => x.kind === 'logic_fired')
    assert.deepEqual(c.measured, { table: 'public.patches', timing: 'AFTER', event: 'UPDATE OF available_count', level: 'ROW', fired: 1 })
    assert.match(c.text, /patches_release_sold_out on public\.patches \(AFTER UPDATE OF available_count, per row\) fired 1 time/)
    const told = JSON.stringify(out)
    for (const hint of [/release_sold_out_patch/, /\bDELETE FROM\b/i, /\bCREATE\b/i, /\bDISABLE\b/i, /\bshould\b/i, /\btry\b/i]) assert.doesNotMatch(told, hint)
    assert.ok(out.remediation.constraints.some((x) => x.kind === 'rows_not_deleted'))
  })
})
