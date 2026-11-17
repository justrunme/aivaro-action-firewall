/**
 * CLI command handlers (T18). Each one is a thin call into the same library
 * functions the tests use: no command has its own path around the fidelity gate,
 * the selection gate (src/compare/gate.js, inside authorizeMission) or the receipt
 * chain. Every handler returns { exit, result } or throws CliError.
 *
 * Operator keys are never created implicitly: only `keys init` creates them.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseContract } from '../contract/parser.js'
import { CONTRACT_FILE } from '../hook/run.js'
import { keyHome, loadExistingKeys, loadOrCreateKeys, loadPublicKey, publicKeyHex } from '../receipts/keys.js'
import { inspectChainLock, reanchorChain, receiptHash, recoverLock, verifyChain } from '../receipts/chain.js'
import { checkPolicy } from '../receipts/policy.js'
import { hashValue } from '../util/canonical.js'
import { RehearsalRefused, loadReport, planId, rehearse, reportSignatureProblem } from '../rehearsal/engine.js'
import { ComparisonRefused } from '../compare/compare.js'
import { comparePlans, verifySelection } from '../compare/select.js'
import { plansOnBase } from '../compare/gate.js'
import { AuthorizationRefused, signatureProblem } from '../authorize/authorization.js'
import { authorizationPath, authorizeMission, runMission } from '../run/mission.js'
import { UndoRefused, undoMission } from '../undo/undo.js'
import { JudgeEnvironmentError, createBackend } from '../judge/env.js'
import { runJudge } from '../judge/index.js'
import { EXIT, verdictExit } from './codes.js'
import { ConfigError, loadTarget } from './target.js'

export class CliError extends Error {
  /** @param {number} exit @param {string} code @param {string} message @param {unknown} [detail] */
  constructor(exit, code, message, detail) {
    super(message)
    this.exit = exit
    this.code = code
    this.detail = detail
  }
}

const CAPTURE_RE = /^cap-\d{14}-[0-9a-f]{6}$/

function contractOf(repoDir) {
  const file = path.join(repoDir, CONTRACT_FILE)
  if (!existsSync(file)) throw new CliError(EXIT.CONFIG, 'NO_CONTRACT', `${CONTRACT_FILE} not found in the workspace`)
  const parsed = parseContract(readFileSync(file, 'utf8'))
  if (!parsed.ok) throw new CliError(EXIT.CONFIG, 'CONTRACT_INVALID', 'mission contract does not validate', parsed.errors)
  return parsed
}

function targetOf(repoDir) {
  try {
    return loadTarget(repoDir)
  } catch (err) {
    if (err instanceof ConfigError) throw new CliError(EXIT.CONFIG, err.code, err.message)
    throw err
  }
}

function operatorKeys() {
  const keys = loadExistingKeys(keyHome())
  if (!keys) throw new CliError(EXIT.CONFIG, 'NO_OPERATOR_KEY', 'no operator key installed; run `justrunme keys init` first')
  return keys
}

/** Read-only commands need only the public key (judges, CI). */
function publicSide() {
  const home = keyHome()
  const publicKey = loadPublicKey(home)
  if (!publicKey) throw new CliError(EXIT.CONFIG, 'NO_OPERATOR_KEY', 'no operator public key installed')
  return { home, publicKey }
}

const missionOf = (repoDir, opts) => opts.mission ?? contractOf(repoDir).contract.id

function refused(exit, err) {
  const detail = err.recorded === false ? { ...(err.detail !== undefined ? { reason_detail: err.detail } : {}), recorded: false, record_error: err.record_error } : err.detail
  throw new CliError(exit, err.code, err.message, detail)
}

/**
 * A lock whose owner cannot be determined never clears by itself: say so at once
 * instead of waiting for the timeout. (A live owner is waited for as usual.)
 */
