/**
 * Counterfactual replay: compare stored rehearsals and record a signed choice (R15).
 *
 * comparePlans() loads and checks the reports (compare.js), ranks them with the fixed
 * rule (rank.js), writes a signed comparison file and appends a plan_selected
 * receipt that refers to each rehearsal receipt it used. A refused comparison is
 * recorded as plan_comparison_refused (unless the chain itself does not verify,
 * in which case nothing can be appended).
 *
 * verifySelection() is the replay: it re-checks the comparison file against the
 * receipt, re-binds every compared plan to its signed rehearsal receipt, and runs
 * the ranking again from the signed measured values. Any difference is a finding.
 * No LLM or caller preference takes part: the result is a function of the reports.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson, hashValue } from '../util/canonical.js'
import { STATE_DIR } from '../fidelity/source.js'
import { publicKeyHex, signValue, verifyValue } from '../receipts/keys.js'
import { appendReceipt, findLast, verifyChain } from '../receipts/chain.js'
import { reportPath } from '../rehearsal/engine.js'
import { ComparisonRefused, PLAN_RE, loadComparable } from './compare.js'
import { measuredRow, rankPlans } from './rank.js'

export const comparisonPath = (repoDir, missionId, hash) => path.join(repoDir, STATE_DIR, 'missions', missionId, 'comparisons', `${hash.slice(7, 23)}.json`)

/**
 * @param {{ repoDir: string, keys: { privateKey: any, publicKey: any, home: string }, missionId: string, planIds: string[], now?: number }} a
 */
export function comparePlans({ repoDir, keys, missionId, planIds, now = Date.now() }) {
  let loaded
  try {
    loaded = loadComparable({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId, planIds })
  } catch (err) {
    if (err instanceof ComparisonRefused && err.code !== 'CHAIN_INVALID') {
      const listed = Array.isArray(planIds) && planIds.every((p) => typeof p === 'string' && PLAN_RE.test(p)) ? [...planIds].sort() : null
      try {
        appendReceipt({ repoDir, keys, missionId, kind: 'plan_comparison_refused', verdict: err.code, subject: { plan_ids: listed, code: err.code, problem: err.message }, now })
      } catch {
        // the refusal stands even if it cannot be recorded
      }
    }
    throw err
  }

  const plans = loaded.entries.map((e) => measuredRow(e.report))
  const ranking = rankPlans(plans)
  const body = {
    version: 1,
    mission_id: missionId,
    base_hash: loaded.base_hash,
    conditions: loaded.conditions,
    compared: loaded.entries.map((e) => ({ plan_id: e.plan_id, report_hash: e.report_hash, rehearsal_receipt: e.rehearsal_receipt })),
    plans,
    ranking,
    compared_at: new Date(now).toISOString(),
    operator_pubkey: publicKeyHex(keys.publicKey),
  }
  const signed = { ...body, signature: signValue(keys.privateKey, body) }
  const comparisonHash = hashValue(signed)
  const file = comparisonPath(repoDir, missionId, comparisonHash)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(signed, null, 2) + '\n')

  const refs = Object.fromEntries(loaded.entries.map((e) => [`rehearsal:${e.plan_id}`, e.rehearsal_receipt]))
  const { hash } = appendReceipt({
    repoDir,
    keys,
    missionId,
    kind: 'plan_selected',
    verdict: ranking.recommended ? 'selected' : 'none',
    subject: {
      base_hash: loaded.base_hash,
      comparison_hash: comparisonHash,
      recommended: ranking.recommended,
      decided_by: ranking.decided_by,
      compared: body.compared.map(({ plan_id, report_hash }) => ({ plan_id, report_hash })),
      removed: ranking.removed,
    },
    refs,
    now,
  })
  return { comparison: signed, comparison_hash: comparisonHash, receipt_hash: hash }
}

/**
 * Replay a recorded selection without Docker or production credentials.
 * @returns {{ ok: boolean, findings: string[], recommended?: string | null, decided_by?: string, reports_rechecked?: number }}
 */
