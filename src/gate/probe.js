/**
 * Gate Health: is the PreToolUse gate running for the agent's session right now?
 *
 * A probe has a random nonce. The operator asks the agent to run the probe command
 * (src/gate/command.js) in the session to check. Then exactly one of three things is seen:
 *   ACTIVE    a signed hook_decision receipt denies that command (category GATE_PROBE,
 *             reason naming the nonce), timestamped after the probe started: the hook ran
 *             for that call in that session.
 *   INACTIVE  the canary file the command creates exists: nothing blocked the command.
 *             This wins over a receipt (some session ran it unblocked).
 *   UNKNOWN   neither: the agent did not run the command, another layer stopped it, or the
 *             workspace has no active contract (the hook signs nothing then). UNKNOWN never
 *             means blocked.
 * Recent hook receipts without a probe are shown for information only: they prove that a
 * hook ran in this workspace, not that the session being looked at is gated.
 *
 * Freshness: ACTIVE lasts FRESH_MS from the timestamp of the hook denial itself, found in the
 * verified chain through the gate_probe receipt's refs. Finishing a probe late never renews it: a
 * denial already older than FRESH_MS is recorded as UNKNOWN (stale), and a recorded ACTIVE whose
 * hook denial cannot be found is UNKNOWN.
 *
 * One pending probe per workspace (.justrunme/gate-probe.json); starting a probe replaces the
 * pending one. Parallel sessions are not told apart: check them one after the other.
 *
 * Limits. ACTIVE rests on a receipt signed with the operator key, which the hook loads from the
 * key directory without a passphrase. In a session the gate does not cover, an agent with a shell
 * can read that directory, sign a denial itself and remove the canary file: ACTIVE is evidence
 * against a misconfigured or untrusted workspace, not against a hostile agent that is already
 * ungated. Removing the canary turns INACTIVE into UNKNOWN. Creating the canary only raises a
 * false alarm. The receipt names the workspace mission, not a Kiro session.
 */
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { appendReceipt, receiptHash } from '../receipts/chain.js'
import { FRESH_MS, NONCE_RE, canaryName, probeCommand, probeReason } from './command.js'

const STATE_DIR = '.justrunme'
const PROBE_FILE = 'gate-probe.json'
export { FRESH_MS }

const probePath = (repoDir) => path.join(repoDir, STATE_DIR, PROBE_FILE)

export class ProbeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** The pending probe of a workspace, or null. A malformed file counts as none. */
export function pendingProbe(repoDir) {
  try {
    const p = JSON.parse(readFileSync(probePath(repoDir), 'utf8'))
    return p && NONCE_RE.test(p.nonce ?? '') && !Number.isNaN(Date.parse(p.started_at)) ? { nonce: p.nonce, started_at: p.started_at } : null
  } catch {
    return null
  }
}

/** Starts a probe (replacing a pending one) and returns the command to give the agent. */
export function startProbe({ repoDir, now = Date.now() }) {
  const nonce = randomBytes(8).toString('hex')
  const probe = { nonce, started_at: new Date(now).toISOString() }
  mkdirSync(path.join(repoDir, STATE_DIR), { recursive: true })
  const part = `${probePath(repoDir)}.part-${process.pid}`
  writeFileSync(part, JSON.stringify(probe) + '\n', { mode: 0o600 })
  renameSync(part, probePath(repoDir))
  return { ...probe, command: probeCommand(nonce) }
}

const canaryPresent = (repoDir, nonce) => {
  try {
    lstatSync(path.join(repoDir, canaryName(nonce)))
    return true
  } catch {
    return false
  }
}

/**
 * What the workspace shows for one probe.
 * @param {{ repoDir: string, receipts: any[], probe: { nonce: string, started_at: string } }} a receipts of a verified chain
 */
export function observeProbe({ repoDir, receipts, probe }) {
  const since = Date.parse(probe.started_at)
  const hit = receipts.find((r) => r.kind === 'hook_decision' && r.verdict === 'deny' && r.subject?.category === 'GATE_PROBE' && r.subject?.reason === probeReason(probe.nonce) && Date.parse(r.timestamp) >= since)
  const canary = canaryPresent(repoDir, probe.nonce)
  const status = canary ? 'INACTIVE' : hit ? 'ACTIVE' : 'UNKNOWN'
  return {
    status,
    nonce: probe.nonce,
    started_at: probe.started_at,
    canary_present: canary,
    hook_receipt: hit ? { seq: hit.seq, hash: receiptHash(hit), at: hit.timestamp, tool: hit.subject?.tool ?? null } : null,
  }
}

