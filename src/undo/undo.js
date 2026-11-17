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
import { appendReceipt, findLast, readChain } from '../receipts/chain.js'
import { hashValue } from '../util/canonical.js'

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
export async function undoMission({ repoDir, missionId, captureId, target, keys, health = null, resources }) {
  const publicKey = keys?.publicKey
  const unsupported = (resources ?? []).filter((r) => !SUPPORTED_RESOURCES.includes(r))
  if (unsupported.length > 0) throw new UndoRefused('UNSUPPORTED_RESOURCE', `undo is not supported for: ${unsupported.join(', ')}`)
  const { manifest, problem } = loadManifest(repoDir, missionId, captureId, publicKey)
  if (problem) throw new UndoRefused('CAPTURE_INVALID', problem)

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

  const verification = await verifyRecovery({ repoDir, manifest, target: real, health })

  // R4.5, R5.5, R5.6: signed undo receipt, then the verification receipt right after it.
  const run = findLast(readChain(repoDir, missionId), (r) => r.kind === 'run_result' && r.subject?.capture_id === captureId)
  const undoReceipt = appendReceipt({
    repoDir,
    keys,
    missionId,
    kind: 'undo',
    verdict: 'undo',
    subject: { capture_id: captureId, manifest_hash: hashValue(manifest), resources: results.map((r) => ({ resource: r.resource, status: r.status, detail: r.detail })) },
    refs: run ? { run: run.hash } : {},
  })
  const verificationReceipt = appendReceipt({
    repoDir,
    keys,
    missionId,
    kind: 'verification',
    verdict: verification.status,
    subject: {
      capture_id: captureId,
      checks: verification.checks.length,
      failed: verification.failed.map((c) => ({ check: c.check, resource: c.resource, expected: c.expected, actual: c.actual })),
      integration_tests: verification.integration_tests,
    },
    refs: { undo: undoReceipt.hash },
  })

  return {
    mission_id: missionId,
    capture_id: captureId,
    resources: results,
    restored_ok: results.every((r) => r.status === 'succeeded'),
    verification,
    status: verification.status === 'PASS' && results.every((r) => r.status === 'succeeded') ? 'RECOVERED' : 'NOT_RECOVERED',
    receipts: { undo: undoReceipt.hash, verification: verificationReceipt.hash },
  }
}
