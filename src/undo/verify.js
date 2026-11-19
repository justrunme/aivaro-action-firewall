/**
 * Recovery verification (R5.1 to R5.3, R5.5 to R5.7).
 *
 * Every check is computed from the live state and compared with the capture.
 * PASS only if every check passes and every required check could be made; a
 * restore tool's exit status is never used as evidence. Each failing check
 * carries expected and actual values.
 *
 * Status: FAIL when any check fails; UNVERIFIABLE when none fails but a required
 * check could not be made (a capture from before the value was recorded); PASS
 * otherwise. UNVERIFIABLE is never a recovery: the state may be restored, but
 * nothing shows that it is.
 */

import { measureDatabase } from '../rehearsal/measure.js'
import { httpStatusInService, imageDigests, psql } from '../rehearsal/compose.js'
import { verifyFiles } from '../capture/files.js'
import { diffPrivileges, measurePrivileges } from '../capture/privileges.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Exponential back-off, at most maxMs in total (R5.3). */
export async function pollHealth(target, health, maxMs = 30000) {
  const started = Date.now()
  let wait = 250
  let status = 0
  for (;;) {
    status = await httpStatusInService(target, health.service, health.url)
    if (status === 200 || Date.now() - started + wait > maxMs) return status
    await sleep(wait)
    wait = Math.min(wait * 2, 4000)
  }
}

/** What the privileges check covers; a PASS of it is no claim about anything else. */
export const PRIVILEGES_SCOPE = 'supported database grants and ownership (database, schemas, tables, views, sequences, columns, functions, default privileges); not RLS policies, role attributes or settings, database settings, types, domains or large objects'

/** @returns {'PASS' | 'FAIL' | 'UNVERIFIABLE'} */
export function verificationStatus(checks, notChecked) {
  if (checks.some((c) => !c.ok)) return 'FAIL'
  if (notChecked.length > 0) return 'UNVERIFIABLE'
  return 'PASS'
}

/**
 * @param {object} a
 * @param {string} a.repoDir
 * @param {any} a.manifest verified capture manifest
 * @param {import('../rehearsal/compose.js').Target} a.target real target, composeFile absolute
 * @param {{ service: string, url: string } | null} [a.health]
 */
export async function verifyRecovery({ repoDir, manifest, target, health = null }) {
  const checks = [...verifyFiles(repoDir, manifest.files)]
  // What this capture cannot be checked against (it was made before the value was recorded).
  const notChecked = []

  for (const db of manifest.postgres) {
    let live = null
    try {
      live = await measureDatabase((sql) => psql({ ...target, dbName: db.name }, { sql }))
    } catch (err) {
      checks.push({ check: 'postgres_reachable', resource: db.name, expected: 'reachable', actual: String(err.message), ok: false })
      continue
    }
    const want = db.measurement
    checks.push({ check: 'schema_hash', resource: db.name, expected: want.schema_hash, actual: live.schema_hash, ok: want.schema_hash === live.schema_hash })
    const tables = [...new Set([...Object.keys(want.tables), ...Object.keys(live.tables)])].sort()
    for (const t of tables) {
      const w = want.tables[t]
      const l = live.tables[t]
      checks.push({ check: 'row_count', resource: `${db.name}.${t}`, expected: w?.rows ?? null, actual: l?.rows ?? null, ok: (w?.rows ?? null) === (l?.rows ?? null) })
      checks.push({ check: 'table_checksum', resource: `${db.name}.${t}`, expected: w?.checksum ?? null, actual: l?.checksum ?? null, ok: (w?.checksum ?? null) === (l?.checksum ?? null) })
    }
    // Owners and grants: a restored database whose roles lost their rights is not recovered.
    if (db.privileges) {
      let livePriv = null
      try {
        livePriv = await measurePrivileges((sql) => psql({ ...target, dbName: db.name }, { sql }))
      } catch (err) {
        checks.push({ check: 'privileges', resource: db.name, scope: PRIVILEGES_SCOPE, expected: db.privileges.hash, actual: String(err.message), ok: false })
        continue
      }
      const d = diffPrivileges(db.privileges, livePriv)
      checks.push({ check: 'privileges', resource: db.name, scope: PRIVILEGES_SCOPE, expected: db.privileges.hash, actual: livePriv.hash, ok: db.privileges.hash === livePriv.hash, missing: d.missing.slice(0, 20), extra: d.extra.slice(0, 20) })
    } else {
      notChecked.push({ check: 'privileges', resource: db.name, why: 'the capture was made before privileges were recorded' })
    }
  }

  const images = await imageDigests(target)
  for (const [service, image] of Object.entries(manifest.containers.images)) {
    checks.push({ check: 'container_image', resource: service, expected: image, actual: images[service] ?? null, ok: images[service] === image })
  }

  if (health) {
    const status = await pollHealth(target, health)
    checks.push({ check: 'health', resource: `${health.service} ${health.url}`, expected: 200, actual: status, ok: status === 200 })
  }

  const failed = checks.filter((c) => !c.ok)
  return { status: verificationStatus(checks, notChecked), checks, failed, not_checked: notChecked, integration_tests: 'not configured' }
}
