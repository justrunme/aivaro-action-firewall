/**
 * Signed, hash-chained receipts per mission (R7.1 to R7.5).
 *
 * Storage: .justrunme/missions/<mission>/receipts.jsonl, one canonical JSON
 * receipt per line. Each receipt carries seq (0, 1, 2, ...), prev_hash (SHA-256
 * of the previous line, or of a per-mission genesis string), the operator public
 * key and an Ed25519 signature over every other field.
 *
 * Tamper evidence:
 *   - any changed byte: the line is no longer the canonical form of a correctly
 *     signed receipt, or the next prev_hash no longer matches;
 *   - a removed, reordered or inserted receipt: seq or prev_hash breaks;
 *   - a receipt copied from another mission: mission_id and prev_hash break;
 *   - a cut-off tail: the signed head anchor, kept in the operator key directory
 *     outside the workspace, no longer matches the last receipt.
 * Ordering rules between events (policy) are checked by policy.js.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256Hex } from '../util/canonical.js'
import { redactDeep } from '../privacy/redact.js'
import { STATE_DIR } from '../fidelity/source.js'
import { publicKeyHex, signValue, verifyValue } from './keys.js'
import { inspectLock, removeInspectedLock, withLock } from './lock.js'

export const KINDS = ['rehearsal', 'authorization_issued', 'authorization_refused', 'run_result', 'run_refused', 'undo', 'verification', 'hook_decision', 'chain_reanchored', 'lock_recovered', 'plan_selected', 'plan_comparison_refused']
const MISSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/

export const chainPath = (repoDir, missionId) => path.join(repoDir, STATE_DIR, 'missions', missionId, 'receipts.jsonl')
// One anchor per (workspace, mission): two workspaces may use the same mission id.
export const anchorPath = (home, missionId, repoDir) => headPath(home, missionId, repoDir)
function headPath(home, missionId, repoDir) {
  let where = path.resolve(repoDir)
  try {
    where = realpathSync(where)
  } catch {
    // workspace missing: the resolved path still names the anchor deterministically
  }
  return path.join(home, 'heads', `${missionId}-${sha256Hex(where).slice(0, 16)}.json`)
}
export const genesisHash = (missionId) => 'sha256:' + sha256Hex(`justrunme:genesis:v1:${missionId}`)
export const receiptHash = (receipt) => 'sha256:' + sha256Hex(canonicalJson(receipt))

function readLines(repoDir, missionId) {
  const file = chainPath(repoDir, missionId)
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  if (text.length === 0) return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

/** Parsed receipts in file order (no verification). */
export function readChain(repoDir, missionId) {
  return readLines(repoDir, missionId).map((l) => JSON.parse(l))
}

/**
 * Append one receipt and move the signed head anchor.
 *
 * @param {object} a
 * @param {string} a.repoDir
 * @param {{ privateKey: any, publicKey: any, home: string }} a.keys
 * @param {string} a.missionId
 * @param {string} a.kind one of KINDS
 * @param {string} a.verdict
 * @param {Record<string, unknown>} [a.subject] what the event was about (redacted before writing)
 * @param {Record<string, string>} [a.refs] receipt hashes of earlier receipts this one depends on
 * @param {number} [a.now]
 */
export function appendReceipt({ repoDir, keys, missionId, kind, verdict, subject = {}, refs = {}, now = Date.now() }) {
  if (!MISSION_RE.test(missionId)) throw new Error('invalid mission id')
  if (!KINDS.includes(kind)) throw new Error(`unknown receipt kind ${kind}`)
  if (!keys?.home) throw new Error('receipts need the operator key directory for the head anchor')
  const file = chainPath(repoDir, missionId)
  mkdirSync(path.dirname(file), { recursive: true })
  // Read, verify, append and move the head as one step, even with parallel writers.
  return withLock(`${file}.lock`, (stillHeld) => appendLocked({ repoDir, keys, missionId, kind, verdict, subject, refs, now, stillHeld }))
}

function appendLocked({ repoDir, keys, missionId, kind, verdict, subject, refs, now, stillHeld = () => true }) {
  // Refuse to extend a chain that does not verify: never paper over tampering.
  const check = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId })
  if (!check.ok) throw new Error(`receipt chain for ${missionId} does not verify: ${check.findings[0].problem}`)
  return writeReceipt({ repoDir, keys, missionId, kind, verdict, subject, refs, now, stillHeld })
}

const lockFileOf = (repoDir, missionId) => `${chainPath(repoDir, missionId)}.lock`

