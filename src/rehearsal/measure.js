/**
 * Measure a Postgres database (R2.3, R3.1): schema, row counts and a content
 * checksum per table. The checksum is md5 over all rows rendered as text and
 * sorted, so it does not depend on physical order and catches an UPDATE that
 * keeps the row count.
 */

import { sha256Hex } from '../util/canonical.js'

const quoteIdent = (name) => '"' + String(name).replace(/"/g, '""') + '"'

async function query(exec, sql) {
  const r = await exec(sql)
  if (r.code !== 0) throw new Error(`measurement query failed: ${r.stderr.trim().split('\n').slice(-1)[0]}`)
  return r.stdout.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t'))
}

/**
 * @param {(sql: string) => Promise<{ code: number, stdout: string, stderr: string }>} exec
 * @returns {Promise<{ schema_hash: string, columns: Record<string, string[]>, tables: Record<string, { rows: number, checksum: string }> }>}
 */
export async function measureDatabase(exec) {
  const cols = await query(
    exec,
    "SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default, '') FROM information_schema.columns " +
      "WHERE table_schema = 'public' ORDER BY table_name, ordinal_position"
  )
  const tableRows = await query(
    exec,
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
  )
  const columns = {}
  for (const [t] of tableRows) columns[t] = []
  for (const [t, c, type, nullable] of cols) if (columns[t]) columns[t].push(`${c} ${type}${nullable === 'NO' ? ' not null' : ''}`)

  const tables = {}
  for (const t of Object.keys(columns).sort()) {
    const [[count, checksum]] = await query(
      exec,
      `SELECT count(*), coalesce(md5(string_agg(r::text, E'\\n' ORDER BY r::text)), '') FROM ${quoteIdent(t)} r`
    )
    tables[t] = { rows: Number(count), checksum }
  }
  const schema_hash = 'sha256:' + sha256Hex(cols.map((c) => c.join('\t')).join('\n'))
  return { schema_hash, columns, tables }
}