function preflight(repoDir, missionId) {
  const lock = inspectChainLock({ repoDir, missionId })
  if (lock.exists && lock.owner === 'unknown') {
    throw new CliError(EXIT.CHAIN_LOCKED, 'CHAIN_LOCKED', 'the receipt chain lock has an unknown owner; inspect it with `justrunme lock inspect`', { sha256: lock.sha256 })
  }
}

/** Work was done but its receipt could not be written: never report that as success. */
function unrecorded(result) {
  if (!result.receipt_error) return
  const exit = result.receipt_error === 'CHAIN_LOCKED' ? EXIT.CHAIN_LOCKED : EXIT.INTEGRITY
  throw new CliError(exit, 'RESULT_UNRECORDED', `the command did its work but its receipt could not be written (${result.receipt_error}); the result below is not in the chain`, result)
}

/** verifyChain, read without the lock: retry once if a parallel append was caught between line and anchor. */
function verifiedChain(args) {
  const first = verifyChain(args)
  if (first.ok || !first.findings.every((f) => f.code === 'ANCHOR_BEHIND')) return first
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  return verifyChain(args)
}

/**
 * The one-command demo. It builds its own throwaway workspace, key and database, so
 * it takes neither --repo nor --mission and never reads the operator's key directory.
 */
export async function judgeCmd({ opts }) {
  if (opts.repo !== undefined || opts.mission !== undefined) throw new CliError(EXIT.USAGE, 'USAGE', 'judge builds its own workspace; it takes no --repo or --mission')
  let report
  try {
    report = await runJudge({ create: () => createBackend() })
  } catch (err) {
    if (err instanceof JudgeEnvironmentError) throw new CliError(EXIT.JUDGE_ENVIRONMENT, err.code, err.message)
    throw err
  }
  return { exit: report.judge.status === 'PASS' ? EXIT.OK : EXIT.JUDGE_FAILED, result: report }
}

export function keysInit() {
  const home = keyHome()
  const existed = loadPublicKey(home) !== null
  const keys = loadOrCreateKeys(home)
  return { exit: EXIT.OK, result: { created: !existed, public_key: publicKeyHex(keys.publicKey) } }
}

export async function rehearseCmd({ repoDir }) {
  const c = contractOf(repoDir)
  const { target } = targetOf(repoDir)
  const keys = operatorKeys()
  preflight(repoDir, c.contract.id)
  let report
  try {
    report = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
  } catch (err) {
    if (err instanceof RehearsalRefused) refused(EXIT.REHEARSAL_REFUSED, err)
    throw err
  }
  const rowsLost = Object.fromEntries(report.conditions.protected_tables.map((t) => [t, report.tables?.[t]?.rows_lost ?? null]))
  const summary = {
    mission_id: report.mission_id,
    plan_id: report.plan_id,
    verdict: report.verdict,
    evidence: report.evidence,
    rows_lost: rowsLost,
    schema_delta: report.schema_delta ?? null,
    base_hash: report.base_hash,
    duration_ms: report.duration_ms,
    cleanup: report.cleanup,
    receipt_error: report.receipt_error,
  }
  unrecorded(summary)
  return {
    // A copy that was not removed holds a dump of the real database: that outranks the verdict.
    exit: report.cleanup?.clean === false ? EXIT.REHEARSAL_UNCLEAN : verdictExit(report.verdict),
    result: summary,
  }
}

/**
 * Without plan ids: every plan whose latest rehearsal is on the base of the most
 * recent rehearsal. The selection gate requires exactly that coverage anyway.
 */
