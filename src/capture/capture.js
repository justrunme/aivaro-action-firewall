/**
 * Pre-run capture (R4.1, R4.2): files, Postgres and container images, written to
 * .justrunme/missions/<mission>/captures/<capture_id>/ with a manifest signed by
 * the operator key. Any failure aborts the capture and therefore the real run.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { STATE_DIR } from '../fidelity/source.js'
import { imageDigests } from '../rehearsal/compose.js'
import { publicKeyHex, signValue, verifyValue } from '../receipts/keys.js'
import { captureFiles } from './files.js'
import { capturePostgres } from './postgres.js'

export const captureDir = (repoDir, missionId, captureId) => path.join(repoDir, STATE_DIR, 'missions', missionId, 'captures', captureId)

/**
 * @param {object} a
 * @param {string} a.repoDir
 * @param {any} a.contract
 * @param {import('../rehearsal/compose.js').Target} a.target real target, composeFile absolute
 * @param {{ privateKey: any, publicKey: any }} a.keys
 * @param {number} [a.now]
 */
export async function captureState({ repoDir, contract, target, keys, now = Date.now() }) {
  const captureId = `cap-${new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`
  const dir = captureDir(repoDir, contract.id, captureId)
  mkdirSync(path.join(dir, 'pg'), { recursive: true, mode: 0o700 })
  const manifest = {
    version: 1,
    mission_id: contract.id,
    capture_id: captureId,
    captured_at: new Date(now).toISOString(),
    // Restore order is the reverse of this list (R4.3).
    order: ['files', 'postgres', 'containers', 'config_files'],
    files: captureFiles(repoDir, contract, dir),
    postgres: [await capturePostgres(target, path.join(dir, 'pg', `${target.dbName}.sql`))],
    containers: { project: target.project, images: await imageDigests(target), restore: 'verify_only' },
    config_files: contract.resources.config_files,
    operator_pubkey: publicKeyHex(keys.publicKey),
  }
  const signed = { ...manifest, signature: signValue(keys.privateKey, manifest) }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(signed, null, 2) + '\n', { mode: 0o600 })
  return signed
}

/** @returns {{ manifest: any, problem: string | null }} */
export function loadManifest(repoDir, missionId, captureId, publicKey) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path.join(captureDir(repoDir, missionId, captureId), 'manifest.json'), 'utf8'))
  } catch {
    return { manifest: null, problem: 'capture manifest is missing or unreadable' }
  }
  const { signature, ...body } = manifest
  if (body.operator_pubkey !== publicKeyHex(publicKey) || !verifyValue(publicKey, body, signature)) {
    return { manifest: null, problem: 'capture manifest signature is invalid' }
  }
  return { manifest, problem: null }
}
