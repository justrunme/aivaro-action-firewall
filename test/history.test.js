/**
 * T27.1 plan history: versions of a plan are archived by content and checked
 * against the signed chain; the story links an approval to the run of exactly the
 * approved SQL and to the measured result.
 */

import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendReceipt, verifyChain } from '../src/receipts/chain.js'
import { hashValue } from '../src/util/canonical.js'
import { archiveRehearsal, contentHash, historyDir, loadArchivedReport, loadArchivedSql, snapshotPlanFiles, verifyHistory } from '../src/history/archive.js'
import { buildStory } from '../src/history/story.js'
import { compareOutcome } from '../src/run/outcome.js'
import { loadOrCreateTestKeys } from './support/keys.js'

const MISSION = 'mission-history-test'
const PLAN = 'plan-0123456789ab'
const DANGER = 'CREATE TABLE orders_v2 AS SELECT id FROM orders WHERE quantity >= 10;\nDROP TABLE orders;\n'
const SAFE = "ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'new';\n"
const T0 = Date.parse('2026-11-18T12:00:00.000Z')
const dirs = []
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

let repoDir
let keys
beforeEach(() => {
  repoDir = tmp('jrm-history-')
  mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
  keys = loadOrCreateTestKeys(tmp('jrm-history-keys-'))
})
const chain = () => verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId: MISSION })
const plan = [{ id: 'm1', tool: 'sql_migration', args: ['demo/migrations/003.sql'], reversibility: true }]
const db = (rows, schema = 'sha256:' + 'a'.repeat(64)) => ({ schema_hash: schema, tables: { orders: { rows, checksum: String(rows) } } })

/** One rehearsed version the way the engine records it: archive first, then the receipt. */
function rehearseVersion(sql, verdict, { rowsAfter = 3, at = T0 } = {}) {
  const file = path.join(repoDir, 'demo/migrations/003.sql')
  writeFileSync(file, sql, { flag: 'w' })
  const snap = snapshotPlanFiles(plan, repoDir)
  const report = { plan_id: PLAN, verdict, base_hash: 'sha256:' + 'b'.repeat(64), plan_files: snap.files, tables: { orders: { protected: true, rows_before: 3, rows_after: rowsAfter, rows_lost: 3 - rowsAfter, content_changed: false } }, database: { after: db(rowsAfter) }, steps: [{ id: 'm1', status: 'ok' }], signature: 'x' }
  const reportHash = archiveRehearsal(repoDir, MISSION, report, snap.blobs)
  const r = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'rehearsal', verdict, subject: { plan_id: PLAN, report_hash: reportHash, base_hash: report.base_hash, files_hash: hashValue(snap.files) }, now: at })
  return { report, reportHash, files: snap.files, receipt: r.hash }
}

function approveAndRun(v, { matches = true, runFiles = v.files } = {}) {
  const req = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'approval_requested', verdict: 'pending', subject: { request_id: 'apr-00000000000000aa', plan_id: PLAN, report_hash: v.reportHash, files_hash: hashValue(v.files), expires_at: new Date(T0 + 3600 * 1000).toISOString() }, refs: { rehearsal: v.receipt }, now: T0 + 2000 })
  const auth = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'authorization_issued', verdict: 'allow', subject: { plan_id: PLAN, report_hash: v.reportHash, plan_files_hash: hashValue(v.files), passphrase_source: 'tty' }, refs: { rehearsal: v.receipt, approval: req.hash }, now: T0 + 3000 })
  appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'run_result', verdict: 'completed', subject: { plan_id: PLAN, capture_id: 'cap-20261118120000-abcdef', plan_files_hash: hashValue(runFiles), report_hash: v.reportHash, matches_rehearsal: matches, differences: matches ? 0 : 1 }, refs: { authorization: auth.hash }, now: T0 + 4000 })
}

