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
import { inspectChainLock, readChain, reanchorChain, receiptHash, recoverLock, verifyChain } from '../receipts/chain.js'
import { checkPolicy } from '../receipts/policy.js'
import { loadReport, planId, rehearse } from '../rehearsal/engine.js'
import { ComparisonRefused } from '../compare/compare.js'
import { comparePlans, verifySelection } from '../compare/select.js'
import { plansOnBase } from '../compare/gate.js'
import { AuthorizationRefused } from '../authorize/authorization.js'
import { authorizationPath, authorizeMission, runMission } from '../run/mission.js'
import { UndoRefused, undoMission } from '../undo/undo.js'
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
  throw new CliError(exit, err.code, err.message, err.detail)
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
  const report = await rehearse({ repoDir, contract: c.contract, contractHash: c.hash, target, keys: operatorKeys() })
  const rowsLost = Object.fromEntries(report.conditions.protected_tables.map((t) => [t, report.tables?.[t]?.rows_lost ?? null]))
  return {
    exit: verdictExit(report.verdict),
    result: {
      mission_id: report.mission_id,
      plan_id: report.plan_id,
      verdict: report.verdict,
      evidence: report.evidence,
      rows_lost: rowsLost,
      schema_delta: report.schema_delta ?? null,
      base_hash: report.base_hash,
      duration_ms: report.duration_ms,
      cleanup: report.cleanup,
    },
  }
}

/**
 * Without plan ids: every plan whose latest rehearsal is on the base of the most
 * recent rehearsal. The selection gate requires exactly that coverage anyway.
 */
export function compareCmd({ repoDir, opts, planIds }) {
  const keys = operatorKeys()
  const missionId = missionOf(repoDir, opts)
  let ids = planIds
  if (ids.length === 0) {
    const last = readChain(repoDir, missionId).filter((r) => r.kind === 'rehearsal').at(-1)
    ids = last ? [...plansOnBase(readChain(repoDir, missionId), last.subject.base_hash).keys()].sort() : []
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
  let auth
  try {
    auth = await authorizeMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys: operatorKeys() })
  } catch (err) {
    if (err instanceof AuthorizationRefused) refused(EXIT.AUTHORIZATION_REFUSED, err)
    throw err
  }
  return { exit: EXIT.OK, result: { mission_id: auth.mission_id, plan_id: auth.plan_id, selection: auth.selection ?? null, expires_at: auth.expires_at, fingerprint_hash: auth.fingerprint_hash } }
}

export async function runCmd({ repoDir }) {
  const c = contractOf(repoDir)
  const { target } = targetOf(repoDir)
  let r
  try {
    r = await runMission({ repoDir, contract: c.contract, contractHash: c.hash, target, keys: operatorKeys() })
  } catch (err) {
    if (err instanceof AuthorizationRefused) refused(EXIT.RUN_REFUSED, err)
    throw err
  }
  return { exit: r.ok ? EXIT.OK : EXIT.RUN_FAILED, result: { mission_id: r.mission_id, plan_id: r.plan_id, ok: r.ok, capture_id: r.capture_id, steps: r.steps, receipt_hash: r.receipt_hash } }
}

export async function undoCmd({ repoDir, opts, captureId }) {
  if (!CAPTURE_RE.test(captureId ?? '')) throw new CliError(EXIT.USAGE, 'INVALID_CAPTURE_ID', 'undo needs a capture id of the form cap-<14 digits>-<6 hex>')
  const missionId = missionOf(repoDir, opts)
  const { target, health } = targetOf(repoDir)
  let r
  try {
    r = await undoMission({ repoDir, missionId, captureId, target, keys: operatorKeys(), health, resources: opts.resource })
  } catch (err) {
    if (err instanceof UndoRefused) refused(EXIT.UNDO_REFUSED, err)
    throw err
  }
  return {
    exit: r.status === 'RECOVERED' ? EXIT.OK : EXIT.RECOVERY_FAILED,
    result: { mission_id: r.mission_id, capture_id: r.capture_id, status: r.status, resources: r.resources, verification: { status: r.verification.status, checks: r.verification.checks.length, failed: r.verification.failed }, receipts: r.receipts },
  }
}

/** Chain, ordering policy, and a replay of every recorded selection. */
export function verifyCmd({ repoDir, opts }) {
  const { home, publicKey } = publicSide()
  const missionId = missionOf(repoDir, opts)
  const chain = verifyChain({ repoDir, home, publicKey, missionId })
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
  const chain = verifyChain({ repoDir, home, publicKey, missionId })
  if (chain.ok && !chain.receipts.some((r) => r.kind === 'plan_selected')) throw new CliError(EXIT.USAGE, 'NOTHING_TO_REPLAY', 'no plan_selected receipt in this mission')
  const v = verifySelection({ repoDir, home, publicKey, missionId, receiptHash: opts.receipt ?? null })
  return { exit: v.ok ? EXIT.OK : EXIT.INTEGRITY, result: { mission_id: missionId, ...v } }
}

export function statusCmd({ repoDir, opts }) {
  const { home, publicKey } = publicSide()
  const c = contractOf(repoDir)
  const missionId = opts.mission ?? c.contract.id
  const chain = verifyChain({ repoDir, home, publicKey, missionId })
  const counts = {}
  for (const r of chain.receipts) counts[r.kind] = (counts[r.kind] ?? 0) + 1
  const last = chain.receipts.at(-1)
  const id = planId(c.contract)
  let report = null
  try {
    const rep = loadReport(repoDir, missionId, id)
    report = { verdict: rep.verdict, base_hash: rep.base_hash, rehearsed_at: rep.rehearsed_at }
  } catch {
    report = null
  }
  return {
    exit: EXIT.OK,
    result: {
      mission_id: missionId,
      plan_id: id,
      rehearsal: report,
      authorization_pending: existsSync(authorizationPath(repoDir)),
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
    throw new CliError(EXIT.MAINTENANCE_REFUSED, 'LOCK_RECOVERY_REFUSED', err.message)
  }
}