export function compareCmd({ repoDir, opts, planIds }) {
  const keys = operatorKeys()
  const missionId = missionOf(repoDir, opts)
  preflight(repoDir, missionId)
  let ids = planIds
  if (ids.length === 0) {
    const chain = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId })
    if (!chain.ok) throw new CliError(EXIT.COMPARISON_REFUSED, 'CHAIN_INVALID', `receipt chain does not verify: ${chain.findings[0].problem}`)
    const last = chain.receipts.filter((r) => r.kind === 'rehearsal').at(-1)
    ids = last ? [...plansOnBase(chain.receipts, last.subject.base_hash).keys()].sort() : []
  }
  let r
  try {
    r = comparePlans({ repoDir, keys, missionId, planIds: ids })
  } catch (err) {
    if (err instanceof ComparisonRefused) refused(EXIT.COMPARISON_REFUSED, err)
    throw err
  }
  const ranking = r.comparison.ranking
  return {
    exit: ranking.recommended ? EXIT.OK : EXIT.NO_PLAN_SELECTED,
    result: {
      recommended: ranking.recommended,
      decided_by: ranking.decided_by,
      removed: ranking.removed,
      rules: ranking.rules,
      plans: r.comparison.plans,
      base_hash: r.comparison.base_hash,
      comparison_hash: r.comparison_hash,
      receipt_hash: r.receipt_hash,
    },
  }
}

export async function authorizeCmd({ repoDir }) {
  const c = contractOf(repoDir)
  const { target } = targetOf(repoDir)
  const keys = operatorKeys()
  preflight(repoDir, c.contract.id)
  let auth
  try {
    auth = await authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
  } catch (err) {
    if (err instanceof AuthorizationRefused) refused(EXIT.AUTHORIZATION_REFUSED, err)
    throw err
  }
  return { exit: EXIT.OK, result: { mission_id: auth.mission_id, plan_id: auth.plan_id, selection: auth.selection ?? null, expires_at: auth.expires_at, fingerprint_hash: auth.fingerprint_hash } }
}

export async function runCmd({ repoDir }) {
  const c = contractOf(repoDir)
  const { target } = targetOf(repoDir)
  const keys = operatorKeys()
  preflight(repoDir, c.contract.id)
  let r
  try {
    r = await runMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys })
  } catch (err) {
    if (err instanceof AuthorizationRefused) refused(EXIT.RUN_REFUSED, err)
    throw err
  }
  const result = { mission_id: r.mission_id, plan_id: r.plan_id, ok: r.ok, capture_id: r.capture_id, skipped_needs_approval: r.skipped_needs_approval, steps: r.steps, receipt_hash: r.receipt_hash, receipt_error: r.receipt_error }
  unrecorded(result)
  const exit = !r.ok ? EXIT.RUN_FAILED : r.skipped_needs_approval.length > 0 ? EXIT.RUN_INCOMPLETE : EXIT.OK
  return { exit, result }
}

export async function undoCmd({ repoDir, opts, captureId }) {
  if (!CAPTURE_RE.test(captureId ?? '')) throw new CliError(EXIT.USAGE, 'INVALID_CAPTURE_ID', 'undo needs a capture id of the form cap-<14 digits>-<6 hex>')
  const missionId = missionOf(repoDir, opts)
  const { target, health } = targetOf(repoDir)
  const keys = operatorKeys()
  // Break-glass recovery: explicit flag, a written reason, and the capture id typed again.
  const emergency = opts['emergency-recovery'] === true
  if (emergency) {
    if (typeof opts.reason !== 'string' || opts.reason.trim().length < 8) throw new CliError(EXIT.USAGE, 'EMERGENCY_REASON_REQUIRED', '--emergency-recovery needs --reason "<why>" (at least 8 characters)')
    if (opts.confirm !== captureId) throw new CliError(EXIT.USAGE, 'CONFIRMATION_REQUIRED', '--emergency-recovery needs --confirm <the same capture id>')
  } else {
    preflight(repoDir, missionId)
  }
  let r
  try {
    r = await undoMission({ repoDir, missionId, captureId, target, keys, health, resources: opts.resource, emergency: emergency ? { reason: opts.reason } : null })
  } catch (err) {
    if (err instanceof UndoRefused) refused(EXIT.UNDO_REFUSED, err)
    throw err
  }
  const result = {
    mission_id: r.mission_id,
    capture_id: r.capture_id,
    status: r.status,
    evidence_status: r.evidence_status,
    resources: r.resources,
    verification: { status: r.verification.status, checks: r.verification.checks.length, failed: r.verification.failed },
    receipts: r.receipts,
    ...(emergency ? { emergency_record: r.emergency_record ?? null } : {}),
    receipt_error: r.receipt_error,
  }
  unrecorded(result)
  if (r.status !== 'RECOVERED') return { exit: EXIT.RECOVERY_FAILED, result }
  // Never exit 0 for a break-glass recovery: CI must not read it as a normal undo.
  return { exit: emergency ? EXIT.EMERGENCY_RECOVERED : EXIT.OK, result }
}