describe('plan history archive (T27.1)', () => {
  it('keeps both versions of a plan that was edited and rehearsed again under the same id', () => {
    const a = rehearseVersion(DANGER, 'DATA LOSS', { rowsAfter: 2 })
    const b = rehearseVersion(SAFE, 'SAFE', { at: T0 + 1000 })
    assert.notEqual(a.reportHash, b.reportHash)
    assert.notEqual(a.files[0].sha256, b.files[0].sha256)
    assert.deepEqual([loadArchivedReport(repoDir, MISSION, a.reportHash).report.verdict, loadArchivedReport(repoDir, MISSION, b.reportHash).report.verdict], ['DATA LOSS', 'SAFE'])
    assert.equal(loadArchivedSql(repoDir, MISSION, a.files[0].sha256).sql, DANGER)
    assert.equal(loadArchivedSql(repoDir, MISSION, b.files[0].sha256).sql, SAFE)
    assert.equal(contentHash(Buffer.from(SAFE)), b.files[0].sha256)
    const v = verifyHistory(repoDir, MISSION, chain().receipts)
    assert.deepEqual([v.ok, v.versions, v.findings], [true, 2, []])
  })

  it('a deleted, edited or swapped archive file is reported against the receipt that names it', () => {
    const a = rehearseVersion(DANGER, 'DATA LOSS', { rowsAfter: 2 })
    const b = rehearseVersion(SAFE, 'SAFE', { at: T0 + 1000 })
    const reports = path.join(historyDir(repoDir, MISSION), 'reports')
    const sql = path.join(historyDir(repoDir, MISSION), 'sql')
    // Deleted: the original dangerous report.
    unlinkSync(path.join(reports, `${a.reportHash.slice(7)}.json`))
    // Edited: the SQL of the safe version (the file is read-only; an attacker with the OS user can still change it).
    const safeSql = path.join(sql, `${b.files[0].sha256.slice(7)}.sql`)
    chmodSync(safeSql, 0o644)
    writeFileSync(safeSql, 'DROP TABLE orders;\n')
    const v = verifyHistory(repoDir, MISSION, chain().receipts)
    assert.equal(v.ok, false)
    assert.deepEqual(v.findings.map((f) => [f.seq, f.code]).sort(), [[0, 'HISTORY_MISSING'], [1, 'HISTORY_TAMPERED']])
    // Swapped: a report put under another report's name does not hash to that name.
    const names = readdirSync(reports)
    writeFileSync(path.join(reports, `${a.reportHash.slice(7)}.json`), JSON.stringify(loadArchivedReport(repoDir, MISSION, b.reportHash).report))
    assert.equal(names.length, 1)
    assert.equal(loadArchivedReport(repoDir, MISSION, a.reportHash).problem, 'HISTORY_TAMPERED')
  })

  it('receipts written before plan history existed are counted, not failed', () => {
    appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'rehearsal', verdict: 'SAFE', subject: { plan_id: PLAN, report_hash: 'sha256:' + 'c'.repeat(64) }, now: T0 })
    const v = verifyHistory(repoDir, MISSION, chain().receipts)
    assert.deepEqual([v.ok, v.versions, v.legacy_versions], [true, 0, 1])
  })
})

describe('mission story (T27.1)', () => {
  it('Plan A denied, Plan B safe, B approved, exactly B executed, the result as rehearsed: every link holds', () => {
    const a = rehearseVersion(DANGER, 'DATA LOSS', { rowsAfter: 2 })
    const b = rehearseVersion(SAFE, 'SAFE', { at: T0 + 1000 })
    approveAndRun(b)
    const s = buildStory({ repoDir, missionId: MISSION, chain: chain(), now: T0 + 5000 })
    assert.deepEqual(s.versions.map((v) => [v.verdict, v.impact.rows_lost, v.files[0].sql]), [['DATA LOSS', 1, DANGER], ['SAFE', 0, SAFE]])
    assert.deepEqual(s.requests.map((q) => [q.state, q.report_hash, q.authorization.passphrase_source]), [['approved', b.reportHash, 'tty']])
    assert.deepEqual(s.runs.map((r) => [r.verdict, r.matches_rehearsal, r.request_id]), [['completed', true, 'apr-00000000000000aa']])
    assert.deepEqual(s.links[0].links.map((l) => [l.code, l.ok]), [['APPROVED_VERSION_SAFE', true], ['AUTHORIZED_AS_REQUESTED', true], ['EXECUTED_AS_AUTHORIZED', true], ['RESULT_AS_REHEARSED', true]])
    assert.equal(s.links[0].ok, true)
    assert.equal(s.history.ok, true)
    assert.notEqual(a.reportHash, b.reportHash)
  })

  it('a run of other files than the approved ones, or a result unlike the rehearsal, breaks the named link', () => {
    rehearseVersion(DANGER, 'DATA LOSS', { rowsAfter: 2 })
    const b = rehearseVersion(SAFE, 'SAFE', { at: T0 + 1000 })
    approveAndRun(b, { matches: false, runFiles: [{ path: 'demo/migrations/003.sql', sha256: contentHash(Buffer.from(DANGER)) }] })
    const s = buildStory({ repoDir, missionId: MISSION, chain: chain(), now: T0 + 5000 })
    const byCode = Object.fromEntries(s.links[0].links.map((l) => [l.code, l]))
    assert.equal(byCode.EXECUTED_AS_AUTHORIZED.ok, false)
    assert.equal(byCode.RESULT_AS_REHEARSED.ok, false)
    assert.match(byCode.RESULT_AS_REHEARSED.why, /1 difference/)
    assert.equal(s.links[0].ok, false)
  })

  it('an approval of a version that was not SAFE is reported', () => {
    const a = rehearseVersion(DANGER, 'DATA LOSS', { rowsAfter: 2 })
    approveAndRun(a)
    const s = buildStory({ repoDir, missionId: MISSION, chain: chain(), now: T0 + 5000 })
    const first = s.links[0].links[0]
    assert.deepEqual([first.code, first.ok, first.why], ['APPROVED_VERSION_SAFE', false, 'the approved version rehearsed DATA LOSS'])
  })
})

describe('run outcome against the rehearsal (T27.1)', () => {
  it('equal measurements match; a row, a checksum, a schema or a table difference is named', () => {
    assert.deepEqual(compareOutcome(db(3), db(3)), { matches: true, differences: [] })
    assert.equal(compareOutcome(db(3), db(2)).differences[0].table, 'orders')
    assert.equal(compareOutcome(db(3), db(3, 'sha256:' + 'f'.repeat(64))).differences[0].what, 'schema differs from the rehearsal')
    assert.equal(compareOutcome(db(3), { ...db(3), tables: { ...db(3).tables, extra: { rows: 0, checksum: '0' } } }).differences[0].what, 'not predicted by the rehearsal')
    assert.equal(compareOutcome(null, db(3)).matches, false)
  })
})
