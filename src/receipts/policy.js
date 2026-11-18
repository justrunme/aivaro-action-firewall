/**
 * Ordering rules over a verified receipt chain (R8.3 groundwork).
 *
 * A chain can be perfectly signed and still describe a sequence that should not
 * have happened. These rules check the story, not the bytes:
 *   1. authorization_issued refers to an earlier rehearsal receipt with verdict
 *      SAFE for the same plan;
 *   2. run_result refers to an earlier authorization_issued receipt, and each
 *      authorization is used by at most one run;
 *   3. undo refers to an earlier run_result with the same capture;
 *   4. verification refers to the undo receipt right before it;
 *   5. plan_selected refers to an earlier rehearsal receipt for every compared
 *      plan, with the same report and base, and never recommends a plan whose
 *      rehearsal was not SAFE;
 *   6. authorization_issued applies the latest plan_selected for its base and
 *      authorizes the selected plan; without a selection only one plan may have
 *      been rehearsed on that base (single-rehearsal mode).
 *   7. approval_requested refers to an earlier SAFE rehearsal of the same plan
 *      and report and expires within an hour; approval_denied refers to an
 *      earlier request of the same plan that nothing answered yet; an
 *      authorization that answers a request (refs.approval) answers a request of
 *      the same plan, rehearsal and report, only once, never after a denial, and
 *      not after the request expired.
 * Each break is a POLICY_VIOLATION finding naming the receipt and the rule.
 */

import { receiptHash } from './chain.js'

// Receipts that are not part of the mission story: parallel hook decisions and
// operator maintenance of the chain itself. They may land between undo and verification.
const CHAIN_MAINTENANCE = new Set(['hook_decision', 'chain_reanchored', 'lock_recovered'])
// Longest life of an approval request (REQUEST_TTL_SECONDS in src/approval/requests.js; not imported, to keep receipts free of approval code).
const MAX_REQUEST_SECONDS = 3600

