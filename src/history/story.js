/**
 * The mission story (T27.1), built from the verified receipt chain and the plan
 * history archive only: every rehearsed version with its signed measurements and
 * its SQL, the approval requests, the authorizations, the real runs and undos.
 *
 * Links are checked, not assumed:
 *   APPROVED_VERSION_SAFE   the request names a version whose rehearsal was SAFE
 *   AUTHORIZED_AS_REQUESTED the authorization answers that request with the same files
 *   EXECUTED_AS_AUTHORIZED  the run used that authorization and those files
 *   RESULT_AS_REHEARSED     the run's measured result equals the rehearsal's prediction
 * A link that does not hold is reported with `ok: false` and why; the Console shows it.
 */

import { hashValue } from '../util/canonical.js'
import { receiptHash } from '../receipts/chain.js'
import { loadArchivedReport, loadArchivedSql, verifyHistory } from './archive.js'

const MAX_SQL = 20000

function versionOf(repoDir, missionId, r) {
  const { report, problem } = loadArchivedReport(repoDir, missionId, r.subject?.report_hash)
  const base = { seq: r.seq, receipt: receiptHash(r), at: r.timestamp, plan_id: r.subject?.plan_id, verdict: r.verdict, report_hash: r.subject?.report_hash, base_hash: r.subject?.base_hash, duration_ms: r.subject?.duration_ms ?? null }
  if (problem) return { ...base, available: false, problem }
  const files = (report.plan_files ?? []).map((f) => {
    const sql = f.sha256 ? loadArchivedSql(repoDir, missionId, f.sha256) : { sql: null, problem: 'UNREADABLE_AT_REHEARSAL' }
    return { path: f.path, sha256: f.sha256, sql: sql.sql === null ? null : sql.sql.length > MAX_SQL ? sql.sql.slice(0, MAX_SQL) + '\n-- (cut)' : sql.sql, problem: sql.problem }
  })
  const tables = Object.fromEntries(Object.entries(report.tables ?? {}).map(([t, v]) => [t, { protected: v.protected === true, rows_before: v.rows_before, rows_after: v.rows_after, rows_lost: v.rows_lost, content_changed: v.content_changed }]))
  return {
    ...base,
    available: true,
    files,
    files_hash: Array.isArray(report.plan_files) ? hashValue(report.plan_files) : null,
    impact: {
      rows_lost: Object.values(tables).filter((v) => v.protected).reduce((n, v) => n + (v.rows_lost ?? 0), 0),
      tables,
      schema_delta: report.schema_delta ?? null,
      failed_steps: (report.steps ?? []).filter((s) => s.status !== 'ok' && s.status !== 'skipped_needs_approval').map((s) => s.id),
      evidence: (report.evidence ?? []).map((e) => ({ kind: e.kind, table: e.table ?? null, column: e.column ?? null })),
    },
  }
}

const link = (code, ok, why) => ({ code, ok, ...(ok ? {} : { why }) })

/**
 * @param {{ repoDir: string, missionId: string, chain: { ok: boolean, receipts: any[], findings: any[] }, now?: number }} a
 */
/**
 * The undo of a run and what its verification receipt says it checked. Receipts written before
 * the list of checks existed are 'legacy': which checks ran is unknown, never assumed complete.
 */
function undoOf(undo, verification) {
  const subject = verification?.subject ?? {}
  const current = Array.isArray(subject.checked)
  return {
    seq: undo.seq,
    verdict: undo.verdict,
    verification: verification?.verdict ?? null,
    receipt_format: verification ? (current ? 'current' : 'legacy') : null,
    checked: current ? subject.checked : null,
    not_checked: Array.isArray(subject.not_checked) ? subject.not_checked.map((c) => ({ check: c.check, resource: c.resource })) : [],
  }
}

