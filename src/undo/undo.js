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
 * @param {any} a.publicKey operator public key
 * @param {{ service: string, url: string } | null} [a.health]
 * @param {string[]} [a.resources] subset to restore; anything unsupported is refused
 */
export async function undoMission({ repoDir, missionId, captureId, target, publicKey, health = null, resources }) {
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
  return {
    mission_id: missionId,
    capture_id: captureId,
    resources: results,
    restored_ok: results.every((r) => r.status === 'succeeded'),
    verification,
    status: verification.status === 'PASS' && results.every((r) => r.status === 'succeeded') ? 'RECOVERED' : 'NOT_RECOVERED',
  }
}
