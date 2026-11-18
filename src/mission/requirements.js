/**
 * Business requirements of a mission (T25 v2, Step 3): what the plan must change, and
 * invariants that must hold after it, in a small typed form the operator writes in
 * justrunme.mission.yaml. Typed, not SQL: JustRunMe builds every query itself (names
 * quoted, values as literals), and a contradiction between requirements can be decided
 * before any plan is rehearsed.
 *
 *   required_changes:
 *     - { table: patches, where: { id: 1 }, set: { available_count: 0 } }
 *   invariants:
 *     - kind: implies                        # every row of `then.table` linked to a row
 *       when: { table: patches, column: available_count, equals: 0 }   # where `when` holds
 *       then: { table: orders, link: patch_id, column: status, equals: cancelled }
 *       text: "When a patch is sold out, its orders are cancelled"
 *     - kind: keep                           # rows matching `where` keep this value
 *       table: orders
 *       where: { patch_id: 1 }
 *       column: status
 *       equals: open
 *
 * `link` is a column of `then.table` that references the `id` column of `when.table`.
 *
 * CONFLICT: a required change sets a value that, through an `implies` invariant, forces
 * another value on linked rows, and a `keep` invariant demands a different value on the
 * same rows, and at least one such row exists. Other contradictions are not detected
 * (limit); they show up as an invariant that no plan can satisfy.
 *
 * Limits of the checks after the plan: `implies` holds for every row of `when.table`,
 * not only the changed ones (a sold-out patch that already had an open order fails
 * it); a row moved to another parent (its `link` changed) or with a NULL link is not
 * covered by `implies`. Deleting a protected row and inserting another is caught
 * separately (primary key snapshot, observe.js), not here.
 */

