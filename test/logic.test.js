/**
 * T25.1: database logic (triggers, rules, functions) in the measurement, the verdict,
 * the agent's feedback, the contract and the post-run comparison.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { logicDelta } from '../src/rehearsal/measure.js'
import { buildImpact } from '../src/rehearsal/impact.js'
import { explainReport } from '../src/explain/remediation.js'
import { compareOutcome } from '../src/run/outcome.js'
import { validateContract } from '../src/contract/schema.js'
import { EXIT, verdictExit } from '../src/cli/codes.js'

const TRIGGER = 'public.patches.patches_release_sold_out'
const FUNCTION = 'public.release_sold_out_patch()'
const logic = (t = 'md5:a', f = 'md5:b') => ({ triggers: t === null ? {} : { [TRIGGER]: t }, functions: f === null ? {} : { [FUNCTION]: f }, rules: {} })
const db = (rows, l) => ({ schema_hash: 'sha256:s', columns: { orders: ['id integer not null'] }, tables: { orders: { rows, checksum: String(rows) } }, logic: l })
const impact = (before, after, allowed) => buildImpact({ before, after, protectedTables: ['orders'], steps: [{ id: 'm1', status: 'ok' }], allowedLogicChanges: allowed })

describe('database logic (T25.1)', () => {
  it('logicDelta names removed, redefined and added objects; equal logic has no delta', () => {
    assert.deepEqual(logicDelta(logic(), logic()), { removed: [], changed: [], added: [] })
    assert.deepEqual(logicDelta(logic(), logic(null)), { removed: [`trigger ${TRIGGER}`], changed: [], added: [] })
    assert.deepEqual(logicDelta(logic(), logic('md5:a', 'md5:c')), { removed: [], changed: [`function ${FUNCTION}`], added: [] })
    assert.deepEqual(logicDelta(logic(null), logic()), { removed: [], changed: [], added: [`trigger ${TRIGGER}`] })
  })

  it('removing or redefining existing logic is LOGIC CHANGE; the contract can allow a named object; data loss still wins', () => {
    const removed = impact(db(3, logic()), db(3, logic(null)))
    assert.deepEqual([removed.verdict, removed.evidence, removed.schema_delta.removed_logic, removed.schema_delta.changed], ['LOGIC CHANGE', [{ kind: 'logic_removed', object: `trigger ${TRIGGER}` }], [`trigger ${TRIGGER}`], true])
    const redefined = impact(db(3, logic()), db(3, logic('md5:a', 'md5:z')))
    assert.deepEqual([redefined.verdict, redefined.evidence[0].kind, redefined.schema_delta.changed_logic], ['LOGIC CHANGE', 'logic_changed', [`function ${FUNCTION}`]])
    assert.equal(impact(db(3, logic()), db(3, logic(null)), [`trigger ${TRIGGER}`]).verdict, 'SAFE')
    assert.equal(impact(db(3, logic()), db(2, logic(null))).verdict, 'DATA LOSS')
    const added = impact(db(3, logic(null)), db(3, logic()))
    assert.deepEqual([added.verdict, added.schema_delta.added_logic], ['SAFE', [`trigger ${TRIGGER}`]])
    assert.equal(impact(db(3, logic()), db(3, logic())).verdict, 'SAFE')
  })

  it('the agent is told which existing object must be kept, and the CLI exit code names the verdict', () => {
    const r = impact(db(3, logic()), db(3, logic(null)))
    const shown = explainReport({ plan_id: 'plan-0123456789ab', base_hash: 'sha256:b', ...r, steps: [] }, { used: 1 }, { sqlText: 'drop trigger patches_release_sold_out on patches' })
    assert.deepEqual([shown.status, shown.reason, shown.next_action], ['DENIED', 'LOGIC_CHANGE', 'REVISE_AND_REHEARSE'])
    assert.deepEqual(shown.remediation.constraints.map((c) => [c.kind, c.object]), [['logic_preserved', `trigger ${TRIGGER}`]])
    assert.equal(verdictExit('LOGIC CHANGE'), EXIT.LOGIC_CHANGE)
    // A new object is named to the agent only if its own SQL names it.
    const added = impact(db(3, logic(null)), db(3, logic()))
    assert.deepEqual(explainReport({ plan_id: 'plan-0123456789ab', ...added, steps: [] }, { used: 1 }, { sqlText: 'select 1' }).impact.schema_delta.added_logic, [])
  })

  it('allowed_logic_changes in the contract accepts only named triggers, rules and functions', () => {
    const base = { id: 'mission-x', objective: 'x', allowed_paths: ['demo/'], protected_tables: [], time_limit_seconds: 60, irreversible_actions: [], plan: [{ id: 'a', tool: 'sql_migration', args: ['demo/a.sql'], reversibility: true }], resources: { databases: [], config_files: [], compose_services: [] } }
    assert.deepEqual(validateContract({ ...base, allowed_logic_changes: [`trigger ${TRIGGER}`, `function ${FUNCTION}`, 'rule public.orders.r1'] }), [])
    for (const bad of ['trigger *', 'everything', `trigger ${TRIGGER} x`, 'function f']) {
      assert.ok(validateContract({ ...base, allowed_logic_changes: [bad] }).some((e) => e.field === 'allowed_logic_changes[0]'), bad)
    }
  })

  it('a real run whose database logic differs from the rehearsal does not match it', () => {
    assert.equal(compareOutcome(db(3, logic()), db(3, logic())).matches, true)
    const d = compareOutcome(db(3, logic()), db(3, logic('md5:x')))
    assert.deepEqual([d.matches, d.differences[0].what], [false, 'database logic (triggers, rules, functions) differs from the rehearsal'])
  })
})