export function verifySelection({ repoDir, home, publicKey, missionId, receiptHash = null }) {
  const findings = []
  const chain = verifyChain({ repoDir, home, publicKey, missionId })
  if (!chain.ok) return { ok: false, findings: [`receipt chain does not verify: ${chain.findings[0].problem}`] }
  const found = findLast(chain.receipts, (r) => r.kind === 'plan_selected' && (receiptHash === null || hashValue(r) === receiptHash))
  if (!found) return { ok: false, findings: ['no plan_selected receipt to replay'] }
  const sel = found.receipt.subject

  const file = comparisonPath(repoDir, missionId, sel.comparison_hash)
  if (!existsSync(file)) return { ok: false, findings: ['comparison file is missing'] }
  let cmp
  try {
    cmp = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, findings: ['comparison file is not valid JSON'] }
  }
  if (hashValue(cmp) !== sel.comparison_hash) findings.push('comparison file differs from the one the receipt recorded')
  const { signature, ...body } = cmp
  if (body.operator_pubkey !== publicKeyHex(publicKey) || !verifyValue(publicKey, body, signature)) findings.push('comparison signature does not verify')
  if (body.base_hash !== sel.base_hash) findings.push('comparison base_hash differs from the receipt')

  // The same set of plans everywhere: receipt, comparison file, measured rows, refs.
  // Otherwise a row could take part in the ranking without being checked below.
  const ids = (list) => canonicalJson((Array.isArray(list) ? list : []).map((x) => x?.plan_id).sort())
  const refIds = canonicalJson(Object.keys(found.receipt.refs ?? {}).filter((k) => k.startsWith('rehearsal:')).map((k) => k.slice(10)).sort())
  const want = ids(sel.compared)
  if (ids(body.compared) !== want || ids(body.plans) !== want || refIds !== want) findings.push('compared plans differ between receipt, comparison file, measured rows and refs')
  if (canonicalJson(sel.compared) !== canonicalJson((body.compared ?? []).map(({ plan_id, report_hash }) => ({ plan_id, report_hash })))) findings.push('report hashes differ between receipt and comparison file')

  // Each compared plan, winner and losers alike: bound to its signed rehearsal receipt, measured values consistent with it.
  const byHash = new Map(chain.receipts.map((r) => [hashValue(r), r]))
  let rechecked = 0
  for (const c of body.compared ?? []) {
    const reh = byHash.get(found.receipt.refs?.[`rehearsal:${c.plan_id}`])
    const row = (body.plans ?? []).find((p) => p.plan_id === c.plan_id)
    if (!reh || reh.kind !== 'rehearsal' || reh.subject?.plan_id !== c.plan_id) {
      findings.push(`${c.plan_id}: no matching rehearsal receipt`)
      continue
    }
    if (reh.subject.report_hash !== c.report_hash) findings.push(`${c.plan_id}: report hash differs from its rehearsal receipt`)
    if (reh.subject.base_hash !== body.base_hash) findings.push(`${c.plan_id}: rehearsed on another base`)
    if (!row || row.verdict !== reh.verdict || row.duration_ms !== reh.subject.duration_ms) findings.push(`${c.plan_id}: measured values differ from the rehearsal receipt`)
    // If the stored report is still the compared one, re-derive every measured value from it.
    const rp = reportPath(repoDir, missionId, c.plan_id)
    let report = null
    try {
      report = existsSync(rp) ? JSON.parse(readFileSync(rp, 'utf8')) : null
    } catch {
      report = null // unreadable now: checked against the receipt only, not counted as re-derived
    }
    if (report) {
      if (hashValue(report) === c.report_hash) {
        rechecked++
        if (canonicalJson(measuredRow(report)) !== canonicalJson(row)) findings.push(`${c.plan_id}: measured values differ from the stored report`)
      }
    }
  }

  // The rule, applied again to the same inputs, must give the same answer.
  let again = null
  try {
    again = rankPlans(body.plans)
  } catch (err) {
    findings.push(`ranking cannot be replayed: ${err.message}`)
  }
  if (again && canonicalJson(again) !== canonicalJson(body.ranking)) findings.push('replayed ranking differs from the recorded one')
  if (again && (again.recommended !== sel.recommended || again.decided_by !== sel.decided_by)) findings.push('receipt names a different choice than the rule gives')

  return { ok: findings.length === 0, findings, recommended: sel.recommended, decided_by: sel.decided_by, reports_rechecked: rechecked }
}
