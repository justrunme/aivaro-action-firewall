/**
 * Undo Mission (R4.3, R4.4, R4.6) followed by automatic recovery verification (R5.1).
 *
 * Restores in reverse capture order and keeps going when one resource fails,
 * collecting every result. Supported: files under allowed_paths, config files,
 * the named Postgres database. Container images are verified, not rebuilt.
 */

import path from 'node:path'
import { captureDir, loadManifest } from '../capture/capture.js'
import { restoreFiles } from '../capture/files.js'
import { restorePostgres } from '../capture/postgres.js'
import { verifyRecovery } from './verify.js'
import { appendReceipt, findLast, verifyChain } from '../receipts/chain.js'
import { hashValue } from '../util/canonical.js'
import { errorSummary } from '../privacy/redact.js'
import { appendEmergencyRecord } from './emergency.js'

export const SUPPORTED_RESOURCES = ['files', 'config_files', 'postgres', 'containers']

export class UndoRefused extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {object} a
 * @param {string} a.repoDir
 * @param {string} a.missionId
 * @param {string} a.captureId
 * @param {import('../rehearsal/compose.js').Target} a.target composeFile relative to repoDir
 * @param {{ privateKey: any, publicKey: any, home: string }} a.keys operator keys (receipts are signed)
 * @param {{ service: string, url: string } | null} [a.health]
 * @param {string[]} [a.resources] subset to restore; anything unsupported is refused
 */
/**
 * RECOVERED only when every resource was restored and the verification PASSed.
 * RESTORED_UNVERIFIED when everything was restored and nothing failed, but a required
 * check could not be made (UNVERIFIABLE): the operator gets the state back, not a claim.
 * @param {'PASS' | 'FAIL' | 'UNVERIFIABLE'} verification
 * @param {{ status: string }[]} results
 */
export function recoveryStatus(verification, results) {
  const restored = results.every((r) => r.status === 'succeeded')
  if (restored && verification === 'PASS') return 'RECOVERED'
  if (restored && verification === 'UNVERIFIABLE') return 'RESTORED_UNVERIFIED'
  return 'NOT_RECOVERED'
}

