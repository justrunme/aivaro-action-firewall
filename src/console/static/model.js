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

// ---- T28: the Flight Recorder, the counterfactual and the receipt chain -----------------

/** Tones are the one colour language of the Console: ok green, warn amber, bad red, fix violet, mute grey, info neutral. */
const TONE = {
  ok: ['SAFE', 'allow', 'completed', 'PASS', 'undo', 'selected', 'RECOVERED', 'approved'],
  bad: ['DATA LOSS', 'FAILED', 'LOGIC CHANGE', 'deny', 'blocked', 'FAIL', 'failed', 'denied', 'approval_denied'],
  warn: ['pending', 'DRIFT'],
}
export function toneOf(verdict) {
  for (const [tone, list] of Object.entries(TONE)) if (list.includes(verdict)) return tone
  return 'warn'
}

/** "orders 3 → 2" for each protected table of a rehearsed version. */
export function tableLines(v) {
  return Object.entries(v?.impact?.tables ?? {}).filter(([, t]) => t.protected).map(([name, t]) => ({ name, before: t.rows_before ?? null, after: t.rows_after ?? null, lost: t.rows_lost ?? 0 }))
}

/** What a version lost, in one line. */
export function lossText(v) {
  const l = losses(v)
  const parts = [`${l.rows_lost} protected row${l.rows_lost === 1 ? '' : 's'} lost`]
  for (const t of l.removed_tables) parts.push(`table ${t} removed`)
  for (const c of l.removed_columns) parts.push(`column ${c} removed`)
  for (const o of l.removed_logic) parts.push(`${o} removed`)
  for (const o of l.changed_logic) parts.push(`${o} changed`)
  if (l.removed_tables.length + l.removed_columns.length + l.removed_logic.length + l.changed_logic.length === 0) parts.push('schema and database logic kept')
  return parts.join(' · ')
}

/** The verdict a mission card shows: one label and tone, from checked links only. */
export function missionVerdict(story) {
  if (!story || story.chain_ok === false || story.history?.ok === false) return { label: 'UNVERIFIABLE', tone: 'mute' }
  const f = focus(story)
  const first = story.versions?.[0]
  if (!first) return { label: 'NO REHEARSAL', tone: 'mute' }
  if (f.links && !f.links.links.every((l) => l.ok)) return { label: 'NOT AS REHEARSED', tone: 'bad' }
  if (f.run && f.run.verdict === 'completed' && f.links?.ok) return { label: 'PROVEN', tone: 'ok' }
  if (f.pending) return { label: 'NEEDS APPROVAL', tone: 'warn' }
  if (f.approved) return { label: 'APPROVED', tone: 'info' }
  if (f.a && f.b) return { label: 'REPAIRED', tone: 'fix' }
  if (f.a) return { label: 'DENIED', tone: 'bad' }
  return f.b ? { label: 'SAFE', tone: 'ok' } : { label: 'NOT SAFE', tone: toneOf(first.verdict) }
}

export const FLIGHT = ['PROPOSED', 'REHEARSED', 'DENIED', 'REPAIRED', 'APPROVED', 'EXECUTED', 'VERIFIED']

/**
 * The seven Flight Recorder nodes. A step the chain does not show is `missing` with a
 * reason; nothing is filled in. `receipt` is the signed receipt that backs the node.
 */
export function flight(story) {
  const f = focus(story)
  const versions = story?.versions ?? []
  const first = versions[0] ?? null
  const refused = [...(story?.requests ?? [])].reverse().find((q) => q.state === 'denied') ?? null
  const rec = (x) => (x ? { seq: x.seq, hash: x.receipt } : null)
  const missing = (why) => ({ state: 'missing', note: why, receipt: null })
  const linkOk = (code) => linkOf(f.links, code)?.ok === true
  const node = {
    PROPOSED: first ? { state: 'info', note: 'the first plan rehearsed', receipt: rec(first), version: first } : missing('no rehearsal in this mission'),
    REHEARSED: first ? (first.available ? { state: 'ok', note: 'measured on a disposable copy', receipt: rec(first), version: first } : { state: 'mute', note: first.problem ?? 'the archived report is missing', receipt: rec(first), version: first }) : missing('nothing rehearsed yet'),
    DENIED: f.a ? { state: 'bad', note: f.a.verdict, receipt: rec(f.a), version: f.a } : missing(first ? 'no plan was denied' : 'nothing rehearsed yet'),
    REPAIRED: f.a && f.b ? { state: 'fix', note: 'revised plan rehearsed SAFE', receipt: rec(f.b), version: f.b, from: f.a } : missing(f.a ? 'no SAFE revision yet' : 'not needed: no denial'),
    APPROVED: f.approved
      ? { state: f.links && !(linkOk('APPROVED_VERSION_SAFE') && linkOk('AUTHORIZED_AS_REQUESTED')) ? 'bad' : 'ok', note: 'operator approved this exact version', receipt: rec(f.approved.authorization), request: f.approved, version: f.b }
      : f.pending ? { state: 'warn', note: 'waiting for the operator', receipt: rec(f.pending), request: f.pending, version: f.b }
        : refused ? { state: 'bad', note: 'refused by the operator', receipt: rec(refused), request: refused, version: f.b }
          : missing('no approval requested'),
    EXECUTED: f.run ? { state: f.run.verdict === 'completed' && linkOk('EXECUTED_AS_AUTHORIZED') ? 'ok' : 'bad', note: `run ${f.run.verdict}`, receipt: rec(f.run), run: f.run } : missing('not run'),
    VERIFIED: f.run ? { state: linkOk('RESULT_AS_REHEARSED') ? 'ok' : 'bad', note: f.run.matches_rehearsal ? 'result equals the rehearsal' : `${f.run.differences ?? '?'} difference(s) from the rehearsal`, receipt: rec(f.run), run: f.run } : missing('nothing to verify yet'),
  }
  return FLIGHT.map((name) => ({ name, ...node[name] }))
}

