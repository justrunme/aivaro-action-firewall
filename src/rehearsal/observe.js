/**
 * LOGIC BYPASS detection (T25 v2, Step 2). Observers that JustRunMe installs in the
 * rehearsal copy, as the owner role, before the plan runs; the plan never installs or
 * reaches them (its role has no rights on the observer schema, and with a plan role
 * that is not superuser it cannot change settings, triggers or event triggers).
 *
 *   1. Fire counter. For every user trigger on a protected table, a watcher trigger
 *      with the same timing, events and WHEN condition, ENABLE ALWAYS (so replica mode
 *      does not stop it), counts how often the protected trigger should have fired.
 *      track_functions = all counts how often its function did run. Fewer runs than
 *      expected is a bypass, also when the trigger was switched off and on again
 *      inside the plan.
 *   2. Event trigger on ddl_command_start: DDL the plan executed (it records only DDL
 *      that committed; a refused DDL is seen through the server log).
 *   3. Server log (log_statement = all): the statements the plan sent and the errors it
 *      got, between two markers. A permission error of the plan is an attempt, even
 *      when the statement text hides it (dynamic SQL in a DO block).
 *   4. Observer state: watcher triggers, event trigger and settings must be the same
 *      after the plan as before; otherwise the result is UNVERIFIABLE.
 *   5. Delete audit (T25 v3): ENABLE ALWAYS triggers on every protected table record each
 *      row the plan deletes, so a row deleted and inserted again inside the plan (same row
 *      count at the end) is still seen: AFTER DELETE per row; BEFORE TRUNCATE, which
 *      records the rows about to go; and AFTER UPDATE, which records the old key when it
 *      changes (a row renamed away, deleted under its new key and inserted again under the
 *      old one would otherwise leave no trace): of the primary-key columns, or for a table
 *      without a primary key of the whole row text. Only rows that existed before the plan
 *      count: their keys (the primary key, or the whole row text for a table without one)
 *      are recorded before it runs.
 *      Limit: keys are compared as text; the audit function runs in the plan's session, so a
 *      plan that changes DateStyle, TimeZone, extra_float_digits or bytea_output could make
 *      the text of a date, timestamp, float or bytea key differ from the recorded one. The
 *      v3 scenario's keys are integers.
 *
 * The catalog diff (triggers with enabled state, functions, rules, constraints) is in
 * measure.js. A plan that runs as a superuser can switch observers off; then the
 * observer state check fails and the verdict is UNVERIFIABLE, never SAFE.
 */

import { randomBytes } from 'node:crypto'
import { OBSERVER_SCHEMA } from './measure.js'
import { codeOnly } from './sqltext.js'

