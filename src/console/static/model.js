// What the Missions screen says, computed from the mission story (`justrunme history`).
// No DOM here: test/console.test.js runs these functions under Node.

export const STAGES = ['PROPOSED', 'REHEARSED', 'DENIED', 'REVISED', 'SAFE', 'APPROVED', 'EXECUTED', 'VERIFIED']

const linkOf = (set, code) => set?.links.find((l) => l.code === code) ?? null

/**
 * Plan A: the last version that was not SAFE before Plan B.
 * Plan B: the version an approved request names, else the latest SAFE version.
 */
export function focus(story) {
  const versions = story?.versions ?? []
  const requests = story?.requests ?? []
  const approved = [...requests].reverse().find((q) => q.state === 'approved') ?? null
  const pending = [...requests].reverse().find((q) => q.state === 'pending') ?? null
  const asked = approved ?? pending
  let b = asked ? versions.find((v) => v.report_hash === asked.report_hash) ?? null : null
  if (!b) b = [...versions].reverse().find((v) => v.verdict === 'SAFE') ?? null
  const before = b ? versions.filter((v) => v.seq < b.seq) : versions
  const a = [...before].reverse().find((v) => v.verdict !== 'SAFE') ?? null
  const run = approved ? (story.runs ?? []).find((r) => r.request_id === approved.request_id) ?? null : null
  const links = approved ? (story.links ?? []).find((l) => l.request_id === approved.request_id) ?? null : null
  return { a, b, approved, pending, run, links }
}

/** One state per stage: done | denied | broken | waiting | none. */
export function pipeline(story) {
  const f = focus(story)
  const versions = story?.versions ?? []
  const executed = linkOf(f.links, 'EXECUTED_AS_AUTHORIZED')
  const result = linkOf(f.links, 'RESULT_AS_REHEARSED')
  const approvedOk = f.approved && linkOf(f.links, 'APPROVED_VERSION_SAFE')?.ok !== false && linkOf(f.links, 'AUTHORIZED_AS_REQUESTED')?.ok !== false
  const state = {
    PROPOSED: versions.length > 0 ? 'done' : 'waiting',
    REHEARSED: versions.length > 0 ? 'done' : 'waiting',
    DENIED: f.a ? 'denied' : 'none',
    REVISED: f.a && f.b ? 'done' : f.a ? 'waiting' : 'none',
    SAFE: f.b ? 'done' : 'waiting',
    APPROVED: f.approved ? (approvedOk ? 'done' : 'broken') : 'waiting',
    EXECUTED: f.run ? (executed?.ok ? 'done' : 'broken') : 'waiting',
    VERIFIED: f.run ? (result?.ok ? 'done' : 'broken') : 'waiting',
  }
  return STAGES.map((name) => ({ name, state: state[name] }))
}

/** What a version lost: rows of protected tables, removed tables and columns. */
export function losses(v) {
  const d = v?.impact?.schema_delta ?? {}
  return {
    rows_lost: v?.impact?.rows_lost ?? 0,
    removed_tables: d.removed_tables ?? [],
    removed_columns: d.removed_columns ?? [],
    added_tables: d.added_tables ?? [],
    added_columns: d.added_columns ?? [],
    removed_logic: d.removed_logic ?? [],
    changed_logic: d.changed_logic ?? [],
  }
}

/** How the passphrase reached `justrunme approve`, in words. */
export function passphraseWords(source) {
  if (source === 'tty') return 'typed at a terminal'
  if (source === 'stdin') return 'given on stdin (the Console, or a pipe)'
  if (source === 'env') return 'from the environment (scripted)'
  return 'not recorded'
}

/** Two versions measured on different database states cannot be compared row for row. */
export const sameBase = (a, b) => Boolean(a && b && a.base_hash && a.base_hash === b.base_hash)