/** Chain, ordering policy, and a replay of every recorded selection. */
export function verifyCmd({ repoDir, opts }) {
  const { home, publicKey } = publicSide()
  const missionId = missionOf(repoDir, opts)
  const chain = verifiedChain({ repoDir, home, publicKey, missionId })
  // An empty or mistyped mission has nothing to verify; that is not a pass.
  if (chain.ok && chain.count === 0) throw new CliError(EXIT.USAGE, 'NO_RECEIPTS', `mission ${missionId} has no receipts`)
  const policy = chain.ok ? checkPolicy(chain.receipts) : { ok: false, findings: [] }
  const selections = chain.ok
    ? chain.receipts.filter((r) => r.kind === 'plan_selected').map((r) => {
        const v = verifySelection({ repoDir, home, publicKey, missionId, receiptHash: receiptHash(r) })
        return { seq: r.seq, recommended: r.subject?.recommended ?? null, ok: v.ok, findings: v.findings }
      })
    : []
  const ok = chain.ok && policy.ok && selections.every((s) => s.ok)
  return {
    exit: ok ? EXIT.OK : EXIT.INTEGRITY,
    result: { mission_id: missionId, ok, receipts: chain.count, chain_findings: chain.findings, policy_findings: policy.findings, selections },
  }
}

export function replayCmd({ repoDir, opts }) {
  const { home, publicKey } = publicSide()
  const missionId = missionOf(repoDir, opts)
  const chain = verifiedChain({ repoDir, home, publicKey, missionId })
  if (chain.ok && !chain.receipts.some((r) => r.kind === 'plan_selected')) throw new CliError(EXIT.USAGE, 'NOTHING_TO_REPLAY', 'no plan_selected receipt in this mission')
  if (chain.ok && opts.receipt !== undefined && !chain.receipts.some((r) => r.kind === 'plan_selected' && receiptHash(r) === opts.receipt)) {
    throw new CliError(EXIT.USAGE, 'NOT_A_SELECTION', '--receipt does not name a plan_selected receipt of this mission')
  }
  const v = verifySelection({ repoDir, home, publicKey, missionId, receiptHash: opts.receipt ?? null })
  return { exit: v.ok ? EXIT.OK : EXIT.INTEGRITY, result: { mission_id: missionId, ...v } }
}

/**
 * Status shows only what checks out: the current plan's report counts as rehearsed
 * only if it is operator-signed and recorded by a rehearsal receipt; the pending
 * authorization only if it is signed, recorded, for this contract and not expired.
 * Exit 30 when the chain does not verify.
 */
