/**
 * Impact report and verdict from measured before/after database state (R2.3, R2.6, R6.2).
 *
 * Pure function of the measurements. Verdict rules, in order:
 *   FAILED     a rehearsed step did not complete
 *   DATA LOSS  a table or a column disappeared, or a protected table lost rows
 *   LOGIC CHANGE  after the plan, an existing trigger, rule or function is gone, redefined,
 *                 or (a trigger) left switched off, and the contract's allowed_logic_changes
 *                 does not name it. A trigger switched off and on again inside the plan, or
 *                 skipped with session_replication_role, leaves no trace here (measure.js).
 *   SAFE       otherwise
 */

import { logicDelta } from './measure.js'

/**
 * @param {object} a
 * @param {{ tables: Record<string, {rows: number, checksum: string}>, columns: Record<string, string[]>, schema_hash: string }} a.before
 * @param {typeof a.before} a.after
 * @param {string[]} a.protectedTables
 * @param {{ id: string, status: string }[]} a.steps
 * @param {{ max_rows_deleted?: number }} [a.thresholds]
 * @param {string[]} [a.allowedLogicChanges] entries like "trigger public.patches.name" the operator allows to change
 */
export function buildImpact({ before, after, protectedTables, steps, thresholds = {}, allowedLogicChanges = [] }) {
  const names = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort()
  const tables = {}
  const removedTables = []
  const addedTables = []
  const removedColumns = []
  const addedColumns = []
  let rowsDeleted = 0

  for (const t of names) {
    const b = before.tables[t]
    const a = after.tables[t]
    if (b && !a) removedTables.push(t)
    if (!b && a) addedTables.push(t)
    const rowsBefore = b ? b.rows : 0
    const rowsAfter = a ? a.rows : 0
    const lost = Math.max(0, rowsBefore - rowsAfter)
    rowsDeleted += lost
    tables[t] = {
      rows_before: b ? b.rows : null,
      rows_after: a ? a.rows : null,
      rows_lost: lost,
      content_changed: Boolean(b && a && b.checksum !== a.checksum),
      protected: protectedTables.includes(t),
    }
    const colName = (c) => c.split(' ')[0]
    const bc = (before.columns[t] ?? []).map(colName)
    const ac = (after.columns[t] ?? []).map(colName)
    if (b && a) {
      for (const c of bc) if (!ac.includes(c)) removedColumns.push(`${t}.${c}`)
      for (const c of ac) if (!bc.includes(c)) addedColumns.push(`${t}.${c}`)
    }
  }

  const evidence = []
  for (const t of removedTables) evidence.push({ kind: 'table_removed', table: t, rows_before: before.tables[t].rows })
  for (const c of removedColumns) evidence.push({ kind: 'column_removed', column: c })
  for (const t of protectedTables) {
    const row = tables[t]
    if (row && row.rows_lost > 0 && !removedTables.includes(t)) {
      evidence.push({ kind: 'protected_rows_lost', table: t, rows_before: row.rows_before, rows_after: row.rows_after })
    }
  }
  // T25: existing database logic (triggers, rules, functions) removed or redefined. A
  // plan that avoids a loss by switching off the logic that caused it has changed what
  // the database does; it is denied unless the operator's contract names the object.
  const logic = logicDelta(before.logic, after.logic)
  const logicEvidence = []
  for (const [kind, list] of [['logic_removed', logic.removed], ['logic_changed', logic.changed]]) {
    for (const object of list) if (!allowedLogicChanges.includes(object)) logicEvidence.push({ kind, object })
  }
  const failed = steps.filter((s) => s.status !== 'ok')
  const verdict = failed.length > 0 ? 'FAILED' : evidence.length > 0 ? 'DATA LOSS' : logicEvidence.length > 0 ? 'LOGIC CHANGE' : 'SAFE'
  evidence.push(...logicEvidence)

  const threshold_breaches = []
  if (Number.isInteger(thresholds.max_rows_deleted) && rowsDeleted > thresholds.max_rows_deleted) {
    threshold_breaches.push({ threshold: 'max_rows_deleted', limit: thresholds.max_rows_deleted, measured: rowsDeleted })
  }

  return {
    verdict,
    evidence,
    rows_deleted: rowsDeleted,
    tables,
    schema_delta: {
      changed: before.schema_hash !== after.schema_hash || logic.removed.length + logic.changed.length + logic.added.length > 0,
      added_tables: addedTables,
      removed_tables: removedTables,
      added_columns: addedColumns,
      removed_columns: removedColumns,
      removed_logic: logic.removed,
      changed_logic: logic.changed,
      added_logic: logic.added,
    },
    failed_steps: failed.map((s) => s.id),
    threshold_breaches,
  }
}