/**
 * Records the outcome of the pending probe as a signed gate_probe receipt, then removes
 * the probe state and the canary file.
 */
export function finishProbe({ repoDir, keys, missionId, receipts, now = Date.now() }) {
  const probe = pendingProbe(repoDir)
  if (!probe) throw new ProbeError('NO_PROBE', 'no gate probe is pending; start one first')
  const seen = observeProbe({ repoDir, receipts, probe })
  // A denial older than FRESH_MS is no longer evidence for the session now: record UNKNOWN (stale).
  const stale = seen.status === 'ACTIVE' && now - Date.parse(seen.hook_receipt.at) > FRESH_MS
  const o = stale ? { ...seen, status: 'UNKNOWN' } : seen
  const hash = appendReceipt({
    repoDir,
    keys,
    missionId,
    kind: 'gate_probe',
    verdict: o.status,
    subject: { nonce: o.nonce, started_at: o.started_at, canary_present: o.canary_present, hook_receipt_seq: o.hook_receipt?.seq ?? null, ...(stale ? { stale: true } : {}) },
    refs: o.hook_receipt ? { hook_decision: o.hook_receipt.hash } : {},
    now,
  }).hash
  rmSync(probePath(repoDir), { force: true })
  // The receipt is written; a canary the agent turned into a directory must not hide that.
  let canaryRemoved = null
  if (o.canary_present) {
    try {
      rmSync(path.join(repoDir, canaryName(o.nonce)), { force: true })
      canaryRemoved = true
    } catch {
      canaryRemoved = false
    }
  }
  return { ...o, stale, receipt: hash, canary_removed: canaryRemoved }
}

/**
 * The Gate Health panel: the pending probe if there is one, else the last recorded probe,
 * with ACTIVE turning UNKNOWN once it is older than FRESH_MS.
 * @param {{ repoDir: string, receipts: any[], now?: number }} a receipts of a verified chain
 */
export function gateHealth({ repoDir, receipts, now = Date.now() }) {
  const lastHook = [...receipts].reverse().find((r) => r.kind === 'hook_decision') ?? null
  const info = { last_hook_decision: lastHook ? { seq: lastHook.seq, at: lastHook.timestamp, verdict: lastHook.verdict } : null }
  const probe = pendingProbe(repoDir)
  if (probe) {
    const o = observeProbe({ repoDir, receipts, probe })
    const at = o.hook_receipt ? Date.parse(o.hook_receipt.at) : null
    if (o.status === 'ACTIVE' && now - at > FRESH_MS) return { status: 'UNKNOWN', why: 'STALE', pending: true, observed: o, ...info }
    return { status: o.status, why: o.status === 'UNKNOWN' ? 'WAITING_FOR_PROBE' : 'PROBE_OBSERVED', pending: true, observed: o, command: probeCommand(o.nonce), ...info }
  }
  const last = [...receipts].reverse().find((r) => r.kind === 'gate_probe') ?? null
  if (!last) return { status: 'UNKNOWN', why: 'NEVER_PROBED', pending: false, recorded: null, ...info }
  const recorded = { seq: last.seq, hash: receiptHash(last), at: last.timestamp, verdict: last.verdict, canary_present: last.subject?.canary_present === true, stale: last.subject?.stale === true }
  if (last.verdict === 'ACTIVE') {
    // Age from the hook denial the receipt cites, never from when the result was recorded.
    const hit = receipts.find((r) => receiptHash(r) === last.refs?.hook_decision && r.kind === 'hook_decision' && r.verdict === 'deny' && r.subject?.category === 'GATE_PROBE')
    if (!hit) return { status: 'UNKNOWN', why: 'HOOK_RECEIPT_MISSING', pending: false, recorded, ...info }
    recorded.hook_receipt = { seq: hit.seq, hash: receiptHash(hit), at: hit.timestamp }
    if (now - Date.parse(hit.timestamp) > FRESH_MS) return { status: 'UNKNOWN', why: 'STALE', pending: false, recorded, ...info }
    return { status: 'ACTIVE', why: 'PROBE_RECORDED', pending: false, recorded, ...info }
  }
  if (last.subject?.stale === true) return { status: 'UNKNOWN', why: 'STALE', pending: false, recorded, ...info }
  return { status: last.verdict === 'INACTIVE' ? 'INACTIVE' : 'UNKNOWN', why: 'PROBE_RECORDED', pending: false, recorded, ...info }
}
