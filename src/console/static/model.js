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
  // The run of the approved request; else the latest run (a run authorized at the CLI has no request).
  const run = (approved ? (story.runs ?? []).find((r) => r.request_id === approved.request_id) : null) ?? (story?.runs ?? []).at(-1) ?? null
  const links = run?.request_id ? (story.links ?? []).find((l) => l.request_id === run.request_id) ?? null : null
  return { a, b, approved, pending, run, links }
}

/** The most severe measured loss: the DATA LOSS version with the most protected rows lost (earliest on a tie), else Plan A. */
export function severest(story) {
  const versions = (story?.versions ?? []).filter((v) => v.available)
  const lossy = versions.filter((v) => v.verdict === 'DATA LOSS')
  if (lossy.length > 0) return lossy.reduce((best, v) => ((v.impact?.rows_lost ?? 0) > (best.impact?.rows_lost ?? 0) ? v : best))
  const f = focus(story)
  return f.a?.available ? f.a : null
}

/** The latest SAFE version that can be read. */
export const latestSafe = (story) => [...(story?.versions ?? [])].reverse().find((v) => v.verdict === 'SAFE' && v.available) ?? null

/** Did the run end as rehearsed? From the checked links when an approval led to it, else from the run receipt. */
function runVerified(f) {
  if (!f.run || f.run.verdict !== 'completed') return false
  return f.links ? f.links.ok === true : f.run.matches_rehearsal === true
}

