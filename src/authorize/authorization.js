/**
 * Run authorization: issue (operator side) and verify (hook and runner side).
 * R2.7, R3.2, R3.3, R3.6, R3.7.
 *
 * Issued only from a stored rehearsal report with verdict SAFE whose fingerprint
 * equals the current fingerprint. The result is signed with the operator's
 * Ed25519 key, which lives outside the workspace, so a file written by the agent
 * cannot pass verification. It is single-use: the runner consumes it.
 */

import { analyzeArgv } from '../hook/bypass.js'
import { hashScript } from '../hook/allowlist.js'
import { hashValue } from '../util/canonical.js'
import { publicKeyHex, signValue, verifyValue } from '../receipts/keys.js'
import { compareFingerprints } from '../fidelity/gate.js'

const SELF_REFERENCE = /(^|[\\/])(justrunme|src[\\/]cli|src[\\/]hook|src[\\/]authorize)([\\/.]|$)/i

export class AuthorizationRefused extends Error {
  /** @param {string} code @param {string} message @param {unknown} [detail] */
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/** Hook allowlist entries for the plan steps that Kiro itself will execute. */
export function entriesForPlan(plan, cwd) {
  const entries = []
  for (const step of plan) {
    if (step.tool !== 'shell') continue // sql_migration runs inside JustRunMe; others need approval
    if (step.args.some((a) => SELF_REFERENCE.test(a))) {
      throw new AuthorizationRefused('SELF_REFERENCE', `step ${step.id} invokes JustRunMe itself`)
    }
    const analysis = analyzeArgv(step.args)
    if (analysis.category) throw new AuthorizationRefused('UNBINDABLE_STEP', `step ${step.id}: ${analysis.detail}`)
    const script_hashes = {}
    for (const script of analysis.scripts) {
      const h = hashScript(script, cwd)
      if (h === null) throw new AuthorizationRefused('UNBINDABLE_STEP', `step ${step.id}: script ${script} missing or outside the workspace`)
      script_hashes[script] = h
    }
    entries.push({ step_id: step.id, action: { tool: 'shell', argv: step.args }, script_hashes })
  }
  return entries
}

/**
 * @param {object} a
 * @param {string} a.cwd workspace root
 * @param {any} a.contract
 * @param {string} a.contractHash
 * @param {any} a.report stored rehearsal report
 * @param {any} a.currentFingerprint freshly measured
 * @param {{ privateKey: any, publicKey: any }} a.keys
 * @param {number} a.now
 * @param {number} [a.ttlSeconds]
 */
export function issueAuthorization({ cwd, contract, contractHash, report, currentFingerprint, keys, now, ttlSeconds, selection = null }) {
  if (!report || report.mission_id !== contract.id) throw new AuthorizationRefused('NO_REHEARSAL', 'no rehearsal report for this mission')
  if (report.contract_hash !== contractHash) throw new AuthorizationRefused('CONTRACT_CHANGED', 'contract changed after rehearsal')
  if (report.verdict !== 'SAFE') {
    throw new AuthorizationRefused(report.verdict === 'DATA LOSS' ? 'DATA_LOSS' : 'NOT_SAFE', `rehearsal verdict is ${report.verdict}`, report.evidence)
  }
  const fidelity = compareFingerprints(report.fingerprint, currentFingerprint)
  if (!fidelity.ok) throw new AuthorizationRefused('FIDELITY_MISMATCH', 'source state changed since rehearsal', fidelity.diffs)

  const ttl = Math.min(ttlSeconds ?? contract.time_limit_seconds, contract.time_limit_seconds)
  const body = {
    version: 1,
    mission_id: contract.id,
    contract_hash: contractHash,
    plan_id: report.plan_id,
    fingerprint_hash: hashValue(currentFingerprint),
    source_state_hash: hashValue(currentFingerprint.plan.source),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * 1000).toISOString(),
    entries: entriesForPlan(contract.plan, cwd),
    // How the plan was chosen (T17): 'selected' names the plan_selected receipt.
    ...(selection ? { selection } : {}),
    operator_pubkey: publicKeyHex(keys.publicKey),
  }
  return { ...body, signature: signValue(keys.privateKey, body) }
}

/**
 * @returns {string | null} problem, or null when the signature is valid for publicKey
 */
export function signatureProblem(auth, publicKey) {
  if (!publicKey) return 'no operator public key is installed'
  if (!auth || typeof auth !== 'object') return 'authorization is malformed'
  const { signature, ...body } = auth
  if (body.operator_pubkey !== publicKeyHex(publicKey)) return 'authorization was signed by a different key'
  if (!verifyValue(publicKey, body, signature)) return 'authorization signature is invalid'
  return null
}
