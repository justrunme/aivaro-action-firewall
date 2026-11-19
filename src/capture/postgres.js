/**
 * Postgres capture and restore (R4.1, R4.3, R4.4).
 *
 * Capture: plain-SQL pg_dump to a file (mode 0600) plus its SHA-256, a
 * measurement of the database at that moment, and its privileges (owners and
 * access lists, src/capture/privileges.js). The dump keeps GRANT and REVOKE
 * statements; ownership is not dumped, so objects belong to the loading user.
 *
 * Restore never edits the live database in place:
 *   1. check the dump against its recorded SHA-256
 *   2. load it into a fresh scratch database
 *   3. measure the scratch database and require it to equal the capture, then
 *      give it the captured database-level grants (a dump of one database does
 *      not carry them)
 *   4. only then swap: live -> <db>_jrm_prev_<t>, scratch -> <db>
 * A failure in steps 1 to 3 leaves the live database untouched, and the dump
 * file is never deleted, so the operator can retry.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { sha256Hex } from '../util/canonical.js'
import { dump, psql, withDatabase } from '../rehearsal/compose.js'
import { measureDatabase } from '../rehearsal/measure.js'
import { compareFingerprints } from '../fidelity/gate.js'
import { databaseGrantSql, measurePrivileges } from './privileges.js'

const ident = (n) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(n)) throw new Error(`unsafe database name: ${n}`)
  return `"${n}"`
}
const lit = (n) => `'${n.replace(/'/g, "''")}'`

export async function capturePostgres(target, file) {
  // Grants and revokes are kept: without them an undo would hand back a database whose
  // roles lost their rights (and PUBLIC regained what was revoked from it).
  const sql = await dump(target, { privileges: true })
  writeFileSync(file, sql, { mode: 0o600 })
  const exec = (q) => psql(target, { sql: q })
  const measurement = await measureDatabase(exec)
  const privileges = await measurePrivileges(exec)
  return { name: target.dbName, sha256: 'sha256:' + sha256Hex(sql), measurement, privileges }
}

async function admin(target, sql) {
  const r = await psql(withDatabase(target, 'postgres'), { sql })
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').slice(-1)[0])
}

/**
 * @param {import('../rehearsal/compose.js').Target} target
 * @param {{ name: string, sha256: string, measurement: any, privileges?: any }} captured
 * @param {string} file dump path
 * @param {() => number} [clock]
 * @returns {Promise<{ status: 'succeeded' | 'failed', detail: string, previous_database?: string }>}
 */
export async function restorePostgres(target, captured, file, clock = Date.now) {
  const db = captured.name
  const scratch = `${db}_jrm_restore`
  const previous = `${db}_jrm_prev_${clock().toString(36)}`
  ident(db)
  ident(scratch)
  ident(previous)

  let sql
  try {
    sql = readFileSync(file)
  } catch {
    return { status: 'failed', detail: 'captured dump is missing' }
  }
  if ('sha256:' + sha256Hex(sql) !== captured.sha256) return { status: 'failed', detail: 'captured dump does not match its checksum; live database untouched' }

  try {
    await admin(target, `DROP DATABASE IF EXISTS ${ident(scratch)} WITH (FORCE)`)
    await admin(target, `CREATE DATABASE ${ident(scratch)}`)
    const load = await psql(withDatabase(target, scratch), { input: sql, singleTransaction: true })
    if (load.code !== 0) throw new Error(`loading the dump failed: ${load.stderr.trim().split('\n').slice(-1)[0]}`)
    const measured = await measureDatabase((q) => psql(withDatabase(target, scratch), { sql: q }))
    const diff = compareFingerprints(captured.measurement, measured)
    if (!diff.ok) throw new Error(`restored copy differs from the capture in ${diff.diffs.map((d) => d.component).join(', ')}`)
    // Captures made before privileges were recorded have no database grants to set.
    if (captured.privileges?.database) await admin(target, databaseGrantSql(ident(scratch), captured.privileges.database, target.dbUser))
  } catch (err) {
    await admin(target, `DROP DATABASE IF EXISTS ${ident(scratch)} WITH (FORCE)`).catch(() => {})
    return { status: 'failed', detail: `${err.message}; live database untouched` }
  }

  // Swap. Connections to the live database are refused and closed first.
  try {
    await admin(target, `ALTER DATABASE ${ident(db)} WITH ALLOW_CONNECTIONS false`)
    await admin(target, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${lit(db)} AND pid <> pg_backend_pid()`)
    await admin(target, `ALTER DATABASE ${ident(db)} RENAME TO ${ident(previous)}`)
  } catch (err) {
    await admin(target, `ALTER DATABASE ${ident(db)} WITH ALLOW_CONNECTIONS true`).catch(() => {})
    await admin(target, `DROP DATABASE IF EXISTS ${ident(scratch)} WITH (FORCE)`).catch(() => {})
    return { status: 'failed', detail: `could not take the live database offline: ${err.message}; live database untouched` }
  }
  try {
    await admin(target, `ALTER DATABASE ${ident(scratch)} RENAME TO ${ident(db)}`)
  } catch (err) {
    // Put the previous database back so the service keeps its data.
    await admin(target, `ALTER DATABASE ${ident(previous)} RENAME TO ${ident(db)}`).catch(() => {})
    await admin(target, `ALTER DATABASE ${ident(db)} WITH ALLOW_CONNECTIONS true`).catch(() => {})
    return { status: 'failed', detail: `swap failed and was rolled back: ${err.message}` }
  }
  return { status: 'succeeded', detail: 'restored from capture', previous_database: previous }
}
