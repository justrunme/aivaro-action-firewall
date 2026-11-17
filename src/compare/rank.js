/**
 * Deterministic plan ranking (R15.3 to R15.5). Pure function of measured values.
 *
 * Rules, applied in this order to the plans still in the pool:
 *   R15.4.1 verdict      remove every plan whose verdict is not SAFE (DATA LOSS or
 *                        FAILED; FAILED is removed too: a plan that did not complete
 *                        has no measured outcome to recommend)
 *   R15.4.2 tests        remove plans with failing tests (skipped, and said so, when
 *                        no plan had its tests measured)
 *   R15.4.3 reversible   remove plans with irreversible actions, unless every plan
 *                        still in the pool has them
 *   R15.4.4 duration     keep the lowest measured rehearsal duration
 *   R15.4.5 plan_id      on equal duration, keep the smallest plan_id (code-unit
 *                        order, not locale order, so every machine agrees)
 * The first rule after which one plan remains decides. If the pool becomes empty,
 * nothing is recommended and every plan names the rule that removed it.
 * Input order never matters: rows are sorted by plan_id first.
 */

export const RULES = [
  { id: 'R15.4.1', name: 'verdict' },
  { id: 'R15.4.2', name: 'failing_tests' },
  { id: 'R15.4.3', name: 'irreversible_actions' },
  { id: 'R15.4.4', name: 'duration' },
  { id: 'R15.4.5', name: 'plan_id_tiebreak' },
]

const byPlanId = (a, b) => (a.plan_id < b.plan_id ? -1 : a.plan_id > b.plan_id ? 1 : 0)

/**
 * Measured values of one stored, verified rehearsal report (R15.3). Nothing estimated.
 * @returns {{ plan_id: string, verdict: string, rows_lost: Record<string, number | null>, failing_tests: number | null, duration_ms: number, all_reversible: boolean, irreversible_actions: string[] }}
 */
export function measuredRow(report) {
  const rowsLost = {}
  for (const t of report.conditions.protected_tables) {
    const row = report.tables?.[t]
    rowsLost[t] = row ? row.rows_lost : null // null: not measured (rehearsal failed before measuring)
  }
  return {
    plan_id: report.plan_id,
    verdict: report.verdict,
    rows_lost: rowsLost,
    failing_tests: report.conditions.tests_measured ? report.failing_tests : null,
    duration_ms: report.duration_ms,
    all_reversible: report.all_reversible === true,
    irreversible_actions: [...(report.irreversible_actions ?? [])].sort(),
  }
}

/**
 * @param {ReturnType<typeof measuredRow>[]} input
 * @returns {{ recommended: string | null, decided_by: string, removed: { plan_id: string, rule: string, reason: string }[], rules: { rule: string, name: string, removed: string[], note: string | null }[] }}
 */
export function rankPlans(input) {
  if (!Array.isArray(input) || input.length < 2) throw new Error('ranking needs at least two plans')
  const measured = input.filter((r) => r.failing_tests !== null).length
  if (measured !== 0 && measured !== input.length) throw new Error('failing tests measured for some plans only; not comparable')

  let pool = [...input].sort(byPlanId)
  const removed = []
  const rules = []
  let decidedBy = null

  const apply = (index, keep, reasonOf, note = null) => {
    const rule = RULES[index]
    const out = pool.filter((r) => !keep(r))
    for (const r of out) removed.push({ plan_id: r.plan_id, rule: rule.id, reason: reasonOf(r) })
    pool = pool.filter(keep)
    rules.push({ rule: rule.id, name: rule.name, removed: out.map((r) => r.plan_id), note })
    if (decidedBy === null && pool.length <= 1) decidedBy = rule.id
  }

  const steps = [
    () => apply(0, (r) => r.verdict === 'SAFE', (r) => `verdict ${r.verdict}`),
    () =>
      measured === 0
        ? apply(1, () => true, () => '', 'not applied: no plan had its tests measured')
        : apply(1, (r) => r.failing_tests === 0, (r) => `${r.failing_tests} failing tests`),
    () =>
      pool.every((r) => !r.all_reversible)
        ? apply(2, () => true, () => '', 'not applied: every remaining plan has irreversible actions')
        : apply(2, (r) => r.all_reversible, (r) => `irreversible actions: ${r.irreversible_actions.join(', ')}`),
    () => {
      const best = Math.min(...pool.map((r) => r.duration_ms))
      apply(3, (r) => r.duration_ms === best, (r) => `duration ${r.duration_ms} ms > ${best} ms`)
    },
    () => {
      const first = pool[0].plan_id
      apply(4, (r) => r.plan_id === first, (r) => `same duration, plan_id sorts after ${first}`)
    },
  ]
  for (const step of steps) {
    if (decidedBy !== null) break
    step()
  }
  return { recommended: pool.length === 1 ? pool[0].plan_id : null, decided_by: decidedBy, removed, rules }
}
