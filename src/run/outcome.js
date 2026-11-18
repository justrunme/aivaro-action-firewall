/**
 * After a real run: is the database what the rehearsal predicted? (T27.1)
 * Compares the schema hash, and the row count and content checksum of every table,
 * between the rehearsal's `database.after` and a measurement of the real database.
 * Reports table names and counts only, never row values.
 */

/**
 * @param {{ schema_hash: string, tables: Record<string, { rows: number, checksum: string }> } | null | undefined} predicted
 * @param {{ schema_hash: string, tables: Record<string, { rows: number, checksum: string }> }} actual
 * @returns {{ matches: boolean, differences: { table?: string, what: string, rows_rehearsed?: number, rows_real?: number }[] }}
 */
export function compareOutcome(predicted, actual) {
  if (!predicted) return { matches: false, differences: [{ what: 'no rehearsal measurement to compare with' }] }
  const differences = []
  if (actual.schema_hash !== predicted.schema_hash) differences.push({ what: 'schema differs from the rehearsal' })
  for (const t of [...new Set([...Object.keys(predicted.tables), ...Object.keys(actual.tables)])].sort()) {
    const a = predicted.tables[t]
    const b = actual.tables[t]
    if (!a || !b) differences.push({ table: t, what: a ? 'missing after the run' : 'not predicted by the rehearsal' })
    else if (a.rows !== b.rows || a.checksum !== b.checksum) differences.push({ table: t, what: 'rows or content differ from the rehearsal', rows_rehearsed: a.rows, rows_real: b.rows })
  }
  return { matches: differences.length === 0, differences }
}