/** Lock files removed by recoverLock, kept next to the chain as evidence. */
function recoveredLocks(repoDir, missionId) {
  const dir = path.dirname(chainPath(repoDir, missionId))
  if (!existsSync(dir)) return []
  const prefix = path.basename(lockFileOf(repoDir, missionId)) + '.recovered-'
  return readdirSync(dir)
    .filter((n) => n.startsWith(prefix))
    .sort()
    .map((name) => ({ name, sha256: 'sha256:' + sha256Hex(readFileSync(path.join(dir, name))) }))
}

function unrecordedRecoveries(repoDir, missionId, receipts) {
  const recorded = new Set(receipts.filter((r) => r?.kind === 'lock_recovered').map((r) => `${r.subject?.kept_as} ${r.subject?.removed_sha256}`))
  return recoveredLocks(repoDir, missionId).filter((t) => !recorded.has(`${t.name} ${t.sha256}`))
}

/** Pending reanchor: its receipt is written, the anchor was not moved yet. */
function isPendingReanchor(receipts, hb) {
  const last = receipts.at(-1)
  if (last?.kind !== 'chain_reanchored' || last.verdict !== 'reanchored') return false
  const s = last.subject ?? {}
  if (s.previous_anchor_seq !== hb.seq || s.previous_anchor_hash !== hb.hash) return false
  if (!receipts[hb.seq] || receiptHash(receipts[hb.seq]) !== hb.hash) return false
  const between = receipts.slice(hb.seq + 1, -1).map((r) => r.seq)
  return Array.isArray(s.accepted_seqs) && canonicalJson(s.accepted_seqs) === canonicalJson(between)
}

function moveAnchor({ keys, missionId, repoDir, receipt, stillHeld }) {
  const head = { mission_id: missionId, seq: receipt.seq, hash: receiptHash(receipt) }
  const anchor = headPath(keys.home, missionId, repoDir)
  mkdirSync(path.dirname(anchor), { recursive: true, mode: 0o700 })
  if (!stillHeld()) throw new Error('lost the receipt chain lock after writing the receipt; anchor not moved, chain now fails verification until reanchored')
  // Write-then-rename so a reader never sees a half-written anchor.
  writeFileSync(`${anchor}.tmp-${process.pid}`, JSON.stringify({ ...head, signature: signValue(keys.privateKey, head) }) + '\n', { mode: 0o600 })
  renameSync(`${anchor}.tmp-${process.pid}`, anchor)
  return head.hash
}

/**
 * Explicit operator procedure for a lock the automatic rules never remove
 * (empty or unparseable content, another host, an unknown owner).
 *
 * 1. inspectChainLock() shows the lock's SHA-256, size and owner state.
 * 2. recoverLock() with that exact hash and a written reason removes it, but only
 *    if the content still has that hash and the owner is not a live local process.
 *    The removed file is kept as `<lock>.recovered-*`.
 * 3. A signed lock_recovered receipt records the removal.
 *
 * The kept file is the intent and the receipt is the commit: until every kept
 * file has a matching receipt, verifyChain reports LOCK_RECOVERY_UNRECORDED and the
 * hook denies. If the chain cannot take the receipt yet (for example the anchor is
 * behind because of the same crash), run reanchorChain, then recoverLock again
 * without a hash to record the pending removal.
 *
 * @returns {{ removed: { removed_sha256: string, kept_as: string } | null, recorded: string[], hashes: string[] }}
 */
export function recoverLock({ repoDir, keys, missionId, expectedSha256, reason, now = Date.now() }) {
  if (!MISSION_RE.test(missionId)) throw new Error('invalid mission id')
  if (typeof reason !== 'string' || reason.trim().length < 8) throw new Error('lock recovery needs a written reason')
  if (!keys?.privateKey || !keys?.home) throw new Error('lock recovery needs the operator key')
  const lockFile = lockFileOf(repoDir, missionId)
  let removed = null
  if (inspectLock(lockFile).exists) {
    if (typeof expectedSha256 !== 'string') throw new Error('lock exists: pass the sha256 shown by inspectChainLock')
    const r = removeInspectedLock(lockFile, expectedSha256)
    removed = { removed_sha256: r.removed_sha256, kept_as: path.basename(r.kept_as) }
  }
  return withLock(lockFile, (stillHeld) => {
    const v = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId })
    const blocking = v.findings.filter((f) => f.code !== 'LOCK_RECOVERY_UNRECORDED')
    if (blocking.length > 0) {
      const where = removed ? `lock removed and kept as ${removed.kept_as}; ` : ''
      throw new Error(`${where}receipt not written yet, chain does not verify: ${blocking.map((f) => f.problem).join('; ')}. Fix that (reanchorChain), then run recoverLock again.`)
    }
    const pending = unrecordedRecoveries(repoDir, missionId, v.receipts)
    if (pending.length === 0) throw new Error('no lock to recover')
    const hashes = []
    for (const t of pending) {
      const { receipt } = writeReceipt({
        repoDir,
        keys,
        missionId,
        kind: 'lock_recovered',
        verdict: 'recovered',
        subject: { removed_sha256: t.sha256, kept_as: t.name, reason },
        refs: {},
        now,
        stillHeld,
      })
      hashes.push(receiptHash(receipt))
    }
    return { removed, recorded: pending.map((t) => t.name), hashes }
  })
}

