/**
 * What an agent is told about a rehearsal (T22, R2.7): a machine-readable
 * outcome built only from the signed report, so every number in it was measured
 * in the disposable database copy.
 *
 * Wording policy. The constraints name what was measured and what any revised
 * plan has to leave intact. They are requirements, not a diagnosis of the SQL and
 * not a promise: whether a revised plan is safe is known only after it has been
 * rehearsed again. Nothing here says that a plan "will be" safe.
 */

export const ATTEMPT_LIMIT = 8

const NEXT = Object.freeze({
  SAFE: 'REQUEST_APPROVAL',
  'DATA LOSS': 'REVISE_AND_REHEARSE',
  FAILED: 'FIX_AND_REHEARSE',
  LIMIT: 'ASK_OPERATOR',
})

function constraintsFor(evidence, failedSteps) {
  const out = []
  for (const e of evidence) {
    if (e.kind === 'protected_rows_lost') {
      out.push({ kind: 'rows_preserved', table: e.table, measured: { rows_before: e.rows_before, rows_after: e.rows_after }, text: `Every existing row of ${e.table} must still exist after the plan (measured ${e.rows_before} rows before, ${e.rows_after} after).` })
    } else if (e.kind === 'table_removed') {
      out.push({ kind: 'table_preserved', table: e.table, measured: { rows_before: e.rows_before }, text: `Table ${e.table} must still exist after the plan (it had ${e.rows_before} rows and was gone afterwards).` })
    } else if (e.kind === 'column_removed') {
      out.push({ kind: 'column_preserved', column: e.column, measured: {}, text: `Column ${e.column} must still exist after the plan.` })
    } else if (e.kind === 'rehearsal_error') {
      out.push({ kind: 'rehearsal_must_complete', measured: {}, text: 'The rehearsal itself did not complete; the plan could not be measured.' })
    }
  }
  for (const s of failedSteps) out.push({ kind: 'step_must_succeed', step: s.id, measured: { status: s.status }, text: `Step ${s.id} did not complete (${s.status}${s.detail ? `: ${s.detail}` : ''}); fix it so that it applies without error.` })
  return out
}

// What leaves the rehearsal copy for the agent is narrowed (the copy holds real data and
// the agent wrote the SQL that runs in it): error text is cut to its first line, and the
// name of an object the plan created is shown only if the plan's own SQL text contains it.
// A name built from data at run time (dynamic SQL) is counted, not shown. This narrows
// the channels; it does not close them (README, limits).
const MAX_DETAIL = 160
const firstLine = (s) => String(s ?? '').split('\n')[0].slice(0, MAX_DETAIL)

/**
 * @param {any} report signed rehearsal report (already verified by the caller)
 * @param {{ used: number, limit?: number }} attempts rehearsals since the last run or authorization
 * @param {{ sqlText?: string | null }} [view] text of the plan's SQL files; null means show no new names
 */
export function explainReport(report, attempts, { sqlText = null } = {}) {
  const limit = attempts.limit ?? ATTEMPT_LIMIT
  const exhausted = attempts.used >= limit && report.verdict !== 'SAFE'
  const haystack = String(sqlText ?? '').toLowerCase()
  const literal = (name) => haystack.includes(String(name).toLowerCase())
  const hidden = new Set()
  const entries = Object.entries(report.tables ?? {}).filter(([t, v]) => {
    const isNew = v.rows_before === null
    if (isNew && !literal(t)) {
      hidden.add(t)
      return false
    }
    return true
  })
  const tables = Object.fromEntries(entries.map(([t, v]) => [t, { protected: v.protected, rows_before: v.rows_before, rows_after: v.rows_after, rows_lost: v.rows_lost, content_changed: v.content_changed }]))
  const shown = (list) => (list ?? []).filter((name) => {
    const ok = literal(String(name).split('.').pop())
    if (!ok) hidden.add(String(name))
    return ok
  })
  const schemaDelta = report.schema_delta ? { ...report.schema_delta, added_tables: shown(report.schema_delta.added_tables), added_columns: shown(report.schema_delta.added_columns) } : null
  const evidence = (report.evidence ?? []).map((e) => (e.detail === undefined ? e : { ...e, detail: firstLine(e.detail) }))
  const failedSteps = (report.steps ?? []).filter((s) => s.status !== 'ok').map((s) => ({ id: s.id, status: s.status, detail: firstLine(s.detail) }))
  const safe = report.verdict === 'SAFE'
  return {
    status: safe ? 'SAFE' : 'DENIED',
    verdict: report.verdict,
    reason: safe ? null : report.verdict === 'DATA LOSS' ? 'DATA_LOSS' : 'REHEARSAL_FAILED',
    rule: safe ? null : report.verdict === 'DATA LOSS' ? 'R2.6' : 'R2.5',
    plan_id: report.plan_id,
    base_hash: report.base_hash,
    measured_in: 'a disposable copy of the database, started for this rehearsal and removed afterwards',
    impact: {
      rows_lost: Object.fromEntries(Object.entries(tables).filter(([, v]) => v.protected).map(([t, v]) => [t, v.rows_lost])),
      tables,
      schema_delta: schemaDelta,
      evidence,
      failed_steps: failedSteps,
      unnamed_new_objects: hidden.size,
    },
    remediation: safe
      ? null
      : {
          aim: report.verdict === 'DATA LOSS' ? 'Revise the plan so that it destroys no data, then rehearse the revision.' : 'Make the plan apply cleanly, then rehearse it again.',
          constraints: constraintsFor(evidence, failedSteps),
          next_action: exhausted ? NEXT.LIMIT : NEXT[report.verdict] ?? NEXT.FAILED,
          caution: 'These are measurements of the plan just rehearsed, not a proof that a revised plan is safe. Only a new rehearsal with verdict SAFE shows that.',
        },
    next_action: exhausted ? NEXT.LIMIT : NEXT[report.verdict] ?? NEXT.FAILED,
    attempts: { used: attempts.used, limit },
  }
}
