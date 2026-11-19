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

// Schemas that belong to Postgres itself, and the schema of JustRunMe's rehearsal
// observers (src/rehearsal/observe.js), which exists only in a rehearsal copy.
export const OBSERVER_SCHEMA = 'jrm_observe'
const USER_SCHEMA = (col) => `${col} NOT IN ('pg_catalog', 'information_schema', '${OBSERVER_SCHEMA}') AND ${col} NOT LIKE 'pg\\_toast%' AND ${col} NOT LIKE 'pg\\_temp%'`

/**
 * T25: database logic that runs when data changes, by definition. A trigger (with its
 * enabled state), a rule or a function whose body changes gets another hash under the
 * same name, so a change is seen even when every name stays. Definitions are hashed
 * inside the database and their text is not stored. Each kind comes back as one jsonb
 * array (escaped, one line), and names are quote_ident-ed, so a name that holds a dot,
 * a tab or a newline can neither collide with another object nor inject a line.
 *
 * What this compares is the state before and after the plan. Not seen:
 *   - logic switched off and on again inside the plan (DISABLE / ENABLE TRIGGER), or
 *     skipped with session_replication_role: the end state is unchanged;
 *   - internal triggers (foreign-key enforcement), event triggers, extension functions;
 *   - row-level security policies, grants on functions, constraints other than columns,
 *     role or database settings (search_path, session_replication_role);
 *   - a new function that shadows another through search_path (shown as added, SAFE);
 *   - other databases of the server.
 */
async function measureLogic(exec) {
  const one = async (sql) => {
    const rows = await query(exec, sql)
    return JSON.parse(rows[0]?.[0] || '[]')
  }
  const triggers = await one(
    "SELECT coalesce(jsonb_agg(jsonb_build_array(quote_ident(n.nspname) || '.' || quote_ident(c.relname) || '.' || quote_ident(t.tgname), " +
      "md5(pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text)) ORDER BY n.nspname, c.relname, t.tgname), '[]')::text FROM pg_trigger t " +
      'JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      `WHERE NOT t.tgisinternal AND ${USER_SCHEMA('n.nspname')} ` +
      `AND t.tgfoid NOT IN (SELECT p.oid FROM pg_proc p JOIN pg_namespace pn ON pn.oid = p.pronamespace WHERE pn.nspname = '${OBSERVER_SCHEMA}')`
  )
  const functions = await one(
    "SELECT coalesce(jsonb_agg(jsonb_build_array(quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')', " +
      "md5(pg_get_functiondef(p.oid))) ORDER BY n.nspname, p.proname, p.oid), '[]')::text FROM pg_proc p " +
      'JOIN pg_namespace n ON n.oid = p.pronamespace ' +
      `WHERE p.prokind IN ('f', 'p') AND ${USER_SCHEMA('n.nspname')} ` +
      "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')"
  )
  const rules = await one(
    "SELECT coalesce(jsonb_agg(jsonb_build_array(quote_ident(schemaname) || '.' || quote_ident(tablename) || '.' || quote_ident(rulename), md5(definition)) " +
      `ORDER BY schemaname, tablename, rulename), '[]')::text FROM pg_rules WHERE ${USER_SCHEMA('schemaname')}`
  )
  // T25 v2: constraints by definition, validation and deferrability (NOT VALID, DEFERRABLE).
  const constraints = await one(
    "SELECT coalesce(jsonb_agg(jsonb_build_array(quote_ident(n.nspname) || '.' || quote_ident(c.relname) || '.' || quote_ident(k.conname), " +
      "md5(pg_get_constraintdef(k.oid) || ' validated=' || k.convalidated::text || ' deferrable=' || k.condeferrable::text || ' deferred=' || k.condeferred::text)) " +
      "ORDER BY n.nspname, c.relname, k.conname), '[]')::text FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
      `WHERE ${USER_SCHEMA('n.nspname')}`
  )
  const out = { triggers: {}, functions: {}, rules: {}, constraints: {} }
  const put = (map, list) => {
    for (const [name, h] of list) {
      // Two objects with one key (only possible through odd argument text): never let the second hide the first.
      map[name] = name in map ? `${map[name]}+md5:${h}` : 'md5:' + h
    }
  }
  put(out.triggers, triggers)
  put(out.functions, functions)
  put(out.rules, rules)
  put(out.constraints, constraints)
  return out
}

/**
 * What changed in the database logic between two measurements, by kind:
 * removed, changed (same name, other definition or enabled state) and added.
 * @returns {{ removed: string[], changed: string[], added: string[] }} entries like "trigger public.patches.x"
 */
export function logicDelta(before, after) {
  const out = { removed: [], changed: [], added: [] }
  for (const kind of ['triggers', 'functions', 'rules', 'constraints']) {
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