/** Read-only view of the chain lock for the operator. */
export const inspectChainLock = ({ repoDir, missionId }) => inspectLock(lockFileOf(repoDir, missionId))


/*
 * Crash window: the receipt line is appended first, the anchor moved second. A
 * crash in between leaves the anchor one receipt behind. verifyChain reports that,
 * every append (and so every gated tool call) is refused, and only an explicit
 * operator action (reanchorChain) moves the anchor forward. A crash during the
 * line write leaves a partial last line, which no automatic step accepts.
 */
function writeReceipt({ repoDir, keys, missionId, kind, verdict, subject, refs, now, stillHeld }) {
  const prior = readChain(repoDir, missionId)
  const prev = prior.at(-1)
  if (subject === undefined || subject === null) subject = {}
  const body = {
    version: 1,
    mission_id: missionId,
    seq: prior.length,
    prev_hash: prev ? receiptHash(prev) : genesisHash(missionId),
    kind,
    verdict,
    timestamp: new Date(now).toISOString(),
    subject: redactDeep(subject),
    refs,
    operator_pubkey: publicKeyHex(keys.publicKey),
  }
  const receipt = { ...body, signature: signValue(keys.privateKey, body) }
  const file = chainPath(repoDir, missionId)
  if (!stillHeld()) throw new Error('lost the receipt chain lock before writing; nothing written')
  appendFileSync(file, canonicalJson(receipt) + '\n', { mode: 0o600 })
  const hash = moveAnchor({ keys, missionId, repoDir, receipt, stillHeld })
  return { receipt, hash }
}

/**
 * @returns {{ ok: boolean, count: number, findings: { seq: number | null, problem: string }[], receipts: any[] }}
 */
export function verifyChain({ repoDir, home, publicKey, missionId }) {
  const findings = []
  const receipts = []
  const lines = readLines(repoDir, missionId)
  const pub = publicKeyHex(publicKey)
  let prevHash = genesisHash(missionId)

  lines.forEach((line, i) => {
    let r
    try {
      r = JSON.parse(line)
    } catch {
      findings.push({ seq: i, problem: 'line is not valid JSON' })
      prevHash = 'sha256:' + sha256Hex(line)
      return
    }
    receipts.push(r)
    const { signature, ...body } = r ?? {}
    if (canonicalJson(r) !== line) findings.push({ seq: i, problem: 'line is not in canonical form' })
    if (r?.version !== 1) findings.push({ seq: i, problem: 'unknown receipt version' })
    if (r?.mission_id !== missionId) findings.push({ seq: i, problem: 'receipt belongs to another mission' })
    if (r?.seq !== i) findings.push({ seq: i, problem: `sequence gap: expected ${i}, found ${r?.seq}` })
    if (r?.prev_hash !== prevHash) findings.push({ seq: i, problem: 'previous-hash link is broken' })
    if (r?.operator_pubkey !== pub) findings.push({ seq: i, problem: 'signed by a different key' })
    else if (!verifyValue(publicKey, body, signature)) findings.push({ seq: i, problem: 'signature does not verify' })
    prevHash = receiptHash(r)
  })

  // Head anchor: detects a chain that was cut off or replaced wholesale.
  const anchorFile = headPath(home, missionId, repoDir)
  if (existsSync(anchorFile)) {
    let head = null
    try {
      head = JSON.parse(readFileSync(anchorFile, 'utf8'))
    } catch {
      findings.push({ seq: null, problem: 'head anchor is unreadable' })
    }
    if (head) {
      const { signature, ...hb } = head
      if (!verifyValue(publicKey, hb, signature)) findings.push({ seq: null, problem: 'head anchor signature does not verify' })
      else if (hb.seq >= lines.length) {
        findings.push({ seq: null, code: 'ANCHOR_AHEAD', problem: `chain does not end at the anchored head: receipts after seq ${lines.length - 1} are missing (anchored seq ${hb.seq})` })
      } else if (hb.seq < lines.length - 1 && isPendingReanchor(receipts, hb)) {
        findings.push({ seq: null, code: 'REANCHOR_PENDING', problem: `reanchor was recorded (seq ${lines.length - 1}) but the anchor was not moved; complete it with an explicit reanchor` })
      } else if (hb.seq < lines.length - 1) {
        findings.push({ seq: null, code: 'ANCHOR_BEHIND', problem: `chain does not end at the anchored head: anchor at seq ${hb.seq} but chain has ${lines.length} receipts (interrupted append?); needs an explicit reanchor` })
      } else if (hb.hash !== prevHash) {
        findings.push({ seq: null, code: 'ANCHOR_MISMATCH', problem: 'chain does not end at the anchored head: last receipt differs from the anchored one' })
      }
    }
  } else if (lines.length > 0) {
    findings.push({ seq: null, problem: 'no head anchor for a non-empty chain' })
  }

  for (const t of unrecordedRecoveries(repoDir, missionId, receipts)) {
    findings.push({ seq: null, code: 'LOCK_RECOVERY_UNRECORDED', problem: `lock file ${t.name} was removed by recovery but no lock_recovered receipt records it; run recoverLock again` })
  }

  return { ok: findings.length === 0, count: lines.length, findings, receipts }
}

