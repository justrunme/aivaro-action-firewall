/**
 * T22: what the agent is told about a rehearsal. Built from measurements only,
 * and never a promise that a revision is safe.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { ATTEMPT_LIMIT, explainReport } from '../src/explain/remediation.js'
import { buildImpact } from '../src/rehearsal/impact.js'

const measured = (rows) => ({ schema_hash: 'sha256:x', columns: { orders: ['id integer'], patches: ['id integer'] }, tables: { orders: { rows: rows.orders, checksum: 'a' }, patches: { rows: rows.patches, checksum: 'b' } } })
const reportOf = (before, after, steps = [{ id: 'm1', status: 'ok', detail: '' }]) => ({
  plan_id: 'plan-0123456789ab',
  base_hash: 'sha256:' + 'b'.repeat(64),
  steps,
  ...buildImpact({ before: measured(before), after: measured(after), protectedTables: ['orders', 'patches'], steps }),
})

describe('structured remediation (T22)', () => {
  it('a dangerous plan: DENIED with the measured loss, constraints, and the next action', () => {
    const r = explainReport(reportOf({ orders: 12, patches: 3 }, { orders: 11, patches: 3 }), { used: 1 })
    assert.deepEqual([r.status, r.verdict, r.reason, r.rule, r.next_action], ['DENIED', 'DATA LOSS', 'DATA_LOSS', 'R2.6', 'REVISE_AND_REHEARSE'])
    assert.deepEqual(r.impact.rows_lost, { orders: 1, patches: 0 })
    assert.deepEqual(r.remediation.constraints.map((c) => [c.kind, c.table, c.measured]), [['rows_preserved', 'orders', { rows_before: 12, rows_after: 11 }]])
    assert.match(r.remediation.constraints[0].text, /Every existing row of orders must still exist/)
    assert.equal(r.remediation.next_action, 'REVISE_AND_REHEARSE')
    assert.match(r.measured_in, /disposable copy/)
    assert.deepEqual(r.attempts, { used: 1, limit: ATTEMPT_LIMIT })
  })

  it('a table or column that disappeared becomes a constraint too', () => {
    const before = measured({ orders: 12, patches: 3 })
    const after = { ...measured({ orders: 12, patches: 3 }), tables: { orders: before.tables.orders }, columns: { orders: [] } }
    const report = { plan_id: 'plan-0123456789ab', base_hash: 'sha256:x', steps: [], ...buildImpact({ before, after, protectedTables: ['orders', 'patches'], steps: [] }) }
    const kinds = explainReport(report, { used: 1 }).remediation.constraints.map((c) => c.kind)
    assert.ok(kinds.includes('table_preserved') && kinds.includes('column_preserved'), kinds.join(','))
  })

  it('a rehearsal whose step failed: DENIED as REHEARSAL_FAILED, with the failing step', () => {
    const r = explainReport(reportOf({ orders: 12, patches: 3 }, { orders: 12, patches: 3 }, [{ id: 'm1', status: 'failed', detail: 'syntax error at or near "ALTR"' }]), { used: 2 })
    assert.deepEqual([r.status, r.reason, r.next_action], ['DENIED', 'REHEARSAL_FAILED', 'FIX_AND_REHEARSE'])
    assert.deepEqual(r.impact.failed_steps, [{ id: 'm1', status: 'failed', detail: 'syntax error at or near "ALTR"' }])
    assert.equal(r.remediation.constraints[0].kind, 'step_must_succeed')
  })

  it('a SAFE plan: no remediation, the next action is to ask for approval', () => {
    const r = explainReport(reportOf({ orders: 12, patches: 3 }, { orders: 12, patches: 3 }), { used: 2 })
    assert.deepEqual([r.status, r.reason, r.rule, r.remediation, r.next_action], ['SAFE', null, null, null, 'REQUEST_APPROVAL'])
  })

  it('after too many attempts the next action is to ask the operator, not to keep trying', () => {
    const r = explainReport(reportOf({ orders: 12, patches: 3 }, { orders: 1, patches: 3 }), { used: ATTEMPT_LIMIT })
    assert.equal(r.next_action, 'ASK_OPERATOR')
    assert.equal(r.remediation.next_action, 'ASK_OPERATOR')
  })

  it('never promises that a revision will be safe', () => {
    const denied = explainReport(reportOf({ orders: 12, patches: 3 }, { orders: 5, patches: 3 }), { used: 1 })
    const text = JSON.stringify(denied.remediation)
    assert.match(denied.remediation.caution, /not a proof/)
    assert.doesNotMatch(text.replace(denied.remediation.caution, ''), /will be safe|is safe|guarantee|proven|certainly/i)
  })

  it('narrows what leaves the copy: error text to its first line, new object names only when the plan\'s SQL contains them', () => {
    const before = measured({ orders: 12, patches: 3 })
    const after = { ...before, columns: { ...before.columns, orders: ['id integer', 'status text', 'zz_leaked_value text'], exfil_9f3a: ['x text'] }, tables: { ...before.tables, exfil_9f3a: { rows: 7, checksum: 'c' } } }
    const steps = [{ id: 'm1', status: 'failed', detail: 'ERROR:  value "secret-customer-name" is wrong\nLINE 1: select\nmore detail' }]
    const report = { plan_id: 'plan-0123456789ab', base_hash: 'sha256:x', steps, ...buildImpact({ before, after, protectedTables: ['orders'], steps }) }
    const sql = 'ALTER TABLE orders ADD COLUMN status text;\nDO $$ BEGIN EXECUTE format($f$CREATE TABLE %I (x text)$f$, (SELECT name FROM customers LIMIT 1)); END $$;'
    const r = explainReport(report, { used: 1 }, { sqlText: sql })
    assert.deepEqual(r.impact.failed_steps[0].detail, 'ERROR:  value "secret-customer-name" is wrong'.slice(0, 160))
    assert.ok(!JSON.stringify(r).includes('LINE 1') && !JSON.stringify(r).includes('more detail'))
    assert.deepEqual(r.impact.schema_delta.added_columns, ['orders.status'], 'a column named in the SQL is shown, one that is not is not')
    assert.ok(!('exfil_9f3a' in r.impact.tables) && !JSON.stringify(r).includes('exfil_9f3a') && !JSON.stringify(r).includes('zz_leaked_value'))
    assert.equal(r.impact.unnamed_new_objects, 2)
    // Without the SQL text no new name is shown at all.
    assert.equal(explainReport(report, { used: 1 }).impact.schema_delta.added_columns.length, 0)
  })

  it('property: DENIED exactly when the verdict is not SAFE, and every denial names at least one constraint', () => {
    const rows = fc.integer({ min: 0, max: 50 })
    fc.assert(
      fc.property(rows, rows, rows, rows, fc.boolean(), (ob, oa, pb, pa, failStep) => {
        const steps = [{ id: 'm1', status: failStep ? 'failed' : 'ok', detail: failStep ? 'boom' : '' }]
        const r = explainReport(reportOf({ orders: ob, patches: pb }, { orders: oa, patches: pa }, steps), { used: 1 })
        const denied = r.status === 'DENIED'
        return denied === (r.verdict !== 'SAFE') && (!denied || r.remediation.constraints.length > 0) && (denied || r.remediation === null)
      })
    )
  })
})