export function buildStory({ repoDir, missionId, chain, now = Date.now() }) {
  if (!chain.ok) return { mission_id: missionId, chain_ok: false, chain_findings: chain.findings, versions: [], requests: [], runs: [], links: [], timeline: [], history: null }
  const receipts = chain.receipts
  const byHash = new Map(receipts.map((r) => [receiptHash(r), r]))
  const versions = receipts.filter((r) => r.kind === 'rehearsal').map((r) => versionOf(repoDir, missionId, r))
  const versionByReport = new Map(versions.map((v) => [v.report_hash, v]))

  const requests = receipts
    .filter((r) => r.kind === 'approval_requested')
    .map((r) => {
      const hash = receiptHash(r)
      const auth = receipts.find((x) => x.kind === 'authorization_issued' && x.refs?.approval === hash)
      const denial = receipts.find((x) => x.kind === 'approval_denied' && x.refs?.approval === hash)
      const state = auth ? 'approved' : denial ? 'denied' : now > Date.parse(r.subject?.expires_at) ? 'expired' : 'pending'
      return {
        seq: r.seq,
        receipt: hash,
        request_id: r.subject?.request_id,
        plan_id: r.subject?.plan_id,
        report_hash: r.subject?.report_hash,
        files_hash: r.subject?.files_hash,
        at: r.timestamp,
        state,
        denial_reason: denial?.subject?.reason ?? null,
        authorization: auth
          ? { seq: auth.seq, receipt: receiptHash(auth), at: auth.timestamp, plan_files_hash: auth.subject?.plan_files_hash ?? null, passphrase_source: auth.subject?.passphrase_source ?? null, approver_pubkey: auth.subject?.approver_pubkey ?? null }
          : null,
      }
    })

  const runs = receipts
    .filter((r) => r.kind === 'run_result')
    .map((r) => {
      const auth = byHash.get(r.refs?.authorization)
      const request = requests.find((q) => q.authorization?.receipt === r.refs?.authorization) ?? null
      const undo = receipts.find((x) => x.kind === 'undo' && x.refs?.run === receiptHash(r))
      const verification = undo ? receipts.find((x) => x.kind === 'verification' && x.refs?.undo === receiptHash(undo)) : null
      return {
        seq: r.seq,
        receipt: receiptHash(r),
        at: r.timestamp,
        plan_id: r.subject?.plan_id,
        verdict: r.verdict,
        capture_id: r.subject?.capture_id,
        plan_files_hash: r.subject?.plan_files_hash ?? null,
        report_hash: r.subject?.report_hash ?? null,
        matches_rehearsal: r.subject?.matches_rehearsal ?? null,
        differences: r.subject?.differences ?? null,
        authorization: auth ? receiptHash(auth) : null,
        request_id: request?.request_id ?? null,
        undo: undo ? undoOf(undo, verification) : null,
      }
    })

  // Links of every approved request that led to a run.
  const links = []
  for (const q of requests.filter((x) => x.state === 'approved')) {
    const v = versionByReport.get(q.report_hash)
    const run = runs.find((x) => x.request_id === q.request_id)
    const chainLinks = [
      link('APPROVED_VERSION_SAFE', v?.verdict === 'SAFE', v ? `the approved version rehearsed ${v.verdict}` : 'the approved version is not in the chain'),
      link('AUTHORIZED_AS_REQUESTED', q.authorization?.plan_files_hash != null && q.authorization.plan_files_hash === q.files_hash && (!v?.files_hash || v.files_hash === q.files_hash), 'the authorization does not bind the files that were requested'),
    ]
    if (run) {
      chainLinks.push(link('EXECUTED_AS_AUTHORIZED', run.plan_files_hash != null && run.plan_files_hash === q.authorization.plan_files_hash && run.report_hash === q.report_hash, 'the run names other files or another report than the approval'))
      chainLinks.push(link('RESULT_AS_REHEARSED', run.matches_rehearsal === true, run.matches_rehearsal === null ? 'the run recorded no comparison' : `${run.differences} difference(s) from the rehearsal`))
    }
    links.push({ request_id: q.request_id, plan_id: q.plan_id, run: run?.receipt ?? null, links: chainLinks, ok: chainLinks.every((l) => l.ok) })
  }

  // Every receipt in order, without its subject: what happened, when, and the hash to look it up by.
  const timeline = receipts.map((r) => ({ seq: r.seq, kind: r.kind, verdict: r.verdict, at: r.timestamp, hash: receiptHash(r) }))
  return { mission_id: missionId, chain_ok: true, chain_findings: [], versions, requests, runs, links, timeline, history: verifyHistory(repoDir, missionId, receipts) }
}