export async function undoMission({ repoDir, missionId, captureId, target, keys, health = null, resources, emergency = null }) {
  const publicKey = keys?.publicKey
  const unsupported = (resources ?? []).filter((r) => !SUPPORTED_RESOURCES.includes(r))
  if (unsupported.length > 0) throw new UndoRefused('UNSUPPORTED_RESOURCE', `undo is not supported for: ${unsupported.join(', ')}`)
  const { manifest, problem } = loadManifest(repoDir, missionId, captureId, publicKey)
  if (problem) throw new UndoRefused('CAPTURE_INVALID', problem)
  // Nothing is restored on a chain that could not record the undo and its verification,
  // except as an explicit break-glass recovery (emergency.js), and only when needed.
  const chain = verifyChain({ repoDir, home: keys.home, publicKey, missionId })
  if (emergency) {
    if (typeof emergency.reason !== 'string' || emergency.reason.trim().length < 8) throw new UndoRefused('EMERGENCY_REASON_REQUIRED', 'emergency recovery needs a written reason')
    if (chain.ok) throw new UndoRefused('EMERGENCY_NOT_NEEDED', 'the receipt chain verifies; use a normal undo')
  } else if (!chain.ok) {
    throw new UndoRefused('CHAIN_INVALID', `receipt chain does not verify: ${chain.findings[0].problem}; nothing was restored (break-glass: --emergency-recovery)`)
  }

  const real = { ...target, composeFile: path.resolve(repoDir, target.composeFile) }
  const dir = captureDir(repoDir, missionId, captureId)
  const wanted = (r) => !resources || resources.includes(r)
  const results = []

  for (const resource of [...manifest.order].reverse()) {
    if (!wanted(resource)) continue
    const started = Date.now()
    let result
    try {
      if (resource === 'config_files') {
        // Config files are inside the files capture; restoring them is part of 'files'.
        result = { status: 'succeeded', detail: `${manifest.config_files.length} file(s), restored with files` }
      } else if (resource === 'containers') {
        result = { status: 'succeeded', detail: 'verify only: images are compared during verification, containers are not rebuilt' }
      } else if (resource === 'postgres') {
        const outcomes = []
        for (const db of manifest.postgres) outcomes.push(await restorePostgres(real, db, path.join(dir, 'pg', `${db.name}.sql`)))
        const failed = outcomes.filter((o) => o.status !== 'succeeded')
        result = failed.length === 0
          ? { status: 'succeeded', detail: outcomes.map((o) => o.detail).join('; '), previous_databases: outcomes.map((o) => o.previous_database) }
          : { status: 'failed', detail: failed.map((o) => o.detail).join('; ') }
      } else if (resource === 'files') {
        const r = restoreFiles(repoDir, manifest.files, dir)
        result = { status: 'succeeded', detail: `restored ${r.restored.length}, removed ${r.removed.length}, unchanged ${r.unchanged}`, restored: r.restored, removed: r.removed }
      }
    } catch (err) {
      result = { status: 'failed', detail: String(err.message) }
    }
    results.push({ resource, ...result, duration_ms: Date.now() - started })
  }

  // The restore has happened: a verification that throws is a failed verification, not a lost result.
  let verification
  try {
    verification = await verifyRecovery({ repoDir, manifest, target: real, health })
  } catch (err) {
    const failed = [{ check: 'verification_error', resource: '(verification)', expected: 'completed', actual: errorSummary(err.message), ok: false }]
    verification = { status: 'FAIL', checks: failed, failed, integration_tests: null }
  }
  const status = recoveryStatus(verification.status, results)
  const outcome = {
    mission_id: missionId,
    capture_id: captureId,
    resources: results,
    restored_ok: results.every((r) => r.status === 'succeeded'),
    verification,
    status,
    evidence_status: emergency ? 'unverified' : 'recorded',
    receipts: { undo: null, verification: null },
  }

  if (emergency) {
    // Break-glass: evidence goes to the separate signed journal, never into the damaged chain.
    try {
      outcome.emergency_record = appendEmergencyRecord({
        repoDir,
        keys,
        missionId,
        record: {
          kind: 'emergency_undo',
          capture_id: captureId,
          manifest_hash: hashValue(manifest),
          reason: emergency.reason,
          chain_findings: chain.findings.slice(0, 5).map((f) => f.problem),
          resources: results.map((r) => ({ resource: r.resource, status: r.status, detail: r.detail })),
          verification: { status: verification.status, checks: verification.checks.length, failed: verification.failed.map((c) => ({ check: c.check, resource: c.resource })) },
          recovery_status: status,
        },
      }).hash
    } catch {
      outcome.receipt_error = 'JOURNAL_FAILED'
    }
    return outcome
  }

  // R4.5, R5.5, R5.6: signed undo receipt, then the verification receipt right after it.
  try {
    const run = findLast(chain.receipts, (r) => r.kind === 'run_result' && r.subject?.capture_id === captureId)
    outcome.receipts.undo = appendReceipt({
      repoDir,
      keys,
      missionId,
      kind: 'undo',
      verdict: 'undo',
      subject: { capture_id: captureId, manifest_hash: hashValue(manifest), resources: results.map((r) => ({ resource: r.resource, status: r.status, detail: r.detail })) },
      refs: run ? { run: run.hash } : {},
    }).hash
    outcome.receipts.verification = appendReceipt({
      repoDir,
      keys,
      missionId,
      kind: 'verification',
      verdict: verification.status,
      subject: {
        capture_id: captureId,
        checks: verification.checks.length,
        // Which kinds of check ran: without this list a reader cannot tell a full check from a partial one.
        checked: [...new Set(verification.checks.map((c) => c.check))].sort(),
        failed: verification.failed.map((c) => ({ check: c.check, resource: c.resource, expected: c.expected, actual: c.actual })),
        ...(verification.not_checked?.length ? { not_checked: verification.not_checked.map((c) => ({ check: c.check, resource: c.resource })) } : {}),
        integration_tests: verification.integration_tests,
        // What the checks covered next to what the capture holds (new receipts only; older ones lack it).
        ...(verification.coverage ? { coverage: verification.coverage } : {}),
      },
      refs: { undo: outcome.receipts.undo },
    }).hash
  } catch (err) {
    outcome.receipt_error = err.code === 'CHAIN_LOCKED' ? 'CHAIN_LOCKED' : 'CHAIN_INVALID'
  }
  return outcome
}