/** What happened after the run: RECOVERED · VERIFIED, RECOVERY FAILED, COMPLETED · VERIFIED, ... or null before any run. */
export function runOutcome(story) {
  const f = focus(story)
  const r = f.run
  if (!r) return null
  // RECOVERED only with a verification receipt that says PASS; an undo without one is not a recovery claim.
  if (r.undo) {
    if (r.undo.verification === 'PASS') return { label: 'RECOVERED · VERIFIED', tone: 'ok', text: `run ${r.verdict}, then undone; recovery verification PASS` }
    if (r.undo.verification == null) return { label: 'UNDONE · NOT VERIFIED', tone: 'mute', text: `run ${r.verdict}, then undone; no recovery verification is recorded` }
    return { label: 'RECOVERY FAILED', tone: 'bad', text: `run ${r.verdict}, then undone; recovery verification ${r.undo.verification}` }
  }
  if (runVerified(f)) return { label: 'COMPLETED · VERIFIED', tone: 'ok', text: f.links ? 'approved, executed, and the real result equals the rehearsal' : 'executed, and the real result equals the rehearsal' }
  if (r.verdict !== 'completed') return { label: 'RUN FAILED', tone: 'bad', text: `run ${r.verdict}; it can be undone from its capture` }
  return { label: 'NOT AS REHEARSED', tone: 'bad', text: f.links ? f.links.links.filter((l) => !l.ok).map((l) => l.code).join(', ') : `${r.differences ?? '?'} difference(s) from the rehearsal` }
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
    EXECUTED: f.run ? ((f.links ? executed?.ok : f.run.verdict === 'completed') ? 'done' : 'broken') : 'waiting',
    VERIFIED: f.run ? ((f.links ? result?.ok : f.run.matches_rehearsal === true) ? 'done' : 'broken') : 'waiting',
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

/** Tones are the one colour language of the Console: ok emerald, warn amber, bad crimson, fix violet, mute grey, info neutral. */
const TONE = {
  ok: ['SAFE', 'allow', 'completed', 'PASS', 'undo', 'selected', 'RECOVERED', 'approved'],
  bad: ['DATA LOSS', 'FAILED', 'LOGIC CHANGE', 'LOGIC BYPASS', 'INVARIANT VIOLATED', 'REQUIREMENT UNMET', 'deny', 'blocked', 'FAIL', 'failed', 'denied', 'approval_denied'],
  warn: ['pending', 'DRIFT', 'CONFLICT'],
  // T25 v2: a rehearsal whose observers or plan role cannot be trusted is neither SAFE nor a measured denial.
  mute: ['UNVERIFIABLE'],
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
export function missionVerdict(story, verifyOk = true) {
  if (!story || story.chain_ok === false || story.history?.ok === false) return { label: 'UNVERIFIABLE', tone: 'mute' }
  // A green label needs `justrunme verify` to pass for this mission (chain, policy, selections, archive).
  if (verifyOk === false) return { label: 'NOT VERIFIED', tone: 'mute' }
  const f = focus(story)
  const first = story.versions?.[0]
  if (!first) return { label: 'NO REHEARSAL', tone: 'mute' }
  if (f.links && !f.links.links.every((l) => l.ok)) return { label: 'NOT AS REHEARSED', tone: 'bad' }
  const out = runOutcome(story)
  if (out) return { label: out.label, tone: out.tone }
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
    APPROVED: !f.approved && !f.pending && f.run?.authorization && !f.run.request_id
      ? (() => {
          const t = (story.timeline ?? []).find((x) => x.hash === f.run.authorization)
          return { state: 'ok', note: 'authorized at the command line (no approval request)', receipt: t ? { seq: t.seq, hash: t.hash } : null, version: f.b }
        })()
      : f.approved
      ? { state: f.links && !(linkOk('APPROVED_VERSION_SAFE') && linkOk('AUTHORIZED_AS_REQUESTED')) ? 'bad' : 'ok', note: 'operator approved this exact version', receipt: rec(f.approved.authorization), request: f.approved, version: f.b }
      : f.pending ? { state: 'warn', note: 'waiting for the operator', receipt: rec(f.pending), request: f.pending, version: f.b }
        : refused ? { state: 'bad', note: 'refused by the operator', receipt: rec(refused), request: refused, version: f.b }
          : missing('no approval requested'),
    EXECUTED: f.run ? { state: f.run.verdict === 'completed' && (f.links ? linkOk('EXECUTED_AS_AUTHORIZED') : true) ? 'ok' : 'bad', note: `run ${f.run.verdict}`, receipt: rec(f.run), run: f.run } : missing('not run'),
    VERIFIED: f.run
      ? { state: (f.links ? linkOk('RESULT_AS_REHEARSED') : f.run.matches_rehearsal === true) && (!f.run.undo || f.run.undo.verification === 'PASS') ? 'ok' : 'bad', note: `${f.run.matches_rehearsal ? 'result equals the rehearsal' : `${f.run.differences ?? '?'} difference(s) from the rehearsal`}${f.run.undo ? `; undone, recovery check ${f.run.undo.verification ?? '—'}` : ''}`, receipt: rec(f.run), run: f.run }
      : missing('nothing to verify yet'),
  }
  return FLIGHT.map((name) => ({ name, ...node[name] }))
}

/** The four-beat headline: proposed, rehearsed, blocked or repaired, proven. Numbers come from signed reports. */
export function headline(story, verifyOk = true) {
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
  const out = runOutcome(story)
  if (out && verifyOk === false) beats.push({ step: 'NOT VERIFIED', tone: 'mute', text: 'the run has receipts, but `justrunme verify` does not pass for this mission, so no result is claimed' })
  else if (out) beats.push({ step: out.label, tone: out.tone, text: out.text })
  else beats.push({ step: 'Run', tone: f.pending ? 'warn' : 'mute', text: f.pending ? 'waiting for the operator\'s approval' : 'not run yet' })
  return beats
}

/**
 * Counterfactual replay from signed rehearsals only: the last plan that was not SAFE before the approved one,
 * as measured on a disposable copy, next to the plan that was approved. Review verdicts
 * are not recorded in the chain, so none is shown.
 */
export function counterfactual(story) {
  const f = focus(story)
  const worst = severest(story)
  if (!worst) return null
  const b = f.b?.available ? f.b : null
  const ran = Boolean(f.run && f.run.verdict === 'completed' && b && f.run.report_hash === b.report_hash)
  return {
    without: { version: worst, tables: tableLines(worst), text: lossText(worst) },
    with: {
      denied: worst,
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

// ---- Decision first: what happened, why, what the operator can safely do next ---------------

/**
 * The headline of one rehearsed version, from its signed report only. `why` lists measured
 * facts; `next` is what the operator can do. Nothing here is inferred from the SQL text.
 * @returns {{ label: string, tone: string, headline: string, why: string[], execution: string, next: string }}
 */
export function heroOf(v) {
  if (!v) return { label: 'UNKNOWN', tone: 'mute', headline: 'No rehearsal to show', why: [], execution: 'not authorizable', next: 'Rehearse a plan first.' }
  if (!v.available) return { label: 'NOT VERIFIED', tone: 'mute', headline: 'The signed report of this version is not in the history archive', why: [v.problem ?? 'report missing'], execution: 'not authorizable', next: 'Rehearse the plan again.' }
  const lost = losses(v)
  const kinds = new Set((v.impact?.evidence ?? []).map((e) => e.kind))
  const changes = tableLines(v).map((t) => `${t.name}: ${t.before ?? '?'} → ${t.after ?? '?'}${t.lost > 0 ? ` (${t.lost} lost)` : ''}`)
  if (v.verdict === 'DATA LOSS') {
    const why = [...changes]
    if (kinds.has('protected_rows_deleted') && lost.rows_lost === 0) why.push('rows were deleted during the plan and inserted again (the delete audit saw it)')
    for (const t of lost.removed_tables) why.push(`table ${t} removed`)
    for (const c of lost.removed_columns) why.push(`column ${c} removed`)
    return {
      label: 'DATA LOSS DETECTED', tone: 'bad',
      headline: lost.rows_lost > 0 ? `${lost.rows_lost} protected row${lost.rows_lost === 1 ? '' : 's'} would be deleted` : 'protected data would be lost',
      why, execution: 'BLOCKED: a plan that is not SAFE cannot be approved or run', next: 'Revise the plan so that every protected row survives, then rehearse again.',
    }
  }
  if (v.verdict === 'LOGIC BYPASS') {
    const why = []
    if (kinds.has('bypass_attempt_refused')) why.push('PostgreSQL refused a statement of the plan (the plan role lacks the right): a permission error from the database')
    if (kinds.has('bypass_statement') || kinds.has('bypass_ddl')) why.push('JustRunMe\'s observers recorded a statement that switches off, drops or replaces database logic')
    if (kinds.has('trigger_not_fired')) why.push('a protected trigger fired fewer times than the rows it applies to')
    if (kinds.has('observers_switched_off')) why.push('the plan changed the rehearsal observers')
    if (why.length === 0) why.push('the signed report records a bypass of database logic')
    return { label: 'LOGIC BYPASS DETECTED', tone: 'bad', headline: 'The plan tried to switch off or work around database logic', why, execution: 'BLOCKED: JustRunMe denied it; nothing reached the real database', next: 'Revise the plan so that triggers, constraints and functions stay active.' }
  }
  if (v.verdict === 'SAFE') return { label: 'SAFE · MEASURED', tone: 'ok', headline: `${lost.rows_lost} protected rows lost`, why: changes.length ? changes : ['no protected table in the report'], execution: 'eligible for approval (an operator must approve it)', next: 'Review the SQL and the measured diff, then approve or reject the request.' }
  if (v.verdict === 'UNVERIFIABLE') return { label: 'UNVERIFIABLE', tone: 'mute', headline: 'The rehearsal observers or the plan role cannot be trusted for this run', why: changes, execution: 'BLOCKED', next: 'Ask the operator; do not approve.' }
  return { label: v.verdict, tone: toneOf(v.verdict), headline: v.verdict === 'FAILED' ? 'A step of the plan did not complete in rehearsal' : `Rehearsal verdict ${v.verdict}`, why: [...changes, ...(v.impact?.failed_steps ?? []).map((s) => `step ${s} failed`)], execution: 'BLOCKED: only a SAFE rehearsal can be approved', next: 'Fix the plan and rehearse again.' }
}

/**
 * May this request be approved from this page? Only a pending, unexpired request whose signed
 * report is SAFE and whose files are unchanged. The CLI checks all of it again (and the
 * fingerprint and single use); this only decides whether the button is offered at all.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function eligibility(detail, { now = Date.now(), storyState = null, verifyOk = true } = {}) {
  const reasons = []
  if (!detail) return { ok: false, reasons: ['the request cannot be read'] }
  if (detail.state !== 'pending') reasons.push(`the request is ${detail.state.toUpperCase()}`)
  if (storyState && storyState !== 'pending') reasons.push(`the chain records it as ${storyState}`)
  if (Number.isNaN(Date.parse(detail.expires_at)) || Date.parse(detail.expires_at) <= now) reasons.push('the request has EXPIRED')
  if (!detail.report?.valid) reasons.push(`the rehearsal report cannot be verified (${detail.report?.problem ?? 'missing'})`)
  else if (detail.report.verdict !== 'SAFE') reasons.push(`the rehearsal verdict is ${detail.report.verdict}`)
  const changed = (detail.files ?? []).filter((f) => !f.matches_now)
  if (changed.length) reasons.push(`STALE: ${changed.map((f) => f.path).join(', ')} changed since the request`)
  if (!verifyOk) reasons.push('the receipt chain does not verify')
  return { ok: reasons.length === 0, reasons }
}

/** Triage: what needs a person first. Lower is more urgent. */
export function urgency(story, verifyOk = true) {
  const v = missionVerdict(story, verifyOk)
  return { 'NEEDS APPROVAL': 0, 'NOT AS REHEARSED': 1, 'RECOVERY FAILED': 1, 'RUN FAILED': 1, 'NOT VERIFIED': 1, UNVERIFIABLE: 2, DENIED: 2, 'NOT SAFE': 2, REPAIRED: 3, APPROVED: 3, SAFE: 4 }[v.label] ?? 5
}
