/**
 * Selection gate for authorization (T17 follow-up, operator decision of 17 Nov).
 *
 * Runs after the fidelity check, so baseHash is the current state of the target and
 * equals the base of the report being authorized. Only receipts for that base count.
 *
 * Valid selection for this base (latest plan_selected with this base_hash):
 *   - its replay must verify (verifySelection), otherwise SELECTION_INVALID;
 *   - it must recommend a plan (NO_PLAN_SELECTED) and that plan must be this one
 *     (PLAN_NOT_SELECTED);
 *   - it must have compared exactly the report being authorized (SELECTION_OUTDATED
 *     when the plan was rehearsed again after the comparison);
 *   - it must cover every plan whose latest rehearsal is on this base, with that
 *     rehearsal's report (SELECTION_INCOMPLETE): leaving a plan out of the
 *     comparison, or rehearsing a new plan afterwards, cannot change the outcome.
 * No selection for this base:
 *   - one plan rehearsed on this base: single-rehearsal mode, as before T17;
 *   - several plans rehearsed on this base: COMPARISON_REQUIRED.
 * A selection made on another base is stale: it grants nothing and constrains
 * nothing; the plan must stand on its own rehearsal of the current base.
 */

import { hashValue } from '../util/canonical.js'
import { AuthorizationRefused } from '../authorize/authorization.js'

/** plan_id -> latest rehearsal receipt, for plans whose latest rehearsal is on base. */
export function plansOnBase(receipts, base) {
  const latest = new Map()
  for (const r of receipts) if (r.kind === 'rehearsal' && typeof r.subject?.plan_id === 'string') latest.set(r.subject.plan_id, r)
  return new Map([...latest].filter(([, r]) => r.subject.base_hash === base))
}

/**
 * @param {object} a
 * @param {any[]} a.receipts verified receipt chain
 * @param {string} a.planId plan being authorized
 * @param {string} a.reportHash hash of its stored report
 * @param {string} a.baseHash current base hash (equal to the report's)
 * @param {(receiptHash: string) => { ok: boolean, findings: string[] }} a.replay
 * @returns {{ mode: 'selected' | 'single_rehearsal', receipt: string | null, stale_selection_ignored: boolean }}
 */
export function selectionGate({ receipts, planId, reportHash, baseHash, replay }) {
  const selections = receipts.filter((r) => r.kind === 'plan_selected')
  const current = selections.filter((r) => r.subject?.base_hash === baseHash).at(-1)
  const onBase = plansOnBase(receipts, baseHash)
  if (onBase.get(planId)?.subject?.report_hash !== reportHash) {
    throw new AuthorizationRefused('REHEARSAL_NOT_ON_BASE', 'the latest rehearsal of this plan is not this report on the current state')
  }

  if (!current) {
    if (onBase.size > 1) {
      throw new AuthorizationRefused('COMPARISON_REQUIRED', `${onBase.size} plans were rehearsed on this state; compare them before authorizing one`, { plans: [...onBase.keys()].sort() })
    }
    return { mode: 'single_rehearsal', receipt: null, stale_selection_ignored: selections.length > 0 }
  }

  const receipt = hashValue(current)
  const check = replay(receipt)
  if (!check.ok) throw new AuthorizationRefused('SELECTION_INVALID', 'the plan selection for this state does not replay', check.findings)
  const sel = current.subject
  if (sel.recommended === null) throw new AuthorizationRefused('NO_PLAN_SELECTED', 'the comparison for this state recommended no plan', sel.removed)
  if (sel.recommended !== planId) throw new AuthorizationRefused('PLAN_NOT_SELECTED', `the comparison for this state selected ${sel.recommended}, not ${planId}`)
  const compared = new Map(sel.compared.map((c) => [c.plan_id, c.report_hash]))
  if (compared.get(planId) !== reportHash) throw new AuthorizationRefused('SELECTION_OUTDATED', 'this plan was rehearsed again after the comparison; compare again')
  const missing = [...onBase].filter(([id, r]) => compared.get(id) !== r.subject.report_hash).map(([id]) => id).sort()
  if (missing.length > 0) throw new AuthorizationRefused('SELECTION_INCOMPLETE', 'plans rehearsed on this state are missing from the comparison, or changed since; compare again', { plans: missing })
  return { mode: 'selected', receipt, stale_selection_ignored: false }
}