export const CONFLICT_MESSAGE = 'CONFLICT: requirements unsatisfiable'

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/
const isScalar = (v) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const q = (name) => '"' + name + '"' // names are checked against IDENT first
const lit = (v) => (v === null ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : typeof v === 'boolean' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'")
const cond = (alias, where) => Object.entries(where).map(([c, v]) => (v === null ? `${alias}.${q(c)} IS NULL` : `${alias}.${q(c)} = ${lit(v)}`)).join(' AND ') || 'TRUE'

/** Validation errors in the contract's required_changes and invariants: [{ field, message }]. */
export function validateRequirements(doc) {
  const errors = []
  const where = (w, field) => {
    if (!isObject(w) || Object.keys(w).length === 0) return errors.push({ field, message: 'must be a non-empty mapping of column: value' })
    for (const [c, v] of Object.entries(w)) {
      if (!IDENT.test(c)) errors.push({ field: `${field}.${c}`, message: 'must be a lower-case column name' })
      if (!isScalar(v)) errors.push({ field: `${field}.${c}`, message: 'must be a string, number, boolean or null' })
    }
  }
  const name = (v, field) => {
    if (typeof v !== 'string' || !IDENT.test(v)) errors.push({ field, message: 'must be a lower-case table or column name' })
  }
  if ('required_changes' in doc) {
    if (!Array.isArray(doc.required_changes)) errors.push({ field: 'required_changes', message: 'must be a list' })
    else doc.required_changes.forEach((r, i) => {
      const f = `required_changes[${i}]`
      if (!isObject(r)) return errors.push({ field: f, message: 'must be a mapping' })
      for (const k of Object.keys(r)) if (!['table', 'where', 'set'].includes(k)) errors.push({ field: `${f}.${k}`, message: 'unknown field' })
      name(r.table, `${f}.table`)
      where(r.where, `${f}.where`)
      where(r.set, `${f}.set`)
    })
  }
  if ('invariants' in doc) {
    if (!Array.isArray(doc.invariants)) errors.push({ field: 'invariants', message: 'must be a list' })
    else doc.invariants.forEach((v, i) => {
      const f = `invariants[${i}]`
      if (!isObject(v)) return errors.push({ field: f, message: 'must be a mapping' })
      if (v.text !== undefined && (typeof v.text !== 'string' || v.text.length > 300)) errors.push({ field: `${f}.text`, message: 'must be a string up to 300 characters' })
      if (v.kind === 'implies') {
        for (const k of Object.keys(v)) if (!['kind', 'when', 'then', 'text'].includes(k)) errors.push({ field: `${f}.${k}`, message: 'unknown field' })
        if (!isObject(v.when) || !isObject(v.then)) return errors.push({ field: f, message: 'implies needs when and then' })
        name(v.when.table, `${f}.when.table`)
        name(v.when.column, `${f}.when.column`)
        if (!isScalar(v.when.equals)) errors.push({ field: `${f}.when.equals`, message: 'must be a scalar' })
        name(v.then.table, `${f}.then.table`)
        name(v.then.link, `${f}.then.link`)
        name(v.then.column, `${f}.then.column`)
        if (!isScalar(v.then.equals)) errors.push({ field: `${f}.then.equals`, message: 'must be a scalar' })
      } else if (v.kind === 'keep') {
        for (const k of Object.keys(v)) if (!['kind', 'table', 'where', 'column', 'equals', 'text'].includes(k)) errors.push({ field: `${f}.${k}`, message: 'unknown field' })
        name(v.table, `${f}.table`)
        where(v.where, `${f}.where`)
        name(v.column, `${f}.column`)
        if (!isScalar(v.equals)) errors.push({ field: `${f}.equals`, message: 'must be a scalar' })
      } else {
        errors.push({ field: `${f}.kind`, message: 'must be implies or keep' })
      }
    })
  }
  return errors
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Contradictions decidable from the contract alone, each with the SQL that counts the
 * rows it concerns (a contradiction on no rows is not a conflict).
 * @returns {{ change: number, implies: number, keep: number, why: string, rows_sql: string }[]}
 */
export function potentialConflicts(contract) {
  const out = []
  const changes = contract.required_changes ?? []
  const inv = contract.invariants ?? []
  changes.forEach((ch, ci) => {
    inv.forEach((imp, ii) => {
      if (imp.kind !== 'implies' || imp.when.table !== ch.table || !(imp.when.column in ch.set) || !same(ch.set[imp.when.column], imp.when.equals)) return
      // The required change makes `when` true on rows `ch.where`; linked rows must then carry then.equals.
      const forced = { table: imp.then.table, column: imp.then.column, value: imp.then.equals }
      inv.forEach((keep, ki) => {
        if (keep.kind !== 'keep' || keep.table !== forced.table || keep.column !== forced.column || same(keep.equals, forced.value)) return
        // Rows of the kept set that are linked to the changed rows.
        const rows_sql = `SELECT count(*) FROM ${q(forced.table)} t JOIN ${q(ch.table)} w ON w."id" = t.${q(imp.then.link)} WHERE ${cond('w', ch.where)} AND ${cond('t', keep.where)}`
        out.push({
          change: ci,
          implies: ii,
          keep: ki,
          why: `required change ${ch.table} ${JSON.stringify(ch.where)} sets ${imp.when.column} = ${JSON.stringify(imp.when.equals)}; invariant ${ii} then requires ${forced.table}.${forced.column} = ${JSON.stringify(forced.value)} on linked rows; invariant ${ki} requires ${JSON.stringify(keep.equals)} on ${forced.table} ${JSON.stringify(keep.where)}`,
          rows_sql,
        })
      })
    })
  })
  return out
}

/**
 * Check for a CONFLICT against the current database (rows must exist).
 * @param {(sql: string) => Promise<{ code: number, stdout: string, stderr: string }>} exec read access (owner)
 * @returns {Promise<null | { message: string, conflicts: { why: string, rows: number }[] }>}
 */
export async function findConflict(contract, exec) {
  const found = []
  for (const c of potentialConflicts(contract)) {
    const r = await exec(c.rows_sql)
    if (r.code !== 0) throw new Error(`conflict check failed: ${String(r.stderr).trim().split('\n').slice(-1)[0]}`)
    const rows = Number(r.stdout.trim())
    if (rows > 0) found.push({ why: c.why, rows })
  }
  return found.length === 0 ? null : { message: CONFLICT_MESSAGE, conflicts: found }
}

/**
 * Evaluate required changes and invariants after the plan (on the rehearsal copy).
 * @returns {Promise<{ unmet: object[], violated: object[] }>}
 */
export async function checkRequirements(contract, exec) {
  const unmet = []
  const violated = []
  const scalar = async (sql) => {
    const r = await exec(sql)
    if (r.code !== 0) throw new Error(`requirement check failed: ${String(r.stderr).trim().split('\n').slice(-1)[0]}`)
    return r.stdout.trim()
  }
  for (const [i, ch] of (contract.required_changes ?? []).entries()) {
    const sql = `SELECT count(*) || ',' || count(*) FILTER (WHERE ${cond('t', ch.set)}) FROM ${q(ch.table)} t WHERE ${cond('t', ch.where)}`
    const [all, done] = (await scalar(sql)).split(',').map(Number)
    if (all === 0 || done < all) unmet.push({ kind: 'requirement_unmet', index: i, table: ch.table, where: ch.where, set: ch.set, rows: all, done })
  }
  for (const [i, v] of (contract.invariants ?? []).entries()) {
    let sql
    if (v.kind === 'implies') {
      sql = `SELECT count(*) FROM ${q(v.then.table)} t JOIN ${q(v.when.table)} w ON w."id" = t.${q(v.then.link)} WHERE w.${q(v.when.column)} IS NOT DISTINCT FROM ${lit(v.when.equals)} AND t.${q(v.then.column)} IS DISTINCT FROM ${lit(v.then.equals)}`
    } else {
      sql = `SELECT count(*) FROM ${q(v.table)} t WHERE ${cond('t', v.where)} AND t.${q(v.column)} IS DISTINCT FROM ${lit(v.equals)}`
    }
    const bad = Number(await scalar(sql))
    if (bad > 0) violated.push({ kind: 'invariant_violated', index: i, invariant: v.kind, text: v.text ?? null, rows: bad })
  }
  return { unmet, violated }
}