export function checkPolicy(receipts) {
  const findings = []
  const bySeqHash = new Map()
  const usedAuthorizations = new Set()
  const latestRehearsal = new Map() // plan_id -> latest rehearsal receipt so far
  const latestSelection = new Map() // base_hash -> latest plan_selected so far
  const answeredRequests = new Set() // approval_requested hashes already answered by an authorization
  const deniedRequests = new Set()
  let lastOperatorReceipt = null
  const violation = (r, rule) => findings.push({ seq: r.seq, kind: 'POLICY_VIOLATION', rule, problem: `${r.kind}: ${rule}` })
  const earlier = (ref) => (ref ? bySeqHash.get(ref) : undefined)

  for (const r of receipts) {
    if (r.kind === 'approval_requested') {
      const reh = earlier(r.refs?.rehearsal)
      const lifetime = (Date.parse(r.subject?.expires_at) - Date.parse(r.timestamp)) / 1000
      if (!reh || reh.kind !== 'rehearsal') violation(r, 'must refer to an earlier rehearsal receipt')
      else if (reh.verdict !== 'SAFE') violation(r, `asked for approval of a rehearsal with verdict ${reh.verdict}`)
      else if (reh.subject?.plan_id !== r.subject?.plan_id) violation(r, 'refers to a rehearsal of another plan')
      else if (reh.subject?.report_hash !== r.subject?.report_hash) violation(r, 'asks about a report other than the rehearsed one')
      if (!(lifetime > 0 && lifetime <= MAX_REQUEST_SECONDS)) violation(r, `a request must expire within ${MAX_REQUEST_SECONDS} s of being made`)
    }
    if (r.kind === 'approval_denied') {
      const req = earlier(r.refs?.approval)
      if (!req || req.kind !== 'approval_requested') violation(r, 'must refer to an earlier approval_requested receipt')
      else if (r.subject?.plan_id !== undefined && r.subject.plan_id !== req.subject?.plan_id) violation(r, 'denied a request naming another plan')
      else if (answeredRequests.has(r.refs.approval)) violation(r, 'denied a request that an authorization already answered')
      else if (deniedRequests.has(r.refs.approval)) violation(r, 'approval request was already denied')
      if (req) deniedRequests.add(r.refs.approval)
    }
    if (r.kind === 'authorization_issued' && r.refs?.approval) {
      const req = earlier(r.refs.approval)
      if (!req || req.kind !== 'approval_requested') violation(r, 'must refer to an earlier approval_requested receipt')
      else if (req.subject?.plan_id !== r.subject?.plan_id) violation(r, 'answered a request for another plan')
      else if (req.refs?.rehearsal !== r.refs?.rehearsal) violation(r, 'answered a request about another rehearsal')
      else if (r.subject?.report_hash !== undefined && r.subject.report_hash !== req.subject?.report_hash) violation(r, 'answered a request about another report')
      else if (answeredRequests.has(r.refs.approval)) violation(r, 'approval request was already answered by another authorization')
      else if (deniedRequests.has(r.refs.approval)) violation(r, 'authorized a plan whose approval request was denied')
      else if (Date.parse(r.timestamp) > Date.parse(req.subject?.expires_at)) violation(r, 'answered an approval request after it expired')
      if (req) answeredRequests.add(r.refs.approval)
    }
    if (r.kind === 'authorization_issued') {
      const reh = earlier(r.refs?.rehearsal)
      if (!reh || reh.kind !== 'rehearsal') violation(r, 'must refer to an earlier rehearsal receipt')
      else if (reh.verdict !== 'SAFE') violation(r, `refers to a rehearsal with verdict ${reh.verdict}`)
      else if (reh.subject?.plan_id !== r.subject?.plan_id) violation(r, 'refers to a rehearsal of another plan')
      // T17 selection binding, checked from the chain alone.
      const base = reh?.subject?.base_hash
      if (r.refs?.selection) {
        const s = earlier(r.refs.selection)
        if (!s || s.kind !== 'plan_selected') violation(r, 'must refer to an earlier plan_selected receipt')
        else if (s.subject?.recommended !== r.subject?.plan_id) violation(r, 'authorized a plan other than the selected one')
        else if (s.subject?.base_hash !== base) violation(r, 'applied a selection made on another base')
        else if (s !== latestSelection.get(base)) violation(r, 'applied a selection that a later comparison replaced')
        else {
          const compared = new Map((s.subject?.compared ?? []).map((c) => [c.plan_id, c.report_hash]))
          const uncovered = [...latestRehearsal.values()].filter((x) => x.subject?.base_hash === base && compared.get(x.subject.plan_id) !== x.subject.report_hash)
          if (uncovered.length > 0) violation(r, 'applied a selection that does not cover every plan rehearsed on this base')
        }
      } else if (typeof base === 'string') {
        if (latestSelection.has(base)) violation(r, 'a plan selection exists for this base but was not applied')
        else if ([...latestRehearsal.values()].filter((x) => x.subject?.base_hash === base).length > 1) violation(r, 'several plans were rehearsed on this base, but none was selected')
      }
    }
    if (r.kind === 'run_result') {
      const ref = r.refs?.authorization
      const auth = earlier(ref)
      if (!auth || auth.kind !== 'authorization_issued') violation(r, 'must refer to an earlier authorization_issued receipt')
      else if (usedAuthorizations.has(ref)) violation(r, 'authorization was already used by another run')
      else if (auth.subject?.plan_id !== r.subject?.plan_id) violation(r, 'ran a different plan than the one authorized')
      if (ref) usedAuthorizations.add(ref)
    }
    if (r.kind === 'undo') {
      const run = earlier(r.refs?.run)
      if (!run || run.kind !== 'run_result') violation(r, 'must refer to an earlier run_result receipt')
      else if (run.subject?.capture_id !== r.subject?.capture_id) violation(r, 'undid a capture other than the run\'s')
    }
    if (r.kind === 'plan_selected') {
      const compared = Array.isArray(r.subject?.compared) ? r.subject.compared : []
      if (compared.length < 2) violation(r, 'must compare at least two plans')
      for (const c of compared) {
        const reh = earlier(r.refs?.[`rehearsal:${c.plan_id}`])
        if (!reh || reh.kind !== 'rehearsal' || reh.subject?.plan_id !== c.plan_id) violation(r, `must refer to an earlier rehearsal receipt of ${c.plan_id}`)
        else if (reh.subject?.report_hash !== c.report_hash) violation(r, `compared a report of ${c.plan_id} other than the rehearsed one`)
        else if (reh.subject?.base_hash !== r.subject?.base_hash) violation(r, `${c.plan_id} was rehearsed on another base`)
        else if (c.plan_id === r.subject?.recommended && reh.verdict !== 'SAFE') violation(r, `recommends ${c.plan_id} whose rehearsal verdict is ${reh.verdict}`)
      }
      if (r.subject?.recommended != null && !compared.some((c) => c.plan_id === r.subject.recommended)) violation(r, 'recommends a plan it did not compare')
    }
    if (r.kind === 'verification') {
      const undo = earlier(r.refs?.undo)
      if (!undo || undo.kind !== 'undo') violation(r, 'must refer to an undo receipt')
      // Hook decisions and chain maintenance may land in between; nothing else may.
      else if (undo !== lastOperatorReceipt) violation(r, 'must directly follow the undo it verifies')
    }
    bySeqHash.set(receiptHash(r), r)
    if (r.kind === 'rehearsal' && typeof r.subject?.plan_id === 'string') latestRehearsal.set(r.subject.plan_id, r)
    if (r.kind === 'plan_selected' && typeof r.subject?.base_hash === 'string') latestSelection.set(r.subject.base_hash, r)
    if (!CHAIN_MAINTENANCE.has(r.kind)) lastOperatorReceipt = r
  }
  return { ok: findings.length === 0, findings }
}
