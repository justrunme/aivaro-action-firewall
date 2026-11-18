/**
 * T25 v2 Step 3: typed requirements, contradiction detection and the SQL JustRunMe
 * builds for them (no Docker; test/demo-requirements.test.js runs them on Postgres).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CONFLICT_MESSAGE, checkRequirements, findConflict, potentialConflicts, validateRequirements } from '../src/mission/requirements.js'
import { buildImpact } from '../src/rehearsal/impact.js'
import { explainReport } from '../src/explain/remediation.js'
import { EXIT, verdictExit } from '../src/cli/codes.js'
import { TASK_A_REQUIREMENTS, TASK_B_REQUIREMENTS, missionOf } from '../scripts/scenarios/t25v2.js'
import { validateContract } from '../src/contract/schema.js'

const db = { schema_hash: 's', columns: {}, tables: {}, logic: {} }

describe('mission requirements (T25 v2 Step 3)', () => {
  it('the Task A and Task B missions validate; malformed requirements do not', () => {
    assert.deepEqual(validateContract(missionOf('A')), [])
    assert.deepEqual(validateContract(missionOf('B')), [])
    const bad = [
      [{ required_changes: [{ table: 'Patches; DROP', where: { id: 1 }, set: { a: 0 } }] }, 'required_changes[0].table'],
      [{ required_changes: [{ table: 'patches', where: {}, set: { a: 0 } }] }, 'required_changes[0].where'],
      [{ required_changes: [{ table: 'patches', where: { id: { $gt: 1 } }, set: { a: 0 } }] }, 'required_changes[0].where.id'],
      [{ invariants: [{ kind: 'sql', query: 'SELECT 1' }] }, 'invariants[0].kind'],
      [{ invariants: [{ kind: 'keep', table: 'orders', where: { patch_id: 1 }, column: 'status', equals: 'open', extra: 1 }] }, 'invariants[0].extra'],
    ]
    for (const [doc, field] of bad) assert.ok(validateRequirements(doc).some((e) => e.field === field), field)
  })

  it('Task B is a potential conflict; Task A is not', () => {
    assert.deepEqual(potentialConflicts(TASK_A_REQUIREMENTS), [])
    const c = potentialConflicts(TASK_B_REQUIREMENTS)
    assert.equal(c.length, 1)
    assert.match(c[0].why, /cancelled/)
    assert.equal(c[0].rows_sql, 'SELECT count(*) FROM "orders" t JOIN "patches" w ON w."id" = t."patch_id" WHERE w."id" = 1 AND t."patch_id" = 1')
  })

  it('a conflict needs existing rows: CONFLICT only when the database has them', async () => {
    const exec = (n) => async () => ({ code: 0, stdout: `${n}\n`, stderr: '' })
    assert.deepEqual(await findConflict(TASK_B_REQUIREMENTS, exec(1)), { message: CONFLICT_MESSAGE, conflicts: [{ why: potentialConflicts(TASK_B_REQUIREMENTS)[0].why, rows: 1 }] })
    assert.equal(await findConflict(TASK_B_REQUIREMENTS, exec(0)), null)
    assert.equal(await findConflict(TASK_A_REQUIREMENTS, exec(1)), null)
    assert.equal(CONFLICT_MESSAGE, 'CONFLICT: requirements unsatisfiable')
  })

  it('values are literals, never SQL', async () => {
    const seen = []
    const exec = async (sql) => (seen.push(sql), { code: 0, stdout: '0,0\n', stderr: '' })
    await checkRequirements({ required_changes: [{ table: 'patches', where: { name: "x'; DROP TABLE orders; --" }, set: { available_count: 0 } }], invariants: [] }, exec)
    assert.ok(seen[0].includes("'x''; DROP TABLE orders; --'"), seen[0])
  })

  it('verdicts: INVARIANT VIOLATED before REQUIREMENT UNMET, both after the data and logic checks', () => {
    const steps = []
    const v = buildImpact({ before: db, after: db, protectedTables: [], steps, requirements: { violated: [{ kind: 'invariant_violated', index: 0, invariant: 'implies', text: 't', rows: 1 }], unmet: [{ kind: 'requirement_unmet', index: 0, table: 'patches', where: { id: 1 }, set: { available_count: 0 }, rows: 1, done: 0 }] } })
    assert.equal(v.verdict, 'INVARIANT VIOLATED')
    const u = buildImpact({ before: db, after: db, protectedTables: [], steps, requirements: { violated: [], unmet: [{ kind: 'requirement_unmet', index: 0, table: 'patches', where: { id: 1 }, set: { available_count: 0 }, rows: 1, done: 0 }] } })
    assert.equal(u.verdict, 'REQUIREMENT UNMET')
    const shown = explainReport({ plan_id: 'plan-0123456789ab', ...u, steps }, { used: 1 })
    assert.deepEqual([shown.status, shown.reason, shown.next_action, shown.remediation.constraints[0].kind], ['DENIED', 'REQUIREMENT_UNMET', 'REVISE_AND_REHEARSE', 'requirement_met'])
    assert.equal(verdictExit('INVARIANT VIOLATED'), EXIT.INVARIANT_VIOLATED)
    assert.equal(EXIT.CONFLICT, 32)
  })
})