const S = OBSERVER_SCHEMA
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'"
const quoteIdentSql = (name) => '"' + String(name).replace(/"/g, '""') + '"'
/** Quoted primary key columns of a public table, in key order ('' when it has none). */
async function pkColumns(exec, t) {
  return (await rows(exec, `SELECT coalesce(string_agg(quote_ident(a.attname), ',' ORDER BY array_position(i.indkey::int2[], a.attnum)), '') FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = ${lit('public.' + quoteIdentSql(t))}::regclass AND i.indisprimary`))[0]?.[0] ?? ''
}
const keysTable = (t) => `${S}.${quoteIdentSql('keys_' + t)}`

export const OBSERVER_SETTINGS = { log_statement: 'all', track_functions: 'all', log_min_error_statement: 'error' }

/**
 * pg_reload_conf() only signals; wait until a new connection sees the settings
 * (review S1), or fail closed.
 */
export async function waitForSettings(exec, wanted, timeoutMs = 10000) {
  const names = Object.keys(wanted)
  const started = Date.now()
  for (;;) {
    const got = await one(exec, `SELECT jsonb_object_agg(name, setting)::text FROM pg_settings WHERE name IN (${names.map(lit).join(', ')})`)
    if (names.every((n) => got?.[n] === wanted[n])) return
    if (Date.now() - started > timeoutMs) throw new Error(`server settings did not take effect: ${JSON.stringify(got)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function rows(exec, sql) {
  const r = await exec(sql)
  if (r.code !== 0) throw new Error(`observer query failed: ${String(r.stderr).trim().split('\n').slice(-1)[0]}`)
  return r.stdout.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t'))
}
const one = async (exec, sql) => JSON.parse((await rows(exec, sql))[0]?.[0] || 'null')

// ---- Plan role -------------------------------------------------------------------

/**
 * What a role may do in this database, from the catalog. `restricted` is the A2 rule:
 * not superuser, no role or database creation, no replication, no RLS bypass, member of
 * no role, owner of nothing, no CREATE on any user schema.
 */
export async function planRoleOf(exec, role) {
  const r = lit(role)
  const d = await one(
    exec,
    `SELECT jsonb_build_object(
      'name', ${r},
      'exists', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${r}),
      'attributes', (SELECT jsonb_build_object('superuser', rolsuper, 'createrole', rolcreaterole, 'createdb', rolcreatedb, 'replication', rolreplication, 'bypassrls', rolbypassrls, 'login', rolcanlogin, 'inherit', rolinherit) FROM pg_roles WHERE rolname = ${r}),
      'role_settings', (SELECT coalesce(jsonb_agg(array_to_string(s.setconfig, ',') ORDER BY array_to_string(s.setconfig, ',')), '[]') FROM pg_db_role_setting s JOIN pg_roles u ON u.oid = s.setrole WHERE u.rolname = ${r}),
      'database', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${r}) THEN jsonb_build_object('create', has_database_privilege(${r}, current_database(), 'CREATE'), 'temp', has_database_privilege(${r}, current_database(), 'TEMP'), 'connect', has_database_privilege(${r}, current_database(), 'CONNECT')) ELSE NULL END,
      'columns', (SELECT coalesce(jsonb_object_agg(n.nspname || '.' || c.relname || '.' || a.attname, (SELECT jsonb_agg(p ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p WHERE has_column_privilege(${r}, c.oid, a.attnum, p))), '{}') FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema', '${S}') AND n.nspname NOT LIKE 'pg\\_%'),
      'sequences', (SELECT coalesce(jsonb_object_agg(n.nspname || '.' || c.relname, (SELECT jsonb_agg(p ORDER BY p) FROM unnest(ARRAY['USAGE','SELECT','UPDATE']) p WHERE has_sequence_privilege(${r}, c.oid, p))), '{}') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema', '${S}') AND n.nspname NOT LIKE 'pg\\_%'),
      'row_security', (SELECT coalesce(jsonb_object_agg(n.nspname || '.' || c.relname, jsonb_build_object('enabled', c.relrowsecurity, 'forced', c.relforcerowsecurity, 'policies', (SELECT md5(coalesce(string_agg(polname::text || ':' || polcmd::text || ':' || polpermissive::text || ':' || coalesce(pg_get_expr(polqual, polrelid), '') || ':' || coalesce(pg_get_expr(polwithcheck, polrelid), ''), ';' ORDER BY polname), '')) FROM pg_policy WHERE polrelid = c.oid))), '{}') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema', '${S}') AND n.nspname NOT LIKE 'pg\\_%'),
      'default_acl', (SELECT count(*) FROM pg_default_acl),
      'member_of', (SELECT coalesce(jsonb_agg(g.rolname ORDER BY g.rolname), '[]') FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = ${r}),
      'owns', (SELECT count(*) FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner WHERE o.rolname = ${r}) + (SELECT count(*) FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner WHERE o.rolname = ${r}) + (SELECT count(*) FROM pg_namespace n JOIN pg_roles o ON o.oid = n.nspowner WHERE o.rolname = ${r}),
      'schemas', (SELECT coalesce(jsonb_object_agg(nspname, jsonb_build_object('usage', has_schema_privilege(${r}, oid, 'USAGE'), 'create', has_schema_privilege(${r}, oid, 'CREATE'))), '{}') FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema', '${S}') AND nspname NOT LIKE 'pg\\_%'),
      'tables', (SELECT coalesce(jsonb_object_agg(n.nspname || '.' || c.relname, (SELECT jsonb_agg(p ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege(${r}, c.oid, p))), '{}') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema', '${S}') AND n.nspname NOT LIKE 'pg\\_%'),
      'functions', (SELECT coalesce(jsonb_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ORDER BY n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'), '[]') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', '${S}') AND n.nspname NOT LIKE 'pg\\_%' AND has_function_privilege(${r}, p.oid, 'EXECUTE')),
      'observer_schema_usage', CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '${S}') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${r}) THEN has_schema_privilege(${r}, '${S}', 'USAGE') ELSE false END
    )::text`
  )
  if (!d.exists) return { ...d, restricted: false, problems: ['the plan role does not exist'] }
  const a = d.attributes
  const problems = []
  for (const k of ['superuser', 'createrole', 'createdb', 'replication', 'bypassrls']) if (a[k]) problems.push(`the plan role has ${k}`)
  if (d.member_of.length > 0) problems.push(`the plan role is a member of ${d.member_of.join(', ')}`)
  if (d.owns > 0) problems.push(`the plan role owns ${d.owns} object(s)`)
  for (const [n, p] of Object.entries(d.schemas)) if (p.create) problems.push(`the plan role may create objects in schema ${n}`)
  if (d.observer_schema_usage) problems.push('the plan role can reach the observer schema')
  // Role-level settings (search_path, session_replication_role, ...) are not in a dump; the copy could not reproduce them.
  if (d.role_settings.length > 0) problems.push(`the plan role has role-level settings (${d.role_settings.join('; ').slice(0, 200)})`)
  if (d.database?.create) problems.push('the plan role may create schemas in the database')
  return { ...d, restricted: problems.length === 0, problems }
}

/** SQL that creates the role in a rehearsal copy with the same attributes (grants come with the dump). */
export function createRoleSql(desc) {
  const a = desc.attributes
  const flag = (on, name) => (on ? name : 'NO' + name)
  return `CREATE ROLE "${desc.name.replace(/"/g, '""')}" ${a.login ? 'LOGIN' : 'NOLOGIN'} ${flag(a.superuser, 'SUPERUSER')} ${flag(a.createrole, 'CREATEROLE')} ${flag(a.createdb, 'CREATEDB')} ${flag(a.replication, 'REPLICATION')} ${flag(a.bypassrls, 'BYPASSRLS')} ${flag(a.inherit !== false, 'INHERIT')};\n`
}

/** The parts of a role description that must be equal in the copy and for real. */
const COMPARABLE = ['attributes', 'member_of', 'owns', 'schemas', 'tables', 'functions', 'role_settings', 'database', 'columns', 'sequences', 'row_security', 'default_acl']
export const comparableRole = (d) => Object.fromEntries(COMPARABLE.map((k) => [k, d?.[k] ?? null]))

// ---- Observers -------------------------------------------------------------------

/**
 * Install the observers in the rehearsal copy (as the owner). Returns what was installed.
 * @param {(sql: string) => Promise<{ code: number, stdout: string, stderr: string }>} exec owner connection, one statement
 * @param {(input: string) => Promise<{ code: number, stdout: string, stderr: string }>} script owner connection, a script on stdin
 *   (statement by statement: ALTER SYSTEM cannot run inside the implicit transaction of `psql -c`)
 * @param {{ protectedTables: string[], planRole?: string | null }} a
 */
export async function installObservers(exec, script, { protectedTables, planRole = null }) {
  // Review B2: observers that came with a dump (grading observers on the real database)
  // are removed first; CASCADE takes their watcher triggers and the event trigger with them.
  const setup = `
DROP EVENT TRIGGER IF EXISTS jrm_observe_ddl;
DROP SCHEMA IF EXISTS ${S} CASCADE;
CREATE SCHEMA ${S};
REVOKE ALL ON SCHEMA ${S} FROM PUBLIC;
CREATE TABLE ${S}.expected (trigger_name TEXT NOT NULL);
CREATE TABLE ${S}.ddl (tag TEXT, role TEXT, query TEXT);
CREATE TABLE ${S}.deleted (tbl TEXT NOT NULL, k TEXT, op TEXT NOT NULL);
CREATE FUNCTION ${S}.count_expected() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  INSERT INTO ${S}.expected VALUES (TG_ARGV[0]);
  -- A watcher never changes or cancels a row: a BEFORE ROW trigger returns it as it is.
  IF TG_LEVEL = 'ROW' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_LEVEL = 'ROW' THEN RETURN NEW; END IF;
  RETURN NULL;
END
$f$;
CREATE FUNCTION ${S}.on_ddl() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  INSERT INTO ${S}.ddl VALUES (TG_TAG, session_user, left(current_query(), 2000));
END
$f$;
CREATE EVENT TRIGGER jrm_observe_ddl ON ddl_command_start EXECUTE FUNCTION ${S}.on_ddl();
REVOKE ALL ON ALL TABLES IN SCHEMA ${S} FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${S} FROM PUBLIC;
ALTER SYSTEM SET log_statement = 'all';
ALTER SYSTEM SET log_min_error_statement = 'error';
ALTER SYSTEM SET track_functions = 'all';
SELECT pg_reload_conf();
`
  const r = await script(setup)
  if (r.code !== 0) throw new Error(`installing the rehearsal observers failed: ${String(r.stderr).trim().split('\n').slice(-1)[0]}`)
  await waitForSettings(exec, OBSERVER_SETTINGS)

  // Review S7: the primary keys of protected rows before the plan, so a row deleted and
  // inserted again (same count) is still seen as lost.
  const keyed = {}
  for (const t of protectedTables) {
    const exists = (await rows(exec, `SELECT to_regclass(${lit('public.' + quoteIdentSql(t))}) IS NOT NULL`))[0]?.[0] === 't'
    if (!exists) continue
    const pk = await pkColumns(exec, t)
    // No primary key: the delete audit identifies a row by its whole text; keyed (missingKeys) stays primary keys only.
    const k = await exec(`CREATE TABLE ${keysTable(t)} AS SELECT ${pk ? `(${pk})::text` : 'jrm_row::text'} AS k FROM public.${quoteIdentSql(t)} jrm_row`)
    if (k.code !== 0) throw new Error(`recording the keys of ${t} failed: ${String(k.stderr).trim().split('\n').slice(-1)[0]}`)
    if (pk) keyed[t] = pk
  }

  // Watchers for user triggers on protected tables.
  const list = protectedTables.length === 0 ? [] : await one(
    exec,
    `SELECT coalesce(jsonb_agg(jsonb_build_object('trigger', n.nspname || '.' || c.relname || '.' || t.tgname, 'name', t.tgname, 'def', pg_get_triggerdef(t.oid), 'function', fn.nspname || '.' || p.proname, 'foid', p.oid::text) ORDER BY t.tgname), '[]')::text
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace fn ON fn.oid = p.pronamespace
     WHERE NOT t.tgisinternal AND fn.nspname <> '${S}' AND (
       (n.nspname = 'public' AND c.relname IN (${protectedTables.map(lit).join(', ')}))
       -- Review S4a: a function shared with a trigger elsewhere is counted for every trigger that uses it.
       OR t.tgfoid IN (SELECT t2.tgfoid FROM pg_trigger t2 JOIN pg_class c2 ON c2.oid = t2.tgrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                       WHERE NOT t2.tgisinternal AND n2.nspname = 'public' AND c2.relname IN (${protectedTables.map(lit).join(', ')})))`
  )
  const watchers = []
  for (const [i, w] of list.entries()) {
    // CREATE [CONSTRAINT] TRIGGER <name> <timing> <events> ON <table> ... EXECUTE FUNCTION <f>(<args>)
    const m = /^CREATE (?:CONSTRAINT )?TRIGGER (?:"(?:[^"]|"")+"|\S+) (.*) EXECUTE (?:FUNCTION|PROCEDURE) .*$/s.exec(w.def)
    // The table as pg_get_triggerdef writes it (schema-qualified, quoted when needed).
    const on = m ? /\bON ((?:"(?:[^"]|"")+"|[^\s".]+)\.(?:"(?:[^"]|"")+"|[^\s".]+))(?= FOR | REFERENCING | FROM | NOT | DEFERRABLE | INITIALLY |$)/.exec(m[1]) : null
    if (!m || !on) throw new Error(`cannot watch trigger ${w.trigger}`)
    const watch = `jrm_watch_${i}_${randomBytes(3).toString('hex')}`
    const table = on[1]
    const sql = `CREATE TRIGGER ${watch} ${m[1]} EXECUTE FUNCTION ${S}.count_expected(${lit(w.trigger)});\nALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${watch};\n`
    const c = await script(sql)
    if (c.code !== 0) throw new Error(`watching trigger ${w.trigger} failed: ${String(c.stderr).trim().split('\n').slice(-1)[0]}`)
    // Timing, event and level as pg_get_triggerdef writes them (BEFORE|AFTER|INSTEAD OF <events> ON <table> FOR EACH ROW|STATEMENT ...).
    const parts = /^(BEFORE|AFTER|INSTEAD OF) (.+?) ON (\S+?)(?: (?:FROM|REFERENCING|FOR EACH|WHEN|NOT DEFERRABLE|DEFERRABLE|INITIALLY)\b.*)?$/s.exec(m[1])
    const level = /\bFOR EACH (ROW|STATEMENT)\b/.exec(m[1])?.[1] ?? 'STATEMENT'
    watchers.push({ trigger: w.trigger, function: w.function, foid: w.foid, watch, name: w.name, table: table.replace(/"/g, ''), timing: parts?.[1] ?? null, event: parts?.[2] ?? null, level })
  }
  // T25 v3: the delete audit on every protected table that exists. Created after the dump is
  // loaded, as the owner; the function runs with the owner's rights, so the plan role needs
  // no access to the observer schema.
  const audited = {}
  let n = 0
  for (const t of protectedTables) {
    const exists = (await rows(exec, `SELECT to_regclass(${lit('public.' + quoteIdentSql(t))}) IS NOT NULL`))[0]?.[0] === 't'
    if (!exists) continue
    const pk = keyed[t] ?? ''
    const cols = pk ? pk.split(',') : []
    const oldKey = pk ? `(${cols.map((c) => `OLD.${c}`).join(',')})::text` : 'OLD::text'
    const newKey = pk ? `(${cols.map((c) => `NEW.${c}`).join(',')})::text` : null
    const rowKey = pk ? `(${pk})::text` : 'jrm_row::text'
    const tbl = `public.${quoteIdentSql(t)}`
    const sql = `CREATE FUNCTION ${S}.audit_del_${n}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO ${S}.deleted SELECT ${lit(t)}, ${rowKey}, 'DELETE' FROM ${tbl} jrm_row;
    RETURN NULL;
  END IF;
${pk ? `  IF TG_OP = 'UPDATE' THEN
    IF ${oldKey} IS DISTINCT FROM ${newKey} THEN INSERT INTO ${S}.deleted VALUES (${lit(t)}, ${oldKey}, 'DELETE'); END IF;
    RETURN NEW;
  END IF;
` : `  IF TG_OP = 'UPDATE' THEN
    IF OLD::text IS DISTINCT FROM NEW::text THEN INSERT INTO ${S}.deleted VALUES (${lit(t)}, OLD::text, 'DELETE'); END IF;
    RETURN NEW;
  END IF;
`}  INSERT INTO ${S}.deleted VALUES (${lit(t)}, ${oldKey}, 'DELETE');
  RETURN OLD;
END
$f$;
CREATE TRIGGER jrm_watch_del_${n} AFTER DELETE ON ${tbl} FOR EACH ROW EXECUTE FUNCTION ${S}.audit_del_${n}();
CREATE TRIGGER jrm_watch_trunc_${n} BEFORE TRUNCATE ON ${tbl} FOR EACH STATEMENT EXECUTE FUNCTION ${S}.audit_del_${n}();
ALTER TABLE ${tbl} ENABLE ALWAYS TRIGGER jrm_watch_del_${n};
ALTER TABLE ${tbl} ENABLE ALWAYS TRIGGER jrm_watch_trunc_${n};
CREATE TRIGGER jrm_watch_upd_${n} AFTER UPDATE ${pk ? `OF ${pk} ` : ''}ON ${tbl} FOR EACH ROW EXECUTE FUNCTION ${S}.audit_del_${n}();
ALTER TABLE ${tbl} ENABLE ALWAYS TRIGGER jrm_watch_upd_${n};
REVOKE ALL ON FUNCTION ${S}.audit_del_${n}() FROM PUBLIC;
`
    const c = await script(sql)
    if (c.code !== 0) throw new Error(`auditing deletes on ${t} failed: ${String(c.stderr).trim().split('\n').slice(-1)[0]}`)
    audited[t] = { pk, oid: (await rows(exec, `SELECT ${lit('public.' + quoteIdentSql(t))}::regclass::oid`))[0]?.[0] }
    n++
  }
  // The event trigger saw the observers' own DDL; only the plan's counts.
  const clear = await exec(`DELETE FROM ${S}.ddl`)
  if (clear.code !== 0) throw new Error('clearing the observer log failed')
  const state = await observerState(exec)
  return { watchers, state, plan_role: planRole, keyed, audited }
}

/**
 * Rows of protected tables that the plan deleted, whether or not they were inserted again:
 * { table: n }. A row counts once, when its key (primary key, or the whole row text for a
 * table without one) was recorded before the plan: a row the plan inserted and then
 * deleted does not count. Rows removed by TRUNCATE and rows whose primary key the plan
 * changed count as deleted.
 */
export async function deletedRows(exec, audited) {
  const out = {}
  for (const [t, a] of Object.entries(audited ?? {})) {
    // The table the plan started with is gone (dropped, possibly replaced by another of the
    // same name): DROP fires no row trigger, so every row it had counts as deleted.
    const oid = (await rows(exec, `SELECT coalesce(to_regclass(${lit('public.' + quoteIdentSql(t))})::oid::text, '')`))[0]?.[0] ?? ''
    const n = oid !== a.oid
      ? Number((await rows(exec, `SELECT count(DISTINCT k) FROM ${keysTable(t)}`))[0]?.[0] ?? 0)
      : Number((await rows(exec, `SELECT count(DISTINCT d.k) FROM ${S}.deleted d WHERE d.tbl = ${lit(t)} AND d.k IN (SELECT k FROM ${keysTable(t)})`))[0]?.[0] ?? 0)
    if (n > 0) out[t] = n
  }
  return out
}

/** Protected rows whose primary key was there before the plan and is gone after it: { table: n }. */
export async function missingKeys(exec, keyed) {
  const out = {}
  for (const [t, pk] of Object.entries(keyed ?? {})) {
    const exists = (await rows(exec, `SELECT to_regclass(${lit('public.' + quoteIdentSql(t))}) IS NOT NULL`))[0]?.[0] === 't'
    const n = exists
      ? Number((await rows(exec, `SELECT count(*) FROM ${keysTable(t)} k WHERE NOT EXISTS (SELECT 1 FROM public.${quoteIdentSql(t)} x WHERE (${pk.split(',').map((c) => `x.${c}`).join(',')})::text = k.k)`))[0]?.[0] ?? 0)
      : Number((await rows(exec, `SELECT count(*) FROM ${keysTable(t)}`))[0]?.[0] ?? 0)
    if (n > 0) out[t] = n
  }
  return out
}

/** Everything a plan could switch off to blind the observers. */
export async function observerState(exec) {
  return one(
    exec,
    `SELECT jsonb_build_object(
      'event_trigger', (SELECT evtenabled::text FROM pg_event_trigger WHERE evtname = 'jrm_observe_ddl'),
      'watchers', (SELECT coalesce(jsonb_object_agg(tgname, tgenabled::text), '{}') FROM pg_trigger WHERE tgname LIKE 'jrm\\_watch\\_%' AND tgname NOT SIMILAR TO 'jrm\\_watch\\_(del|trunc|upd)\\_[0-9]+'),
      -- T25 v3: the delete audit, with its table (a plan that drops a protected table drops these too; that is DATA LOSS, not a switch-off).
      'audit', (SELECT coalesce(jsonb_object_agg(t.tgname, t.tgrelid::text || ':' || t.tgenabled::text), '{}') FROM pg_trigger t WHERE t.tgname SIMILAR TO 'jrm\\_watch\\_(del|trunc|upd)\\_[0-9]+'),
      'tables', (SELECT coalesce(jsonb_agg(c.oid::text ORDER BY c.oid), '[]') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')),
      'settings', (SELECT jsonb_object_agg(name, setting) FROM pg_settings WHERE name IN ('log_statement', 'track_functions', 'log_min_error_statement')),
      'functions', (SELECT coalesce(jsonb_object_agg(p.proname, md5(pg_get_functiondef(p.oid))), '{}') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${S}')
    )::text`
  )
}

/** Calls of each watched function so far (track_functions = pl). */
export async function functionCalls(exec, watchers) {
  if (watchers.length === 0) return {}
  const ids = [...new Set(watchers.map((w) => w.foid))]
  const got = await one(exec, `SELECT coalesce(jsonb_object_agg(funcid::text, calls), '{}')::text FROM pg_stat_user_functions WHERE funcid IN (${ids.join(', ')})`)
  return Object.fromEntries(ids.map((id) => [id, Number(got[id] ?? 0)]))
}

/**
 * User triggers on protected tables that fired during the plan, for the DATA LOSS report:
 * name, table, timing, event, level and how many times. Facts from the observers and the
 * catalog only; no definition, no function name, no condition.
 * @returns {{ trigger: string, table: string, timing: string | null, event: string | null, level: string, fired: number }[]}
 */
export function firedTriggers({ installed, expected, callsBefore, callsAfter }) {
  const out = []
  for (const w of installed.watchers) {
    const times = expected[w.trigger] ?? 0
    const ran = (callsAfter[w.foid] ?? 0) - (callsBefore[w.foid] ?? 0)
    if (times > 0 && ran > 0) out.push({ trigger: w.name, table: w.table, timing: w.timing, event: w.event, level: w.level, fired: times })
  }
  return out
}

/** A unique statement written to the server log; the plan's records lie between two. */
export async function logMarker(exec) {
  const m = `jrm-marker-${randomBytes(8).toString('hex')}`
  const r = await exec(`SELECT ${lit(m)}`)
  if (r.code !== 0) throw new Error('writing a log marker failed')
  return m
}

// ---- Reading what happened -----------------------------------------------------------

const RECORD = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? \S+ \[\d+\] (LOG|ERROR|STATEMENT|DETAIL|HINT|WARNING|NOTICE|FATAL|CONTEXT):\s+(.*)$/

/**
 * Server log records between two markers: [{ level, text }]. Continuation lines are
 * joined to their record. Records of the marker statements themselves are dropped.
 */
export function recordsBetween(log, start, end) {
  const lines = String(log).split('\n')
  const out = []
  let inside = false
  for (const line of lines) {
    const m = RECORD.exec(line)
    if (m) {
      if (m[2].includes(start)) {
        inside = true
        continue
      }
      if (m[2].includes(end)) {
        inside = false
        continue
      }
      if (inside) out.push({ level: m[1], text: m[2] })
    } else if (inside && out.length > 0) {
      out.at(-1).text += '\n' + line
    }
  }
  return out
}

// What a statement may not do to the database's logic, by text. Used on the statements
// the server received; the permission errors and the fire counter catch what text hides.
export const BYPASS_PATTERNS = [
  [/\b(DISABLE|ENABLE)\s+(REPLICA\s+|ALWAYS\s+)?TRIGGER\b/i, 'switches a trigger off or on'],
  [/\b(DISABLE|ENABLE)\s+(REPLICA\s+|ALWAYS\s+)?RULE\b/i, 'switches a rule off or on'],
  [/\bDROP\s+TRIGGER\b/i, 'drops a trigger'],
  [/\bCREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b/i, 'creates or replaces a trigger'],
  [/\bsession_replication_role\b/i, 'changes session_replication_role'],
  [/\bSET\s+CONSTRAINTS\b/i, 'defers constraints'],
  [/\b(DROP|ALTER)\s+CONSTRAINT\b/i, 'drops or alters a constraint'],
  [/\bNOT\s+VALID\b/i, 'adds a constraint that is not validated'],
  [/\bDEFERRABLE\b/i, 'makes a constraint deferrable'],
  [/\b(CREATE\s+OR\s+REPLACE|ALTER|DROP)\s+FUNCTION\b/i, 'replaces, alters or drops a function'],
  [/\bALTER\s+SYSTEM\b/i, 'changes server settings'],
  [/\b(track_functions|log_statement|log_min_error_statement)\b/i, 'changes an observer setting'],
  // At the start of a statement (or of a PL/pgSQL statement), not "UPDATE t SET role = ...".
  [/(?:^|[;(]|\b(?:BEGIN|THEN|ELSE|LOOP|DO)\b)\s*(?:SET|RESET)\s+(?:LOCAL\s+|SESSION\s+)?ROLE\b|\bSESSION\s+AUTHORIZATION\b/i, 'changes the role'],
  [/\bEVENT\s+TRIGGER\b/i, 'touches an event trigger'],
  [new RegExp(`\\b${S}\\b`, 'i'), 'touches the rehearsal observers'],
  [/^\s*\\|\n\s*\\/, 'uses a psql backslash command'],
]

const PERMISSION = /permission denied|must be owner of|must be superuser|must be a member of|only superuser|is not permitted/i

/**
 * Evidence of a bypass from what the observers recorded.
 * @returns {{ evidence: object[], unverifiable: string[] }}
 */
export function judgeObservations({ installed, after, callsBefore, callsAfter, expected, ddl, records, planRole }) {
  const evidence = []
  const unverifiable = []
  // 4. Observers must be as they were. Only a plan that switches triggers, event triggers or
  // settings off can change them, so a change is itself a bypass, and the rest is not trusted.
  // The delete audit of a table the plan dropped is gone with the table; the drop is DATA LOSS
  // (table_removed, or every row deleted when a table of the same name replaced it), not a
  // switch-off. Every other change of the audit is. Tables are compared by oid.
  const gone = new Set((installed.state?.tables ?? []).filter((t) => !(after?.tables ?? []).includes(t)))
  const auditBefore = Object.fromEntries(Object.entries(installed.state?.audit ?? {}).filter(([, v]) => !gone.has(String(v).split(':')[0])))
  const changedKeys = ['event_trigger', 'watchers', 'settings', 'functions', 'audit'].filter((k) => JSON.stringify(k === 'audit' ? after?.audit ?? {} : after?.[k]) !== JSON.stringify(k === 'audit' ? auditBefore : installed.state?.[k]))
  if (changedKeys.length > 0) {
    const changed = changedKeys
    evidence.push({ kind: 'observers_switched_off', what: changed.join(', ') })
    unverifiable.push(`the rehearsal observers changed while the plan ran (${changed.join(', ')})`)
  }
  if (planRole && !planRole.restricted) unverifiable.push(...planRole.problems)
  // 1. Fire counter, per function (several triggers may share one).
  const byFunction = new Map()
  for (const w of installed.watchers) {
    const g = byFunction.get(w.foid) ?? { triggers: [], function: w.function, expected: 0 }
    g.triggers.push(w.trigger)
    g.expected += expected[w.trigger] ?? 0
    byFunction.set(w.foid, g)
  }
  for (const [foid, g] of byFunction) {
    const fired = (callsAfter[foid] ?? 0) - (callsBefore[foid] ?? 0)
    if (fired < g.expected) evidence.push({ kind: 'trigger_not_fired', trigger: g.triggers.join(', '), expected: g.expected, fired })
  }
  // Text patterns see code only: a comment or a string that mentions a trigger is not a bypass (review S2).
  // Exception: settings changed through a function take their name as a string
  // (set_config('session_replication_role', ...)), so those are also matched on the raw text.
  const RAW = [[/\bset_config\s*\(\s*'(session_replication_role|role|session_authorization|track_functions|log_statement)'/i, 'changes a setting through set_config']]
  const matches = (sql) => BYPASS_PATTERNS.find(([re]) => re.test(codeOnly(sql))) ?? RAW.find(([re]) => re.test(sql))
  // 2. DDL that the plan executed.
  for (const d of ddl) {
    const hit = matches(d.query)
    if (hit) evidence.push({ kind: 'bypass_ddl', tag: d.tag, what: hit[1], statement: d.query.slice(0, 300) })
  }
  // 3. Statements and errors in the server log.
  records.forEach((r, i) => {
    if (r.level === 'LOG' && /^statement:/.test(r.text)) {
      const hit = matches(r.text.replace(/^statement:\s*/, ''))
      if (hit) evidence.push({ kind: 'bypass_statement', what: hit[1], statement: r.text.replace(/^statement:\s*/, '').slice(0, 300) })
    } else if ((r.level === 'ERROR' || r.level === 'FATAL') && PERMISSION.test(r.text)) {
      // A refused statement is an attempt when it, or the error, reads as a bypass, or when
      // its text hides what it ran (DO block, EXECUTE) and the error is about owning or
      // setting something (review S3). A refused ADD COLUMN, or a missing EXECUTE grant on a
      // function, is an ordinary failure of the step, not a bypass.
      const statement = records.slice(i + 1, i + 4).find((x) => x.level === 'STATEMENT')?.text ?? ''
      const hidden = /^\s*DO\b|\bEXECUTE\b/i.test(codeOnly(statement)) && /must be owner of|permission denied to set parameter|must be superuser|only superuser|permission denied for schema/i.test(r.text)
      if (hidden || matches(statement) || BYPASS_PATTERNS.some(([re]) => re.test(r.text))) {
        evidence.push({ kind: 'bypass_attempt_refused', error: r.text.split('\n')[0].slice(0, 300), statement: statement.slice(0, 300) })
      }
    }
  })
  // One entry per distinct fact.
  const seen = new Set()
  const unique = evidence.filter((e) => {
    const k = JSON.stringify(e)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { evidence: unique, unverifiable, records: records.length }
}

/** Counts and DDL rows recorded by the observers (owner connection). */
export async function readObserverTables(exec) {
  const expectedRows = await one(exec, `SELECT coalesce(jsonb_object_agg(trigger_name, n), '{}')::text FROM (SELECT trigger_name, count(*) AS n FROM ${S}.expected GROUP BY 1) x`)
  const ddl = await one(exec, `SELECT coalesce(jsonb_agg(jsonb_build_object('tag', tag, 'role', role, 'query', query)), '[]')::text FROM ${S}.ddl`)
  return { expected: Object.fromEntries(Object.entries(expectedRows).map(([k, v]) => [k, Number(v)])), ddl }
}
