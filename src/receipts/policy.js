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
 *   4. verification refers to the undo receipt right before it.
 * Each break is a POLICY_VIOLATION finding naming the receipt and the rule.
 */

import { receiptHash } from './chain.js'

export function checkPolicy(receipts) {
  const findings = []
  const bySeqHash = new Map()
  const usedAuthorizations = new Set()
  let lastOperatorReceipt = null
  const violation = (r, rule) => findings.push({ seq: r.seq, kind: 'POLICY_VIOLATION', rule, problem: `${r.kind}: ${rule}` })
  const earlier = (ref) => (ref ? bySeqHash.get(ref) : undefined)

  for (const r of receipts) {
    if (r.kind === 'authorization_issued') {
      const reh = earlier(r.refs?.rehearsal)
      if (!reh || reh.kind !== 'rehearsal') violation(r, 'must refer to an earlier rehearsal receipt')
      else if (reh.verdict !== 'SAFE') violation(r, `refers to a rehearsal with verdict ${reh.verdict}`)
      else if (reh.subject?.plan_id !== r.subject?.plan_id) violation(r, 'refers to a rehearsal of another plan')
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
    if (r.kind === 'verification') {
      const undo = earlier(r.refs?.undo)
      if (!undo || undo.kind !== 'undo') violation(r, 'must refer to an undo receipt')
      // Hook decisions from parallel agent tool calls may land in between; nothing else may.
      else if (undo !== lastOperatorReceipt) violation(r, 'must directly follow the undo it verifies')
    }
    bySeqHash.set(receiptHash(r), r)
    if (r.kind !== 'hook_decision') lastOperatorReceipt = r
  }
  return { ok: findings.length === 0, findings }
}
