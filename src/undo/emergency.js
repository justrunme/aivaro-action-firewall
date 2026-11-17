/**
 * Break-glass recovery journal (operator decision on PR 10).
 *
 * When the mission's receipt chain does not verify, a normal undo is refused:
 * nothing may be restored without a record. An emergency recovery restores
 * anyway, but its evidence is written here and never into the damaged chain:
 *   - one file per mission and workspace in <JUSTRUNME_HOME>/emergency/, outside
 *     the workspace (the hook denies every agent access to that directory);
 *   - JSON lines, each signed with the operator key and linked to the previous
 *     line by hash, so a removed or edited entry is detectable;
 *   - every entry says evidence_status "unverified": it records what happened,
 *     it does not make the damaged chain trustworthy again.
 * Nothing here reads, repairs or reanchors the receipt chain.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson, hashValue, sha256Hex } from '../util/canonical.js'
import { redactDeep } from '../privacy/redact.js'
import { publicKeyHex, signValue, verifyValue } from '../receipts/keys.js'

export function emergencyJournalPath(home, missionId, repoDir) {
  let where = path.resolve(repoDir)
  try {
    where = realpathSync(where)
  } catch {
    // workspace missing: the resolved path still names the journal deterministically
  }
  return path.join(home, 'emergency', `${missionId}-${sha256Hex(where).slice(0, 16)}.jsonl`)
}

const genesis = (missionId) => 'sha256:' + sha256Hex(`justrunme:emergency:v1:${missionId}`)

function lines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

/** @returns {{ hash: string, entry: object }} */
export function appendEmergencyRecord({ repoDir, keys, missionId, record, now = Date.now() }) {
  const file = emergencyJournalPath(keys.home, missionId, repoDir)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const prior = lines(file)
  const body = {
    version: 1,
    mission_id: missionId,
    seq: prior.length,
    prev_hash: prior.length ? hashValue(JSON.parse(prior.at(-1))) : genesis(missionId),
    timestamp: new Date(now).toISOString(),
    evidence_status: 'unverified',
    ...redactDeep(record),
    operator_pubkey: publicKeyHex(keys.publicKey),
  }
  const entry = { ...body, signature: signValue(keys.privateKey, body) }
  appendFileSync(file, canonicalJson(entry) + '\n', { mode: 0o600 })
  return { hash: hashValue(entry), entry }
}

/** @returns {{ ok: boolean, count: number, findings: string[], entries: any[] }} */
export function verifyEmergencyJournal({ home, publicKey, missionId, repoDir }) {
  const findings = []
  const entries = []
  let prev = genesis(missionId)
  lines(emergencyJournalPath(home, missionId, repoDir)).forEach((line, i) => {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      findings.push(`entry ${i} is not valid JSON`)
      return
    }
    entries.push(e)
    const { signature, ...body } = e
    if (canonicalJson(e) !== line) findings.push(`entry ${i} is not in canonical form`)
    if (e.seq !== i) findings.push(`entry ${i}: sequence gap`)
    if (e.prev_hash !== prev) findings.push(`entry ${i}: previous-hash link is broken`)
    if (e.operator_pubkey !== publicKeyHex(publicKey) || !verifyValue(publicKey, body, signature)) findings.push(`entry ${i}: signature does not verify`)
    prev = hashValue(e)
  })
  return { ok: findings.length === 0, count: entries.length, findings, entries }
}