/**
 * Explicit operator recovery after an interrupted append (anchor behind the chain).
 *
 * Accepted only if the only problem is ANCHOR_BEHIND, the anchored receipt is the
 * one at that seq in the file, and every receipt after it is a correctly linked
 * receipt signed by this operator key. Anything else (anchor ahead, mismatch,
 * bad line, foreign signature) is refused. Unrecorded lock recoveries do not block
 * a reanchor; they are recorded afterwards by recoverLock.
 *
 * Order (intent, then commit): the signed chain_reanchored receipt is appended
 * first, naming the previous anchor (seq and hash) and the accepted receipts; the
 * anchor is moved to that receipt second. There is no moment where the chain
 * verifies without the receipt. A crash between the two steps leaves the anchor
 * behind with a matching chain_reanchored receipt at the end; verifyChain reports
 * REANCHOR_PENDING, the hook keeps denying, and calling reanchorChain again
 * completes it (moves the anchor only, writes no second receipt).
 *
 * @returns {{ accepted_seqs: number[], hash: string, completed_pending: boolean }}
 */
export function reanchorChain({ repoDir, keys, missionId, reason }) {
  if (typeof reason !== 'string' || reason.trim().length < 8) throw new Error('reanchor needs a written reason')
  const file = chainPath(repoDir, missionId)
  return withLock(`${file}.lock`, (stillHeld) => {
    const v = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId })
    const blocking = v.findings.filter((f) => f.code !== 'LOCK_RECOVERY_UNRECORDED')
    if (blocking.length === 0) throw new Error('chain anchor is current; nothing to reanchor')
    if (blocking.length === 1 && blocking[0].code === 'REANCHOR_PENDING') {
      const last = v.receipts.at(-1)
      const hash = moveAnchor({ keys, missionId, repoDir, receipt: last, stillHeld })
      return { accepted_seqs: last.subject.accepted_seqs, hash, completed_pending: true }
    }
    if (blocking.length !== 1 || blocking[0].code !== 'ANCHOR_BEHIND') {
      throw new Error(`reanchor refused: ${blocking.map((f) => f.problem).join('; ')}`)
    }
    const head = JSON.parse(readFileSync(headPath(keys.home, missionId, repoDir), 'utf8'))
    if (receiptHash(v.receipts[head.seq]) !== head.hash) throw new Error('reanchor refused: anchored receipt is not the one in the chain')
    const accepted = v.receipts.slice(head.seq + 1).map((r) => r.seq)
    // Intent first (signed receipt), commit second (anchor moves onto that receipt).
    const { hash } = writeReceipt({
      repoDir,
      keys,
      missionId,
      kind: 'chain_reanchored',
      verdict: 'reanchored',
      subject: { previous_anchor_seq: head.seq, previous_anchor_hash: head.hash, accepted_seqs: accepted, reason },
      refs: {},
      now: Date.now(),
      stillHeld,
    })
    return { accepted_seqs: accepted, hash, completed_pending: false }
  })
}

/** Latest receipt (and its hash) matching a predicate. */
export function findLast(receipts, predicate) {
  for (let i = receipts.length - 1; i >= 0; i--) {
    if (predicate(receipts[i])) return { receipt: receipts[i], hash: receiptHash(receipts[i]) }
  }
  return null
}