/** The four-beat headline: proposed, rehearsed, blocked or repaired, proven. Numbers come from signed reports. */
export function headline(story) {
  const f = focus(story)
  const first = story?.versions?.[0]
  if (!first) return []
  const rows = (v) => tableLines(v).map((t) => `${t.name} ${t.before ?? '?'} → ${t.after ?? '?'}`).join(', ')
  const beats = [
    { step: 'Plan proposed', tone: 'info', text: (first.files ?? []).map((x) => x.path).join(', ') || first.plan_id },
    { step: 'JustRunMe rehearsed', tone: toneOf(first.verdict), text: first.available ? `${first.verdict}: ${rows(first)} (${lossText(first)})` : 'report not in the archive' },
  ]
  if (f.a && f.b) beats.push({ step: 'Blocked, then repaired', tone: 'fix', text: `Plan A denied; revised plan ${f.b.verdict}: ${rows(f.b)}` })
  else if (f.a) beats.push({ step: 'Blocked', tone: 'bad', text: 'denied; no SAFE revision yet' })
  else beats.push({ step: 'Blocked or repaired', tone: 'mute', text: 'not needed: the first plan was SAFE' })
  const links = f.links
  if (f.run && links) beats.push({ step: links.ok ? 'Proven' : 'Not proven', tone: links.ok ? 'ok' : 'bad', text: links.ok ? 'approved, executed, and the real result equals the rehearsal' : links.links.filter((l) => !l.ok).map((l) => l.code).join(', ') })
  else beats.push({ step: 'Proven', tone: f.pending ? 'warn' : 'mute', text: f.pending ? 'waiting for the operator\'s approval' : 'not run yet' })
  return beats
}

/**
 * Counterfactual replay from signed rehearsals only: the last plan that was not SAFE before the approved one,
 * as measured on a disposable copy, next to the plan that was approved. Review verdicts
 * are not recorded in the chain, so none is shown.
 */
export function counterfactual(story) {
  const f = focus(story)
  if (!f.a || !f.a.available) return null
  const b = f.b?.available ? f.b : null
  const ran = Boolean(f.run && f.links && b)
  return {
    without: { version: f.a, tables: tableLines(f.a), text: lossText(f.a) },
    with: {
      denied: f.a,
      version: b,
      tables: b ? tableLines(b) : [],
      ran,
      matched: ran ? f.run.matches_rehearsal === true : null,
      run: f.run,
    },
  }
}

/** One row per receipt with its signature state; or one row per finding when the chain does not verify. */
export function receiptRows(story) {
  if (!story) return []
  if (story.chain_ok === false) return (story.chain_findings ?? []).map((x) => ({ seq: x.seq, kind: 'finding', verdict: null, tone: 'bad', at: null, hash: null, sig: false, problem: x.problem }))
  return (story.timeline ?? []).map((t) => ({ seq: t.seq, kind: t.kind, verdict: t.verdict, tone: toneOf(t.verdict), at: t.at, hash: t.hash, sig: true, problem: null }))
}

/** Who gave the approval, as far as the receipt can tell. Never "human" unless a terminal was used. */
export function approvalSource(source) {
  if (source === 'tty') return { label: 'HUMAN AT TERMINAL', tone: 'ok', note: 'the passphrase was typed at a terminal' }
  if (source === 'env') return { label: 'SCRIPTED', tone: 'warn', note: 'the passphrase came from the environment: automation approved, not a person at a keyboard' }
  if (source === 'stdin') return { label: 'CONSOLE OR PIPE', tone: 'info', note: 'the passphrase arrived on stdin (the Console, or a script piping into the CLI); the receipt names the channel, not the person' }
  return { label: 'NOT RECORDED', tone: 'mute', note: 'the receipt does not say how the passphrase was given' }
}
