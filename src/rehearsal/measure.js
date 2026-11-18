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
  return { schema_hash, columns, tables, logic: await measureLogic(exec) }
}

// Schemas that belong to Postgres itself.
const USER_SCHEMA = (col) => `${col} NOT IN ('pg_catalog', 'information_schema') AND ${col} NOT LIKE 'pg\\_toast%' AND ${col} NOT LIKE 'pg\\_temp%'`

/**
 * T25: database logic that runs when data changes, by definition. A trigger (with its
 * enabled state), a rule or a function whose body changes gets another hash under the
 * same name, so a change is seen even when every name stays. Definitions are hashed
 * inside the database (one line of output each) and their text is not stored.
 * Not covered: event triggers, functions installed by extensions, other databases.
 */
async function measureLogic(exec) {
  const triggers = await query(
    exec,
    'SELECT n.nspname, c.relname, t.tgname, md5(pg_get_triggerdef(t.oid) || \' enabled=\' || t.tgenabled::text) FROM pg_trigger t ' +
      'JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      `WHERE NOT t.tgisinternal AND ${USER_SCHEMA('n.nspname')} ORDER BY 1, 2, 3`
  )
  const functions = await query(
    exec,
    "SELECT n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(pg_get_functiondef(p.oid)) FROM pg_proc p " +
      'JOIN pg_namespace n ON n.oid = p.pronamespace ' +
      `WHERE p.prokind IN ('f', 'p') AND ${USER_SCHEMA('n.nspname')} ` +
      "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') ORDER BY 1, 2"
  )
  const rules = await query(exec, `SELECT schemaname, tablename, rulename, md5(definition) FROM pg_rules WHERE ${USER_SCHEMA('schemaname')} ORDER BY 1, 2, 3`)
  const out = { triggers: {}, functions: {}, rules: {} }
  for (const [s, t, name, h] of triggers) out.triggers[`${s}.${t}.${name}`] = 'md5:' + h
  for (const [s, sig, h] of functions) out.functions[`${s}.${sig}`] = 'md5:' + h
  for (const [s, t, name, h] of rules) out.rules[`${s}.${t}.${name}`] = 'md5:' + h
  return out
}

/**
 * What changed in the database logic between two measurements, by kind:
 * removed, changed (same name, other definition or enabled state) and added.
 * @returns {{ removed: string[], changed: string[], added: string[] }} entries like "trigger public.patches.x"
 */
export function logicDelta(before, after) {
  const out = { removed: [], changed: [], added: [] }
  for (const kind of ['triggers', 'functions', 'rules']) {
    const b = before?.[kind] ?? {}
    const a = after?.[kind] ?? {}
    const label = kind.slice(0, -1)
    for (const name of Object.keys(b).sort()) {
      if (!(name in a)) out.removed.push(`${label} ${name}`)
      else if (a[name] !== b[name]) out.changed.push(`${label} ${name}`)
    }
    for (const name of Object.keys(a).sort()) if (!(name in b)) out.added.push(`${label} ${name}`)
  }
  return out
}
