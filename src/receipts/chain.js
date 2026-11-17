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

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256Hex } from '../util/canonical.js'
import { redactDeep } from '../privacy/redact.js'
import { STATE_DIR } from '../fidelity/source.js'
import { publicKeyHex, signValue, verifyValue } from './keys.js'
import { withLock } from './lock.js'

export const KINDS = ['rehearsal', 'authorization_issued', 'authorization_refused', 'run_result', 'run_refused', 'undo', 'verification', 'hook_decision']
const MISSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/

export const chainPath = (repoDir, missionId) => path.join(repoDir, STATE_DIR, 'missions', missionId, 'receipts.jsonl')
// One anchor per (workspace, mission): two workspaces may use the same mission id.
const headPath = (home, missionId, repoDir) => {
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
  return withLock(`${file}.lock`, () => appendLocked({ repoDir, keys, missionId, kind, verdict, subject, refs, now }))
}

function appendLocked({ repoDir, keys, missionId, kind, verdict, subject, refs, now }) {
  // Refuse to extend a chain that does not verify: never paper over tampering.
  const check = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId })
  if (!check.ok) throw new Error(`receipt chain for ${missionId} does not verify: ${check.findings[0].problem}`)
  const prior = readChain(repoDir, missionId)
  const prev = prior.at(-1)
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
  appendFileSync(file, canonicalJson(receipt) + '\n', { mode: 0o600 })
  const head = { mission_id: missionId, seq: receipt.seq, hash: receiptHash(receipt) }
  mkdirSync(path.dirname(headPath(keys.home, missionId, repoDir)), { recursive: true, mode: 0o700 })
  // Write-then-rename so a reader never sees a half-written anchor.
  const anchor = headPath(keys.home, missionId, repoDir)
  writeFileSync(`${anchor}.tmp-${process.pid}`, JSON.stringify({ ...head, signature: signValue(keys.privateKey, head) }) + '\n', { mode: 0o600 })
  renameSync(`${anchor}.tmp-${process.pid}`, anchor)
  return { receipt, hash: head.hash }
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
      else if (hb.seq !== lines.length - 1 || hb.hash !== prevHash) {
        findings.push({ seq: null, problem: `chain does not end at the anchored head (anchored seq ${hb.seq}, file has ${lines.length} receipts)` })
      }
    }
  } else if (lines.length > 0) {
    findings.push({ seq: null, problem: 'no head anchor for a non-empty chain' })
  }

  return { ok: findings.length === 0, count: lines.length, findings, receipts }
}

/** Latest receipt (and its hash) matching a predicate. */
export function findLast(receipts, predicate) {
  for (let i = receipts.length - 1; i >= 0; i--) {
    if (predicate(receipts[i])) return { receipt: receipts[i], hash: receiptHash(receipts[i]) }
  }
  return null
}