export function statusCmd({ repoDir, opts }) {
  const { home, publicKey } = publicSide()
  const contractPresent = existsSync(path.join(repoDir, CONTRACT_FILE))
  const c = opts.mission && !contractPresent ? null : contractOf(repoDir)
  const missionId = opts.mission ?? c.contract.id
  const chain = verifiedChain({ repoDir, home, publicKey, missionId })
  const counts = {}
  for (const r of chain.receipts) counts[r.kind] = (counts[r.kind] ?? 0) + 1
  const last = chain.receipts.at(-1)
  const id = c ? planId(c.contract) : null
  let report = null
  if (id) {
    try {
      const rep = loadReport(repoDir, missionId, id)
      const problem = reportSignatureProblem(rep, publicKey) ?? (chain.receipts.some((r) => r.kind === 'rehearsal' && r.subject?.report_hash === hashValue(rep)) ? null : 'no rehearsal receipt records this report')
      report = problem ? { valid: false, problem } : { valid: true, verdict: rep.verdict, base_hash: rep.base_hash, rehearsed_at: rep.rehearsed_at }
    } catch {
      report = null
    }
  }
  let authorization = null
  if (existsSync(authorizationPath(repoDir))) {
    try {
      const auth = JSON.parse(readFileSync(authorizationPath(repoDir), 'utf8'))
      const problem =
        signatureProblem(auth, publicKey) ??
        (c && (auth.mission_id !== c.contract.id || auth.contract_hash !== c.hash) ? 'authorization is for another mission or contract' : null) ??
        (Date.now() > Date.parse(auth.expires_at) ? 'authorization expired' : null) ??
        (chain.receipts.some((r) => r.kind === 'authorization_issued' && r.subject?.authorization_hash === hashValue(auth)) ? null : 'no authorization_issued receipt matches it')
      authorization = problem ? { valid: false, problem } : { valid: true, plan_id: auth.plan_id, expires_at: auth.expires_at, selection: auth.selection ?? null }
    } catch {
      authorization = { valid: false, problem: 'authorization file is unreadable' }
    }
  }
  return {
    exit: chain.ok ? EXIT.OK : EXIT.INTEGRITY,
    result: {
      mission_id: missionId,
      plan_id: id,
      rehearsal: report,
      authorization,
      chain_ok: chain.ok,
      chain_findings: chain.findings,
      receipts: counts,
      last_receipt: last ? { seq: last.seq, kind: last.kind, verdict: last.verdict, timestamp: last.timestamp } : null,
    },
  }
}

export function receiptCmd({ repoDir, opts }) {
  const { home, publicKey } = publicSide()
  const missionId = missionOf(repoDir, opts)
  const chain = verifyChain({ repoDir, home, publicKey, missionId })
  if (chain.receipts.length === 0) throw new CliError(EXIT.USAGE, 'NO_RECEIPTS', 'this mission has no receipts')
  const seq = opts.seq === undefined ? chain.receipts.length - 1 : Number(opts.seq)
  if (!Number.isInteger(seq) || seq < 0 || seq >= chain.receipts.length) throw new CliError(EXIT.USAGE, 'INVALID_SEQ', `seq must be between 0 and ${chain.receipts.length - 1}`)
  const r = chain.receipts[seq]
  return { exit: chain.ok ? EXIT.OK : EXIT.INTEGRITY, result: { chain_ok: chain.ok, hash: receiptHash(r), receipt: r } }
}

export function reanchorCmd({ repoDir, opts }) {
  const keys = operatorKeys()
  const missionId = missionOf(repoDir, opts)
  try {
    return { exit: EXIT.OK, result: reanchorChain({ repoDir, keys, missionId, reason: opts.reason }) }
  } catch (err) {
    if (err.code === 'CHAIN_LOCKED') throw err
    throw new CliError(EXIT.MAINTENANCE_REFUSED, 'REANCHOR_REFUSED', err.message)
  }
}

export function lockCmd({ repoDir, opts, action }) {
  const missionId = missionOf(repoDir, opts)
  if (action === 'inspect') return { exit: EXIT.OK, result: inspectChainLock({ repoDir, missionId }) }
  if (action !== 'recover') throw new CliError(EXIT.USAGE, 'USAGE', 'lock needs `inspect` or `recover`')
  const keys = operatorKeys()
  try {
    return { exit: EXIT.OK, result: recoverLock({ repoDir, keys, missionId, expectedSha256: opts.sha256, reason: opts.reason }) }
  } catch (err) {
    if (err.code === 'CHAIN_LOCKED') throw err
    throw new CliError(EXIT.MAINTENANCE_REFUSED, 'LOCK_RECOVERY_REFUSED', err.message)
  }
}
