/**
 * Plan history (T27.1): every rehearsed version of a plan stays readable after
 * the SQL files are edited and the plan is rehearsed again under the same id.
 *
 * The archive is content-addressed and written once:
 *   .justrunme/missions/<mission>/history/reports/<report hash>.json  (the signed report)
 *   .justrunme/missions/<mission>/history/sql/<sha256>.sql            (SQL text by content)
 *
 * The archive is not the record; the signed receipt chain is. Every `rehearsal`
 * receipt names its report hash, every report (signed) names the SHA-256 of each
 * SQL file. `verifyHistory` walks the verified chain and checks that each version
 * it names is present and unchanged. A deleted or edited archive file cannot be
 * prevented by this code (it is a folder on disk; the hook keeps the agent out of
 * `.justrunme` while the gate is on); it is detected: HISTORY_MISSING or
 * HISTORY_TAMPERED, naming the receipt.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { STATE_DIR } from '../fidelity/source.js'
import { hashValue } from '../util/canonical.js'

const HASH_RE = /^sha256:[0-9a-f]{64}$/

export const historyDir = (repoDir, missionId) => path.join(repoDir, STATE_DIR, 'missions', missionId, 'history')
const reportFile = (repoDir, missionId, hash) => path.join(historyDir(repoDir, missionId), 'reports', `${hash.slice(7)}.json`)
const sqlFile = (repoDir, missionId, hash) => path.join(historyDir(repoDir, missionId), 'sql', `${hash.slice(7)}.sql`)

export const contentHash = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

/** Write once: an existing file with the same name already holds the same content (its name is its hash). */
function writeOnce(file, bytes) {
  if (existsSync(file)) return
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, bytes, { mode: 0o444 })
  renameSync(tmp, file)
}

/**
 * The SQL files of a plan as they are now: path and content hash, plus the bytes
 * for archiving. A file that cannot be read gets `sha256: null` (the rehearsal then
 * fails on that step and the report says so).
 * @returns {{ files: { path: string, sha256: string | null }[], blobs: Map<string, Buffer> }}
 */
export function snapshotPlanFiles(plan, repoDir) {
  const files = []
  const blobs = new Map()
  for (const step of plan) {
    if (step.tool !== 'sql_migration') continue
    let bytes = null
    try {
      bytes = readFileSync(path.join(repoDir, step.args[0]))
    } catch {
      // reported as unreadable
    }
    const sha256 = bytes ? contentHash(bytes) : null
    if (bytes) blobs.set(sha256, bytes)
    files.push({ path: step.args[0], sha256 })
  }
  return { files, blobs }
}

/** Archive a signed report and the SQL it was rehearsed with. Returns the report hash. */
export function archiveRehearsal(repoDir, missionId, signedReport, blobs) {
  const hash = hashValue(signedReport)
  for (const [sha, bytes] of blobs) writeOnce(sqlFile(repoDir, missionId, sha), bytes)
  writeOnce(reportFile(repoDir, missionId, hash), JSON.stringify(signedReport, null, 2) + '\n')
  return hash
}

/**
 * One archived report, accepted only if its content hashes to the name it is filed
 * under (the hash a receipt names).
 * @returns {{ report: any | null, problem: string | null }}
 */
export function loadArchivedReport(repoDir, missionId, hash) {
  if (!HASH_RE.test(hash ?? '')) return { report: null, problem: 'HISTORY_INVALID' }
  const file = reportFile(repoDir, missionId, hash)
  if (!existsSync(file)) return { report: null, problem: 'HISTORY_MISSING' }
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'))
    return hashValue(report) === hash ? { report, problem: null } : { report: null, problem: 'HISTORY_TAMPERED' }
  } catch {
    return { report: null, problem: 'HISTORY_TAMPERED' }
  }
}

/** The archived SQL text with this content hash, or a problem. */
export function loadArchivedSql(repoDir, missionId, hash) {
  if (!HASH_RE.test(hash ?? '')) return { sql: null, problem: 'HISTORY_INVALID' }
  const file = sqlFile(repoDir, missionId, hash)
  if (!existsSync(file)) return { sql: null, problem: 'HISTORY_MISSING' }
  const bytes = readFileSync(file)
  return contentHash(bytes) === hash ? { sql: bytes.toString('utf8'), problem: null } : { sql: null, problem: 'HISTORY_TAMPERED' }
}

/**
 * Check every version the chain names. `receipts` must come from a chain that
 * verified (signatures, links, anchor); this function adds the archive side.
 * @returns {{ ok: boolean, versions: number, legacy_versions: number, findings: { seq: number, code: string, what: string }[] }}
 */
export function verifyHistory(repoDir, missionId, receipts) {
  const findings = []
  let versions = 0
  let legacy = 0
  for (const r of receipts) {
    if (r.kind !== 'rehearsal') continue
    // Receipts written before plan history existed name no file list and have no archived copy.
    if (r.subject?.files_hash === undefined) {
      legacy += 1
      continue
    }
    versions += 1
    const hash = r.subject?.report_hash
    const { report, problem } = loadArchivedReport(repoDir, missionId, hash)
    if (problem) {
      findings.push({ seq: r.seq, code: problem, what: `report ${hash}` })
      continue
    }
    if (!Array.isArray(report.plan_files) || r.subject.files_hash !== hashValue(report.plan_files)) {
      findings.push({ seq: r.seq, code: 'HISTORY_TAMPERED', what: 'file list differs from the receipt' })
      continue
    }
    for (const f of report.plan_files) {
      if (f.sha256 === null) continue
      const sql = loadArchivedSql(repoDir, missionId, f.sha256)
      if (sql.problem) findings.push({ seq: r.seq, code: sql.problem, what: `${f.path} ${f.sha256}` })
    }
  }
  return { ok: findings.length === 0, versions, legacy_versions: legacy, findings }
}
