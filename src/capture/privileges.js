/**
 * Privileges of a Postgres database, as the capture records them and the recovery
 * verification compares them: the owner and the access list of the database, every
 * non-system schema, table, view, sequence and function, column grants, and default
 * privileges. Access lists are expanded (aclexplode) and a missing list counts as the
 * default for its owner (acldefault), so "never granted" and "granted the default"
 * compare equal. The grantor is left out: a restore loads the grants as one user.
 *
 * Not covered: types and domains, large objects, row-level security policies,
 * role attributes and role or database settings (roles live outside the database).
 *
 * Written fresh for this repository.
 */
import { sha256Hex } from '../util/canonical.js'

const SYSTEM = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'"
const WHO = "CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END"
const PRIV = "a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END"
const KIND = "CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign' END"

/** One SQL statement that returns the sorted lines as a JSON array, plus the database grants. */
export const PRIVILEGES_SQL = `SELECT jsonb_build_object(
  'lines', (SELECT coalesce(jsonb_agg(l ORDER BY l), '[]') FROM (
    SELECT 'database owner ' || pg_get_userbyid(d.datdba) FROM pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT 'database grant ' || ${WHO} || ' ' || ${PRIV} FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = current_database()
    UNION ALL
    SELECT 'schema ' || n.nspname || ' owner ' || pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE ${SYSTEM}
    UNION ALL
    SELECT 'schema ' || n.nspname || ' grant ' || ${WHO} || ' ' || ${PRIV} FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a WHERE ${SYSTEM}
    UNION ALL
    SELECT ${KIND} || ' ' || n.nspname || '.' || c.relname || ' owner ' || pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${SYSTEM}
    UNION ALL
    SELECT ${KIND} || ' ' || n.nspname || '.' || c.relname || ' grant ' || ${WHO} || ' ' || ${PRIV} FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(coalesce(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${SYSTEM}
    UNION ALL
    SELECT 'column ' || n.nspname || '.' || c.relname || '.' || t.attname || ' grant ' || ${WHO} || ' ' || ${PRIV} FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(t.attacl) a WHERE t.attacl IS NOT NULL AND t.attnum > 0 AND NOT t.attisdropped AND ${SYSTEM}
    UNION ALL
    SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') owner ' || pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${SYSTEM}
    UNION ALL
    SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') grant ' || ${WHO} || ' ' || ${PRIV} FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE ${SYSTEM}
    UNION ALL
    SELECT 'default ' || pg_get_userbyid(da.defaclrole) || ' ' || coalesce(n.nspname, '*') || ' ' || da.defaclobjtype::text || ' grant ' || ${WHO} || ' ' || ${PRIV} FROM pg_default_acl da LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace, aclexplode(da.defaclacl) a
  ) x(l)),
  'database', (SELECT jsonb_build_object('owner', pg_get_userbyid(d.datdba), 'grants', (SELECT coalesce(jsonb_agg(jsonb_build_object('grantee', ${WHO}, 'privilege', a.privilege_type, 'grantable', a.is_grantable) ORDER BY ${WHO}, a.privilege_type), '[]') FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a)) FROM pg_database d WHERE d.datname = current_database())
)::text`

/**
 * @param {(sql: string) => Promise<{ code: number, stdout: string, stderr: string }>} exec
 * @returns {Promise<{ hash: string, lines: string[], database: { owner: string, grants: { grantee: string, privilege: string, grantable: boolean }[] } }>}
 */
export async function measurePrivileges(exec) {
  const r = await exec(PRIVILEGES_SQL)
  if (r.code !== 0) throw new Error(`privileges query failed: ${String(r.stderr).trim().split('\n').slice(-1)[0]}`)
  const d = JSON.parse(r.stdout.trim())
  return { hash: 'sha256:' + sha256Hex(d.lines.join('\n')), lines: d.lines, database: d.database }
}

/** Lines in the capture that are gone now, and lines that are new. */
export function diffPrivileges(want, live) {
  const a = new Set(want?.lines ?? [])
  const b = new Set(live?.lines ?? [])
  return { missing: [...a].filter((l) => !b.has(l)), extra: [...b].filter((l) => !a.has(l)) }
}

const DB_PRIVS = new Set(['CREATE', 'TEMPORARY', 'CONNECT'])
const quote = (name) => (name === 'PUBLIC' ? 'PUBLIC' : '"' + String(name).replace(/"/g, '""') + '"')

/**
 * SQL that gives a database exactly the captured database-level grants. pg_dump of one
 * database does not carry them, so a restore into a new database must set them itself.
 * Every grantee that holds or held a right is revoked first, then the captured rights are granted.
 * @param {string} database already quoted identifier
 * @param {{ owner: string, grants: { grantee: string, privilege: string, grantable: boolean }[] }} captured
 * @param {string} loader the role that created the database (its owner after the restore)
 */
export function databaseGrantSql(database, captured, loader) {
  const grants = captured?.grants ?? []
  for (const g of grants) if (!DB_PRIVS.has(g.privilege)) throw new Error(`unexpected database privilege ${g.privilege}`)
  const who = [...new Set(['PUBLIC', loader, ...grants.map((g) => g.grantee)])]
  const lines = who.map((w) => `REVOKE ALL ON DATABASE ${database} FROM ${quote(w)};`)
  for (const g of grants) lines.push(`GRANT ${g.privilege} ON DATABASE ${database} TO ${quote(g.grantee)}${g.grantable ? ' WITH GRANT OPTION' : ''};`)
  return lines.join('\n') + '\n'
}
