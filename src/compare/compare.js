/**
 * Load stored rehearsals and prove they are comparable (R15.1, R15.2).
 *
 * Two or more plans are compared only if every one of these holds; otherwise the
 * comparison is refused with a code and the exact differences:
 *   - each report exists, is signed by the operator key, belongs to this mission
 *     and plan, and its base_hash is the hash of its own fingerprint base;
 *   - each report is the one recorded by the latest rehearsal receipt for its plan
 *     in a receipt chain that verifies (an older or substituted report is refused);
 *   - all base_hash values are equal. The base covers the target identity (Compose
 *     project, db service and name, Compose file hash), git head and tree, image
 *     digests and every table's row count and checksum, so equal base_hash means
 *     the same source state in the same environment;
 *   - all rehearsal conditions are equal (protected tables, impact thresholds,
 *     database, whether tests were measured) and the report format is the same.
 */

import { existsSync, readFileSync } from 'node:fs'
import { canonicalJson, hashValue } from '../util/canonical.js'
import { baseHash, compareFingerprints } from '../fidelity/gate.js'
import { reportPath, reportSignatureProblem } from '../rehearsal/engine.js'
import { findLast, verifyChain } from '../receipts/chain.js'

export const PLAN_RE = /^plan-[0-9a-f]{12}$/

export class ComparisonRefused extends Error {
  /** @param {string} code @param {string} message @param {unknown} [detail] */
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

const refuse = (code, message, detail) => {
  throw new ComparisonRefused(code, message, detail)
}

function loadOne({ repoDir, publicKey, missionId, id, receipts }) {
  const file = reportPath(repoDir, missionId, id)
  if (!existsSync(file)) refuse('REPORT_MISSING', `no stored rehearsal for ${id}`, { plan_id: id })
  let report
  try {
    report = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    refuse('REPORT_INVALID', `report for ${id} is not valid JSON`, { plan_id: id })
  }
  const problem = reportSignatureProblem(report, publicKey)
  if (problem) refuse('REPORT_INVALID', `${id}: ${problem}`, { plan_id: id })
  if (report.mission_id !== missionId || report.plan_id !== id) refuse('REPORT_INVALID', `${id}: report is for another mission or plan`, { plan_id: id })
  if (report.base_hash !== baseHash(report.fingerprint)) refuse('REPORT_INVALID', `${id}: base_hash does not match the report's fingerprint`, { plan_id: id })
  if (!report.conditions) refuse('CONDITIONS_UNKNOWN', `${id}: report does not record its rehearsal conditions; rehearse it again`, { plan_id: id })
  const reportHash = hashValue(report)
  const recorded = findLast(receipts, (r) => r.kind === 'rehearsal' && r.subject?.plan_id === id)
  if (!recorded) refuse('NOT_IN_CHAIN', `${id}: no rehearsal receipt records this plan`, { plan_id: id })
  if (recorded.receipt.subject.report_hash !== reportHash) {
    refuse('NOT_IN_CHAIN', `${id}: stored report is not the one recorded by the latest rehearsal receipt`, { plan_id: id, recorded: recorded.receipt.subject.report_hash, stored: reportHash })
  }
  return { plan_id: id, report, report_hash: reportHash, rehearsal_receipt: recorded.hash }
}

/**
 * @param {{ repoDir: string, home: string, publicKey: any, missionId: string, planIds: string[] }} a
 * @returns {{ mission_id: string, base_hash: string, conditions: object, entries: { plan_id: string, report: any, report_hash: string, rehearsal_receipt: string }[] }}
 */
export function loadComparable({ repoDir, home, publicKey, missionId, planIds }) {
  if (!Array.isArray(planIds) || planIds.length < 2) refuse('TOO_FEW_PLANS', 'a comparison needs at least two plans')
  const bad = planIds.filter((p) => typeof p !== 'string' || !PLAN_RE.test(p))
  if (bad.length > 0) refuse('INVALID_PLAN_ID', `${bad.length} plan id(s) are not of the form plan-<12 hex>`)
  const ids = [...planIds].sort()
  if (new Set(ids).size !== ids.length) refuse('DUPLICATE_PLAN', 'the same plan is listed twice')

  const chain = verifyChain({ repoDir, home, publicKey, missionId })
  if (!chain.ok) refuse('CHAIN_INVALID', `receipt chain does not verify: ${chain.findings[0].problem}`, chain.findings)
  const entries = ids.map((id) => loadOne({ repoDir, publicKey, missionId, id, receipts: chain.receipts }))

  const [ref, ...rest] = entries
  const baseDiffs = rest
    .filter((e) => e.report.base_hash !== ref.report.base_hash)
    .map((e) => ({
      plan_id: e.plan_id,
      against: ref.plan_id,
      diffs: compareFingerprints(ref.report.fingerprint.base, e.report.fingerprint.base).diffs.map((d) => ({ ...d, component: `base.${d.component}` })),
    }))
  if (baseDiffs.length > 0) refuse('BASE_MISMATCH', 'plans were rehearsed on different source states or environments; results are not comparable', baseDiffs)

  const condDiffs = rest
    .filter((e) => e.report.version !== ref.report.version || canonicalJson(e.report.conditions) !== canonicalJson(ref.report.conditions))
    .map((e) => ({
      plan_id: e.plan_id,
      against: ref.plan_id,
      diffs: [
        ...(e.report.version !== ref.report.version ? [{ component: 'version', before: ref.report.version, after: e.report.version }] : []),
        ...compareFingerprints(ref.report.conditions, e.report.conditions).diffs.map((d) => ({ ...d, component: `conditions.${d.component}` })),
      ],
    }))
  if (condDiffs.length > 0) refuse('CONDITIONS_MISMATCH', 'plans were judged under different rehearsal conditions; results are not comparable', condDiffs)

  return { mission_id: missionId, base_hash: ref.report.base_hash, conditions: ref.report.conditions, entries }
}
