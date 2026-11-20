// The four Console screens. Each takes the loaded state and a small context
// ({ api, reload, rerender, ui, route }) and returns one DOM node.
//   Missions            cards, then the Flight Recorder of one mission
//   Impact Diff         Counterfactual Replay, then Plan A against Plan B
//   Approval Center     the plan, its measured risk, Approve or Reject
//   Recovery & Replay   runs and undo, verification, the signed receipt chain
// Everything shown is read from the signed chain and the plan history; a step the
// chain does not show is drawn greyed with the reason, never filled in.

import { badge, fmtTime, h, hashChip, icon, short, sqlCompare, sqlOf, sqlView, stateBox } from './ui.js'
import { approvalSource, counterfactual, eligibility, flight, heroOf, latestSafe, lossText, losses, missionSummary, missionVerdict, recoverySummary, passphraseWords, receiptRows, sameBase, severest, tableLines, toneOf, urgency } from './model.js'

const TONE_LABEL = { ok: 'verified', bad: 'denied', warn: 'attention required', fix: 'repaired', mute: 'unverifiable', info: 'recorded', missing: 'not in the chain' }
const nodeLabel = (n) => n.name === 'VERIFIED' && n.state === 'warn' && /checks.*(unknown|not record)/i.test(n.note) ? 'checks unknown' : TONE_LABEL[n.state]
const NODE_ICON = { ok: 'bolt', bad: 'cross', warn: 'lock', fix: 'check', mute: 'dash', info: 'check', missing: 'dash' }
const linkOk = (set, code) => set?.links.find((l) => l.code === code)?.ok === true
const ok = (cond) => badge(cond ? 'holds' : 'broken', cond ? 'ok' : 'bad', cond ? 'check' : 'cross')

function cliProblem(out) {
  if (!out) return 'no answer'
  if (out.ok === false && out.error) return `${out.error.code}: ${out.error.message}`
  return null
}

/** The state box for a story that could not be read, or null when it can. */
function storyProblem(state, what) {
  const problem = cliProblem(state.story)
  if (!problem) return null
  const none = state.story?.error?.code === 'NO_RECEIPTS'
  return stateBox(none ? 'empty' : 'error', none ? 'No mission recorded yet' : `The ${what} cannot be shown`, none ? 'This mission has no receipts. Rehearse a plan with `justrunme rehearse`, or let an agent call the `rehearse` tool, and it appears here.' : problem)
}

const mission = (s) => h('span', { class: 'mono', text: s.mission_id })
/** `justrunme verify` passed for this mission: the only basis for a green label. */
const verifiedOk = (state) => state?.verify?.ok === true && state?.verify?.result?.ok === true
/** Flight nodes, greyed when the chain check does not pass: no green or red claim without it. */
const nodesOf = (s, state) => flight(s).map((n) => (verifiedOk(state) || n.state === 'missing' ? n : { ...n, state: 'mute', note: `${n.note} (not verified)` }))

/**
 * What happened, why, and what the operator can safely do next, for one rehearsed version.
 * The trigger that fired is read from the signed rehearsal receipt (T25 v3 change 2).
 */
function hero(v, ctx, { compact = false } = {}) {
  const x = heroOf(v, ctx?.story)
  const trig = h('div', { class: 'callout-slot', 'aria-live': 'polite' })
  if (v?.available && v.verdict !== 'SAFE' && (v.impact?.evidence ?? []).some((e) => e.kind === 'trigger_fired') && ctx?.api) {
    trig.replaceChildren(h('div', { class: 'muted', text: 'Reading which database trigger fired…' }))
    ctx.api(`/api/receipt/${v.seq}`).then((out) => {
      const fired = (out?.result?.receipt?.subject?.evidence ?? []).filter((e) => e.kind === 'trigger_fired')
      trig.replaceChildren(...fired.map((e) => h('div', { class: 'callout bad' }, icon('bolt'), h('span', { class: 'k', text: 'Trigger' }), h('code', { class: 'mono tname', text: e.trigger }), h('span', { text: ' on ' }), h('code', { class: 'mono', text: e.table }),
        h('span', { class: 'muted', text: ` · ${e.timing ?? '?'} ${e.event ?? '?'} · per ${String(e.level ?? 'row').toLowerCase()} · fired ${e.fired} time${e.fired === 1 ? '' : 's'} · from signed receipt #${v.seq}` }))))
    }).catch(() => trig.replaceChildren(h('div', { class: 'muted', text: 'The receipt could not be read; no trigger is shown.' })))
  }
  return h('section', { class: `hero ${x.tone}${compact ? ' compact' : ''}`, 'aria-label': `${x.label}: ${x.headline}` },
    h('div', { class: 'hero-top' }, h('span', { class: `hero-label ${x.tone}` }, icon(x.tone === 'ok' ? 'shield' : x.tone === 'bad' ? 'alert' : 'dash'), x.label), v ? h('span', { class: 'muted mono', text: `#${v.seq} · ${v.plan_id}` }) : null),
    h('div', { class: 'hero-head', text: x.headline }),
    h('div', { class: 'hero-grid' },
      h('div', {}, h('div', { class: 'biglabel', text: 'Why' }), h('ul', { class: 'why' }, x.why.map((w) => h('li', { text: w }))), trig),
      h('div', {}, h('div', { class: 'biglabel', text: 'Execution' }), h('div', { class: `exec ${x.tone}`, text: x.execution }), h('div', { class: 'biglabel next', text: 'Next' }), h('div', { text: x.next }))))
}

// ---- Missions and the Flight Recorder -------------------------------------------

export function missionsScreen(state, ctx) {
  // Every mission of the workspace (ctx.all), or just the one loaded.
  const all = ctx.all?.length ? ctx.all : [{ mission_id: state.story?.result?.mission_id ?? state.mission ?? null, state }]
  const open = all.find((m) => m.mission_id && m.mission_id === ctx.route?.arg)
  if (open) {
    const bad = storyProblem(open.state, 'mission')
    return bad ?? flightRecorder(open.state, ctx)
  }
  if (all.length === 1) {
    const bad = storyProblem(all[0].state, 'mission')
    if (bad) return bad
  }
  const rank = (m) => (m.state?.story?.ok ? urgency(m.state.story.result, verifiedOk(m.state)) : 6)
  const sorted = [...all].sort((a, b) => rank(a) - rank(b) || String(a.mission_id).localeCompare(String(b.mission_id)))
  return h('div', { class: 'reveal' },
    h('div', { class: 'row' }, h('h1', { text: 'Missions' }), h('span', { class: 'count', text: `${all.length} in this workspace` }), h('span', { class: 'spacer' }), h('span', { class: 'muted', text: 'most urgent first · open a mission to see its Flight Recorder' })),
    triage(sorted),
    h('div', { class: 'cards' }, sorted.map((m, i) => missionCard(m, i, ctx))),
    h('hr', { class: 'stitch' }),
    h('h2', { text: 'What the colours mean' }),
    h('div', { class: 'legend' }, [['SAFE · VERIFIED · RECOVERED', 'ok', 'measured and checked against signed receipts'], ['NEEDS APPROVAL · CONFLICT', 'warn', 'waiting for the operator, or requirements that cannot all hold'], ['DATA LOSS · LOGIC BYPASS', 'bad', 'blocked, with the measured evidence'], ['REPAIRED', 'fix', 'revised plan rehearsed SAFE'], ['UNVERIFIABLE', 'mute', 'the chain cannot show it']].map(([t, tone, d]) => h('div', {}, badge(t, tone), h('span', { class: 'muted', text: d })))))
}

/** The five-second view: how many missions need a person, are blocked, are proven. */
function triage(list) {
  const counts = { warn: 0, bad: 0, ok: 0, mute: 0 }
  for (const m of list) {
    const story = m.state?.story?.ok ? m.state.story.result : null
    const tone = story ? missionVerdict(story, verifiedOk(m.state)).tone : 'mute'
    if (story && (story.requests ?? []).some((q) => q.state === 'pending')) counts.warn++
    else if (tone === 'bad') counts.bad++
    else if (tone === 'mute') counts.mute++
    else counts.ok++
  }
  const tile = (n, label, tone, href) => h(href ? 'a' : 'div', { class: `tri ${tone}${n ? '' : ' zero'}`, ...(href ? { href } : {}) }, h('div', { class: 'tri-n', text: String(n) }), h('div', { class: 'tri-l', text: label }))
  return h('div', { class: 'triage', role: 'group', 'aria-label': 'Missions by state' },
    tile(counts.warn, 'need your decision', 'warn', counts.warn ? '#/approvals' : null), tile(counts.bad, 'blocked or broken', 'bad'), tile(counts.ok, 'safe, proven or recovered', 'ok'), tile(counts.mute, 'no signed record or not verified', 'mute'))
}

/** One mission card. A mission whose chain cannot be read says so; nothing is filled in. */
function missionCard(m, i, ctx = {}) {
  const st = m.state
  const problem = cliProblem(st?.story)
  if (problem) {
    const none = st?.story?.error?.code === 'NO_RECEIPTS'
    return h('div', { class: 'card empty', 'data-i': i },
      h('div', { class: 'row' }, h('h2', { class: 'mono', text: m.mission_id ?? 'mission' }), h('span', { class: 'spacer' }), badge(none ? 'NO SIGNED RECORD' : 'UNREADABLE', 'mute')),
      h('p', { class: 'muted', text: none ? 'This mission has no receipts, so the Console has nothing signed to show. A rehearsal that JustRunMe refused before it ran (for example CONFLICT: requirements unsatisfiable) writes no receipt.' : problem }))
  }
  const s = st.story.result
  const v = missionVerdict(s, verifiedOk(st))
  const last = s.timeline.at(-1)
  const nodes = nodesOf(s, st)
  const pending = (s.requests ?? []).some((q) => q.state === 'pending')
  // A human title only from a genuine source: the manifest of the recorded run. Live missions keep their id.
  const title = ctx.titles?.[s.mission_id] ?? null
  return h('a', { class: `card tone-${v.tone}${pending ? ' pending' : ''}`, href: `#/missions/${s.mission_id}`, 'aria-label': `Open the Flight Recorder of ${s.mission_id}`, 'data-i': i },
    h('div', { class: 'row' },
      h('div', { class: 'card-title' }, title ? h('h2', { text: title }) : null, h(title ? 'div' : 'h2', { class: `mono${title ? ' muted' : ''}`, text: s.mission_id })),
      h('span', { class: 'spacer' }), badge(v.label, v.tone, v.tone === 'ok' ? 'bolt' : v.tone === 'warn' ? 'lock' : null)),
    h('ol', { class: 'mini', 'aria-label': 'Flight steps' }, nodes.map((n) => h('li', { class: n.state, title: `${n.name}: ${n.note}` }, h('span', { class: 'sr', text: `${n.name}: ${nodeLabel(n)}` })))),
    summaryLine(missionSummary(s, verifiedOk(st))),
    h('div', { class: 'row meta' }, h('span', { text: last ? `last step: #${last.seq} ${last.kind}${last.verdict ? ` · ${last.verdict}` : ''} · ${fmtTime(last.at)}` : 'no receipts' }), h('span', { class: 'spacer' }), h('span', { class: 'open-fr', text: 'Open Flight Recorder →' })))
}

/** Revisions as chips (#0 DATA LOSS, #1 LOGIC BYPASS, #2 SAFE), then the outcome in words. */
function summaryLine(sum) {
  return h('div', { class: 'sumline' },
    h('span', { class: 'revs' }, sum.revisions.flatMap((r, i) => [i ? h('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' }) : null, h('span', { class: `pill ${r.tone}`, text: `#${r.seq} ${r.verdict}` })])),
    h('span', { class: 'outcome', text: sum.outcome }))
}

function flightRecorder(state, ctx) {
  const s = state.story.result
  const nodes = nodesOf(s, state)
  ctx = { ...ctx, story: s }
  const wanted = (ctx.route.sub ?? ctx.ui.node ?? '').toUpperCase()
  const chosen = nodes.find((n) => n.name === wanted) ?? nodes.find((n) => n.state === 'bad' || n.state === 'warn') ?? [...nodes].reverse().find((n) => n.state !== 'missing') ?? nodes[0]
  const v = missionVerdict(s, verifiedOk(state))
  return h('div', {},
    h('div', { class: 'row' }, h('a', { href: '#/missions', class: 'back', text: '← Missions' }), h('h1', { text: 'Flight Recorder' }), mission(s), h('span', { class: 'spacer' }), badge(v.label, v.tone, v.tone === 'ok' ? 'bolt' : null)),
    ctx.titles?.[s.mission_id] ? h('p', { class: 'fr-title', text: ctx.titles[s.mission_id] }) : null,
    summaryLine(missionSummary(s, verifiedOk(state))),
    h('ol', { class: 'flight', 'aria-label': 'Flight Recorder: the steps of this mission' }, nodes.map((n, i) => h('li', { class: `node ${n.state}${n === chosen ? ' on' : ''}` },
      h('a', { href: `#/missions/${s.mission_id}/${n.name.toLowerCase()}`, 'aria-current': n === chosen ? 'step' : null, 'aria-label': `${i + 1}. ${n.name}: ${nodeLabel(n)}. ${n.note}` },
        h('span', { class: 'disc' }, icon(NODE_ICON[n.state]), n.name === 'VERIFIED' && n.state === 'ok' ? h('span', { class: 'spark', title: 'verified: the real result equals the rehearsal' }, icon('spark')) : null), h('span', { class: 'name', text: n.name }), h('span', { class: 'nnote', text: n.state === 'missing' ? 'not in the chain' : n.note }))))),
    h('section', { class: 'panel evidence', 'aria-live': 'polite' }, evidence(chosen, s, ctx)))
}

function evidence(n, s, ctx) {
  const head = h('div', { class: 'row' }, h('h2', { text: n.name }), badge(nodeLabel(n).toUpperCase(), n.state === 'missing' ? 'mute' : n.state), h('span', { class: 'muted', text: n.note }))
  if (n.state === 'missing') return h('div', {}, head, stateBox('empty', 'Not in the signed chain', `${n.note}. This step is shown greyed because the chain holds nothing for it; it is not filled in.`))
  const parts = [head]
  if (n.version && ['PROPOSED', 'REHEARSED', 'DENIED', 'REPAIRED'].includes(n.name)) parts.push(hero(n.version, ctx))
  if (n.version?.available) parts.push(versionEvidence(n, ctx))
  if (n.request) parts.push(requestEvidence(n.request, s))
  if (n.run) parts.push(runEvidence(n.run, s))
  if (n.receipt) parts.push(receiptBlock(n.receipt, s, ctx))
  return h('div', {}, parts)
}

function versionEvidence(n, ctx) {
  const v = n.version
  const rows = tableLines(v)
  const sql = n.from ? sqlCompare(sqlOf(n.from), sqlOf(v), { left: `#${n.from.seq} ${n.from.verdict}`, right: `#${v.seq} ${v.verdict}`, ui: ctx.ui, key: 'flightSql' }) : sqlView(sqlOf(v), { title: `SQL · #${v.seq}`, sub: v.plan_id })
  return h('div', { class: 'grid2 wide-left' },
    h('div', { class: 'minw0' }, sql),
    h('div', {}, h('h3', { text: 'Rows lost (measured on a disposable copy)' }),
      h('div', { class: 'row' }, h('div', {}, h('div', { class: `big ${losses(v).rows_lost > 0 ? 'bad' : 'ok'}`, text: losses(v).rows_lost }), h('div', { class: 'biglabel', text: 'protected rows lost' })), badge(v.verdict, toneOf(v.verdict))),
      rowsTable(rows), h('p', { class: 'muted', text: lossText(v) }),
      h('div', { class: 'kv' }, h('span', { text: 'report' }), hashChip(v.report_hash))))
}

function rowsTable(rows) {
  if (rows.length === 0) return h('p', { class: 'muted', text: 'No protected table in this report.' })
  const max = Math.max(1, ...rows.flatMap((t) => [t.before ?? 0, t.after ?? 0]))
  return h('div', { class: 'bars' }, rows.map((t) => bar(t.name, { rows_before: t.before, rows_after: t.after, rows_lost: t.lost, protected: true }, max)))
}

function requestEvidence(q, s) {
  const src = approvalSource(q.authorization?.passphrase_source)
  return h('div', { class: 'kv-list' },
    kv('request', h('span', { class: 'mono', text: q.request_id })), kv('plan', h('span', { class: 'mono', text: q.plan_id })), kv('state', badge(q.state, toneOf(q.state))),
    q.authorization ? kv('approved how', h('span', {}, badge(src.label, src.tone, src.tone === 'ok' ? 'lock' : null), ' ', src.note)) : null,
    q.denial_reason ? kv('reason', h('span', { text: q.denial_reason })) : null,
    q.authorization ? kv('links', h('span', { class: 'row' }, ['APPROVED_VERSION_SAFE', 'AUTHORIZED_AS_REQUESTED'].map((c) => h('span', { class: 'mono' }, ok(linkOk(s.links.find((l) => l.request_id === q.request_id), c)), ` ${c}`)))) : null)
}

function runEvidence(r, s) {
  const set = s.links.find((l) => l.request_id === r.request_id)
  return h('div', { class: 'kv-list' },
    kv('verdict', badge(r.verdict, toneOf(r.verdict))), kv('capture', h('span', { class: 'mono', text: r.capture_id ?? '—' })),
    kv('as rehearsed', r.matches_rehearsal === true ? badge('real result equals the rehearsal', 'ok', 'bolt') : r.matches_rehearsal === false ? badge(`${r.differences} difference(s)`, 'bad', 'cross') : badge('not recorded', 'mute')),
    r.undo ? kv('undo', badge(`${r.undo.verdict} · recovery check ${r.undo.verification ?? '—'}`, undoTone(r.undo))) : null,
    set ? kv('links', h('span', { class: 'col' }, set.links.map((l) => h('span', { class: 'mono' }, ok(l.ok), ` ${l.code}${l.ok ? '' : ` — ${l.why}`}`)))) : null)
}

const kv = (k, v) => h('div', { class: 'kv' }, h('span', { text: k }), v)

/** The receipt behind a node: hash, sequence, signature state and, on request, its raw fields. */
function receiptBlock(r, s, ctx) {
  const t = s.timeline.find((x) => x.seq === r.seq)
  const detail = h('div', { class: 'kv-list' })
  const fill = async () => {
    detail.replaceChildren(h('span', { class: 'muted', text: 'Reading the receipt…' }))
    try {
      const out = await ctx.api(`/api/receipt/${r.seq}`)
      const x = out.result?.receipt
      if (!x) throw new Error(cliProblem(out) ?? 'no receipt')
      detail.replaceChildren(kv('previous', hashChip(x.prev_hash)), kv('operator key', hashChip(x.operator_pubkey, 16)), kv('signature', hashChip(x.signature, 16)), kv('chain verifies', badge(out.result.chain_ok ? 'yes' : 'no', out.result.chain_ok ? 'ok' : 'bad')))
    } catch (e) {
      detail.replaceChildren(stateBox('error', 'The receipt could not be read', e.message))
    }
  }
  const more = h('button', { type: 'button', class: 'ghost', text: 'Show signature details' })
  more.addEventListener('click', () => { more.remove(); fill() })
  return h('div', { class: 'receipt' }, h('h3', { text: 'Receipt' }),
    h('div', { class: 'kv-list' }, kv('receipt', h('span', { class: 'mono', text: `#${r.seq}${t ? ` ${t.kind}` : ''}` })), kv('hash', hashChip(r.hash, 22)), kv('signature', sigBadge(s, r.seq))), detail, more)
}

/** One colour per recovery state: PASS with its checks listed, PASS from an older receipt, FAIL, anything else. */
const undoTone = (u) => (u.verification === 'PASS' ? (u.receipt_format === 'current' ? 'ok' : 'warn') : u.verification === 'FAIL' ? 'bad' : 'mute')

const sigBadge = (s, seq) => (s.chain_ok && !(s.chain_findings ?? []).some((f) => f.seq === seq) ? badge('verified by the chain check', 'ok', 'check') : badge('does not verify', 'bad', 'cross'))

// ---- Impact Diff and the Counterfactual Replay -----------------------------------

export function impactScreen(state, ctx) {
  const bad = storyProblem(state, 'impact diff')
  if (bad) return bad
  const s = state.story.result
  ctx = { ...ctx, story: s }
  const versions = s.versions.filter((v) => v.available)
  if (versions.length === 0) return stateBox('empty', 'No archived rehearsal to compare', 'The plan history has no readable rehearsal for this mission yet.')
  // Default: the most severe measured loss on the left, the latest SAFE plan on the right.
  const worst = severest(s)
  const safe = latestSafe(s)
  const pickA = ctx.ui.impactA ?? worst?.seq ?? versions[0].seq
  const pickB = ctx.ui.impactB ?? safe?.seq ?? versions.at(-1).seq
  const a = versions.find((v) => v.seq === pickA) ?? versions[0]
  const b = versions.find((v) => v.seq === pickB) ?? versions.at(-1)
  const chooser = (label, current, key) => h('label', {}, label, h('select', { onChange: (e) => { ctx.ui[key] = Number(e.target.value); ctx.rerender() } },
    versions.map((v) => h('option', { value: v.seq, selected: v.seq === current.seq, text: `Revision #${v.seq} · ${v.verdict} (${v.plan_id})` }))))
  return h('div', { class: 'reveal' },
    h('div', { class: 'row' }, h('h1', { text: 'Impact Diff' }), mission(s)),
    impactHeadline(a, b),
    hero(a, ctx),
    counterfactualPanel(s),
    h('hr', { class: 'stitch' }),
    h('div', { class: 'row' }, h('h2', { text: 'Revision against revision' }), h('span', { class: 'spacer' }), chooser('Left', a, 'impactA'), chooser('Right', b, 'impactB')),
    sameBase(a, b) ? null : h('div', { class: 'banner', text: 'Measured on different database states (the base hash differs): compare each card with its own "before", not row for row with the other.' }),
    h('div', { class: 'grid2' }, planCard('Plan A', a), planCard('Plan B', b)),
    h('h2', { text: 'SQL difference' }),
    sqlCompare(sqlOf(a), sqlOf(b), { left: `Revision #${a.seq} ${a.verdict}`, right: `Revision #${b.seq} ${b.verdict}`, ui: ctx.ui, key: 'impactSql' }))
}

/** "1 protected row lost" against "0 lost", in one line, from the two signed reports. */
function impactHeadline(a, b) {
  const la = losses(a).rows_lost
  const lb = losses(b).rows_lost
  return h('section', { class: 'panel versus' },
    h('div', { class: `vs-side ${la > 0 ? 'bad' : 'ok'}` }, h('div', { class: 'biglabel', text: `Revision #${a.seq} · ${a.verdict}` }), h('div', { class: `big ${la > 0 ? 'bad' : 'ok'}`, text: `${la}` }), h('div', { class: 'biglabel', text: `protected row${la === 1 ? '' : 's'} lost` })),
    h('div', { class: 'vs', text: 'vs' }),
    h('div', { class: `vs-side ${lb > 0 ? 'bad' : 'ok'}` }, h('div', { class: 'biglabel', text: `Revision #${b.seq} · ${b.verdict}` }), h('div', { class: `big ${lb > 0 ? 'bad' : 'ok'}`, text: `${lb}` }), h('div', { class: 'biglabel', text: `protected row${lb === 1 ? '' : 's'} lost` })))
}

function counterfactualPanel(s) {
  const c = counterfactual(s)
  const head = h('div', {}, h('h2', { text: 'Counterfactual Replay' }), h('p', { class: 'muted', text: 'Both columns are signed rehearsals on a disposable copy. The denied revision never ran on the real database.' }))
  if (!c) return h('section', { class: 'panel counter' }, head, stateBox('empty', 'Nothing to replay', 'No plan in this mission was denied, so there is no loss to compare. The replay appears when a rehearsal is not SAFE.'))
  const a = c.without.version
  const w = c.with
  return h('section', { class: 'panel counter' }, head,
    h('div', { class: 'grid2 stitched' },
      h('div', { class: 'col without' },
        h('div', { class: 'row' }, h('h3', { text: 'WITHOUT JUSTRUNME' }), badge('PREDICTED BY REHEARSAL', 'mute')),
        h('p', { class: 'muted', text: `Revision #${a.seq} as written, measured on a copy:` }),
        h('div', { class: `big ${losses(a).rows_lost > 0 ? 'bad' : 'ok'}`, text: losses(a).rows_lost }), h('div', { class: 'biglabel', text: 'protected rows lost' }),
        rowsTable(c.without.tables), h('p', { text: c.without.text }),
        h('div', { class: 'experiment' }, h('div', { class: 'biglabel', text: 'Recorded experiment T25 v1 (other runs, not this mission)' }),
          h('p', { text: 'One scenario (a migration whose danger is a database-only trigger), 5 runs. Code review only: 5 of 5 reviews said REVIEW: APPROVE. Applied directly, 5 of 5 runs lost 1 of 3 orders.' }), h('p', { class: 'muted mono', text: 'docs/agent-runs/T25-results-v1.md' }))),
      h('div', { class: 'col with' },
        h('div', { class: 'row' }, h('h3', { text: 'WITH JUSTRUNME' }), badge(a.verdict === 'SAFE' ? 'SAFE' : `DENIED · ${a.verdict}`, a.verdict === 'SAFE' ? 'ok' : 'bad', a.verdict === 'SAFE' ? 'bolt' : 'cross')),
        h('div', { class: 'kv' }, h('span', { text: 'evidence' }), hashChip(a.receipt, 18)),
        w.version
          ? h('div', {}, h('p', { class: 'muted', text: `Revision #${w.version.seq}: ${w.version.verdict}.` }),
            h('div', { class: `big ${losses(w.version).rows_lost > 0 ? 'bad' : 'ok'}`, text: losses(w.version).rows_lost }), h('div', { class: 'biglabel', text: 'protected rows lost' }),
            rowsTable(w.tables), h('p', { text: w.ran ? (w.matched ? 'Approved and executed; the real result equals the rehearsal.' : 'Executed, but the real result differs from the rehearsal.') : 'Rehearsed SAFE; not executed yet.' }))
          : h('p', { class: 'muted', text: 'No SAFE revision has been rehearsed yet.' }))))
}

function planCard(title, v) {
  const l = losses(v)
  const tone = toneOf(v.verdict)
  const tables = Object.entries(v.impact.tables)
  const max = Math.max(1, ...tables.map(([, t]) => Math.max(t.rows_before ?? 0, t.rows_after ?? 0)))
  return h('section', { class: `panel plan-card ${tone}`, 'aria-label': `${title}: ${v.verdict}` },
    h('div', { class: 'row' }, h('h3', { text: `${title} · Revision #${v.seq}` }), h('span', { class: 'spacer' }), badge(v.verdict, tone)),
    h('div', { class: 'mono muted', text: `${v.plan_id} · report ${short(v.report_hash)} · base ${short(v.base_hash)}` }),
    h('div', { class: 'row' },
      h('div', {}, h('div', { class: `big ${l.rows_lost > 0 ? 'bad' : 'ok'}`, text: l.rows_lost }), h('div', { class: 'biglabel', text: 'protected rows lost' })),
      h('div', {}, h('div', { class: `big ${l.removed_columns.length + l.removed_tables.length > 0 ? 'bad' : 'ok'}`, text: l.removed_columns.length + l.removed_tables.length }), h('div', { class: 'biglabel', text: 'tables / columns removed' }))),
    h('div', { class: 'bars' }, tables.map(([name, t]) => bar(name, t, max))),
    h('ul', { class: 'delta' },
      l.removed_tables.map((x) => h('li', { class: 'rm', text: `− table ${x}` })), l.removed_columns.map((x) => h('li', { class: 'rm', text: `− column ${x}` })),
      l.removed_logic.map((x) => h('li', { class: 'rm', text: `− ${x}` })), l.changed_logic.map((x) => h('li', { class: 'rm', text: `~ ${x}` })),
      l.added_tables.map((x) => h('li', { class: 'add', text: `+ table ${x}` })), l.added_columns.map((x) => h('li', { class: 'add', text: `+ column ${x}` })),
      v.impact.failed_steps.map((x) => h('li', { class: 'rm', text: `✗ step ${x} failed` }))))
}

function bar(name, t, max) {
  const after = h('span', { class: `fill ${t.rows_lost > 0 ? 'loss' : ''}` })
  const before = h('span', { class: 'fill before' })
  before.style.width = `${(100 * (t.rows_before ?? 0)) / max}%`
  after.style.width = `${(100 * (t.rows_after ?? 0)) / max}%`
  return h('div', { class: 'bar' },
    h('span', { class: 'mono', text: name }),
    h('span', { class: 'track', title: `${t.rows_before ?? '—'} → ${t.rows_after ?? '—'}` }, before, after),
    h('span', { class: `mono ${t.rows_lost > 0 ? 'lossnum' : ''}`, text: `${t.rows_before ?? '—'} → ${t.rows_after ?? '—'}` }))
}

// ---- Approval Center -------------------------------------------------------------

export function approvalsScreen(state, ctx) {
  const problem = cliProblem(state.approvals)
  if (problem) return stateBox('error', 'Approval requests cannot be read', problem)
  const requests = state.approvals.result.requests
  if (requests.length === 0) return h('div', {}, h('h1', { text: 'Approval Center' }), stateBox('empty', 'Nothing to approve', 'No approval request exists. The agent asks with the `request_approval` tool after a SAFE rehearsal; the request then waits here.'))
  // Default: a pending request, else the newest answered one (an approval is the record worth showing), else the newest.
  const newest = (list) => [...list].sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at))[0]
  const answered = requests.filter((q) => q.state !== 'expired' && q.state !== 'pending')
  const id = ctx.ui.request ?? (requests.find((q) => q.state === 'pending') ?? newest(answered.length ? answered : requests)).request_id
  const pick = (rid) => { ctx.ui.request = rid; ctx.rerender() }
  const list = h('div', { class: 'panel' }, h('table', {},
    h('thead', {}, h('tr', {}, ['request', 'plan', 'state', 'requested', 'expires'].map((t) => h('th', { text: t })))),
    h('tbody', {}, requests.map((q) => h('tr', { class: `click ${id === q.request_id ? 'sel' : ''}`, tabindex: '0', onClick: () => pick(q.request_id), onKeydown: (e) => { if (e.key === 'Enter') pick(q.request_id) } },
      h('td', { class: 'mono', text: q.request_id }), h('td', { class: 'mono', text: q.plan_id ?? '—' }), h('td', {}, badge(q.state, toneOf(q.state))),
      h('td', { class: 'mono', text: fmtTime(q.requested_at) }), h('td', { class: 'mono', text: fmtTime(q.expires_at) }))))))
  const detail = h('div', {}, stateBox('loading', 'Loading the request…', 'Reading the exact SQL and the measured impact.'))
  ctx.api(`/api/approvals/${id}`).then((out) => detail.replaceChildren(requestDetail(out, ctx, state))).catch((e) => detail.replaceChildren(stateBox('error', 'The request could not be read', e.message)))
  return h('div', {}, h('h1', { text: 'Approval Center' }), detail, h('h2', { text: 'All requests' }), list)
}

function requestDetail(out, ctx, state) {
  const problem = cliProblem(out)
  if (problem) return stateBox('error', 'The request cannot be shown', problem)
  const r = out.result
  const rep = r.report
  const s = state.story?.result
  const q = s?.requests?.find((x) => x.request_id === r.request_id)
  const requested = s?.versions?.find((v) => v.report_hash === q?.report_hash) ?? null
  const worst = s ? severest(s) : null
  const against = worst && requested && worst.seq !== requested.seq ? worst : null
  const verdict = rep?.valid ? rep.verdict : 'NOT VERIFIED'
  const tone = rep?.valid ? toneOf(rep.verdict) : 'mute'
  const sql = r.files.map((f) => h('div', { class: 'filesql' },
    h('div', { class: 'row' }, h('span', { class: 'mono', text: f.path }), badge(f.matches_now ? 'unchanged since the request' : 'CHANGED since the request', f.matches_now ? 'ok' : 'bad')),
    sqlView(f.sql ?? '-- (file missing)', { title: 'The exact SQL that will run', sub: f.sha256 ? `sha256 ${short(f.sha256, 16)}` : '' })))
  const left = h('div', { class: 'minw0' },
    h('section', { class: `hero ${tone}` },
      h('div', { class: 'hero-top' }, h('span', { class: `hero-label ${tone}` }, icon(tone === 'ok' ? 'shield' : 'alert'), r.state === 'pending' && verdict === 'SAFE' ? 'SAFE · READY FOR YOUR DECISION' : `${verdict} · ${r.state.toUpperCase()}`), h('span', { class: 'muted mono', text: `${r.request_id} · ${r.plan_id}` })),
      h('div', { class: 'hero-head', text: rep?.valid ? `${rep.rows_deleted} row${rep.rows_deleted === 1 ? '' : 's'} deleted in rehearsal${(rep.schema_delta?.removed_columns ?? []).length + (rep.schema_delta?.removed_tables ?? []).length === 0 ? ', no table or column removed' : ''}` : rep?.problem ?? 'The rehearsal report cannot be shown' }),
      r.state === 'approved' ? h('p', { class: 'decided' }, icon('lock'), ` Exact version authorized: revision #${requested?.seq ?? '?'} of ${r.plan_id}, bound to its SQL file hashes and the rehearsed source state.`) : null,
      rehearsalSummary(rep)),
    against ? h('div', {}, h('h2', { text: 'What changed since the plan that lost data' }), sqlCompare(sqlOf(against), sqlOf(requested), { left: `denied #${against.seq} ${against.verdict}`, right: `requested #${requested.seq} ${requested.verdict}`, ui: ctx.ui, key: 'approveSql' })) : null,
    h('h2', { text: r.state === 'pending' ? 'The SQL that will run' : 'The SQL of this request' }), sql,
    h('div', { class: 'note' }, h('div', { class: 'muted', text: `Agent note: ${r.agent_note_is}` }), h('div', { text: r.agent_note || '(none)' })))
  const right = h('div', { class: 'decision-col' }, r.state === 'pending' && !ctx.readOnly ? decide(r, ctx, state, q) : h('section', { class: 'panel decide' }, h('h3', { text: 'How this request was answered' }), howRecorded(r, q)))
  return h('div', { class: 'approve-layout reveal' }, left, right)
}

/** Rows, tables checked and schema change of the requested version, from its signed report. */
function rehearsalSummary(rep) {
  if (!rep?.valid) return h('div', { class: 'banner bad', text: rep?.problem ?? 'The rehearsal report cannot be shown.' })
  const tables = Object.entries(rep.tables ?? {})
  const prot = tables.filter(([, t]) => t.protected)
  const max = Math.max(1, ...tables.map(([, t]) => Math.max(t.rows_before ?? 0, t.rows_after ?? 0)))
  const removed = (rep.schema_delta?.removed_columns ?? []).length + (rep.schema_delta?.removed_tables ?? []).length
  const lost = prot.reduce((n, [, t]) => n + (t.rows_lost ?? 0), 0)
  return h('div', { class: 'rsum' },
    h('div', { class: 'facts' },
      fact(`${lost}`, `protected row${lost === 1 ? '' : 's'} lost`, lost > 0 ? 'bad' : 'ok'),
      fact(`${prot.length}`, `protected table${prot.length === 1 ? '' : 's'} checked`, 'info'),
      fact(`${removed}`, 'tables / columns removed', removed > 0 ? 'bad' : 'ok')),
    h('div', { class: 'bars' }, prot.map(([name, t]) => bar(name, t, max))))
}

const fact = (n, label, tone) => h('div', { class: `fact ${tone}` }, h('div', { class: `big ${tone}`, text: n }), h('div', { class: 'biglabel', text: label }))

/** Scripted against human: said plainly, from the receipt when there is one. */
function howRecorded(r, q) {
  if (r.state === 'approved' && q?.authorization) {
    const src = approvalSource(q.authorization.passphrase_source)
    return h('div', {}, badge(src.label, src.tone, src.tone === 'ok' ? 'lock' : null), h('p', { text: `${src.note}. Authorization #${q.authorization.seq}.` }))
  }
  if (r.state === 'pending') return h('p', { class: 'muted', text: 'Approving on this page records the passphrase source "stdin": the channel, not the person. Approving at a terminal records "tty". A script that sets the passphrase in the environment records "env" and is labelled SCRIPTED.' })
  return h('p', { class: 'muted', text: r.state === 'denied' ? 'The request was rejected; it cannot be approved later.' : 'No approval was recorded for this request.' })
}

/**
 * Approve or reject. The review box is new on every render, so it starts unticked whenever
 * the mission, the request or its report changes (the shell re-renders on any such change).
 * Approve is offered only for an eligible request (model.eligibility); the CLI checks the
 * request, files, report, fingerprint, expiry and single use again. One submission at a time;
 * the passphrase is cleared after every attempt and never stored.
 */
function decide(r, ctx, state, q) {
  const elig = eligibility(r, { storyState: q?.state ?? null, verifyOk: state?.verify?.result?.ok !== false })
  const reviewed = h('input', { id: 'reviewed', type: 'checkbox', disabled: elig.ok ? null : true })
  const pass = h('input', { id: 'passphrase', name: 'jrm-approver-once', type: 'password', autocomplete: 'new-password', spellcheck: 'false', 'aria-describedby': 'approve-msg', disabled: elig.ok ? null : true })
  const eye = h('button', { type: 'button', class: 'eye', 'aria-label': 'Show the passphrase', 'aria-pressed': 'false', title: 'Show or hide the passphrase' }, icon('eye'))
  const approve = h('button', { class: 'approve', type: 'button', text: 'Approve this plan', disabled: true })
  const msg = h('div', { id: 'approve-msg', class: 'inline-msg', role: 'status', 'aria-live': 'polite' })
  const clock = h('span', { class: 'mono countdown' })
  const leftMs = () => Date.parse(r.expires_at) - Date.now()
  const tickClock = () => {
    const ms = Math.max(0, leftMs())
    const m = Math.floor(ms / 60000)
    const sec = Math.floor((ms % 60000) / 1000)
    clock.textContent = ms > 0 ? `expires in ${m}:${String(sec).padStart(2, '0')}` : 'EXPIRED'
    if (ms <= 0 && !done) {
      approve.disabled = true
      msg.replaceChildren(h('div', { class: 'banner bad', text: 'The request expired. The agent can ask again with request_approval.' }))
    }
    if (ms < 5 * 60000) clock.setAttribute('class', 'mono countdown low')
  }
  let done = false
  let busy = false
  const ready = () => elig.ok && !done && !busy && reviewed.checked === true && pass.value.length > 0 && leftMs() > 0
  const refresh = () => {
    approve.disabled = !ready()
  }
  if (typeof setInterval === 'function' && typeof clock.isConnected === 'boolean') {
    const t = setInterval(() => (clock.isConnected ? tickClock() : clearInterval(t)), 1000)
  }
  tickClock()
  const submit = async () => {
    if (busy || done) return
    if (!ready()) {
      msg.replaceChildren(h('span', { class: 'bad-text', text: !elig.ok ? 'This request cannot be approved.' : !reviewed.checked ? 'Tick the review box first.' : leftMs() <= 0 ? 'The request expired.' : 'Type the approver passphrase.' }))
      return
    }
    busy = true
    ctx.ui.submitting = true
    approve.disabled = true
    approve.textContent = 'Approving…'
    reviewed.disabled = true
    msg.replaceChildren(h('span', { class: 'muted working', text: 'The CLI checks the request, the files, the rehearsal and the fingerprint again, then decrypts the approver key' }))
    try {
      const out = await ctx.api('/api/approve', { method: 'POST', body: { request_id: r.request_id, confirm: r.plan_id, passphrase: pass.value } })
      pass.value = ''
      const bad = cliProblem(out)
      if (bad) {
        msg.replaceChildren(h('div', { class: 'banner bad shake', text: bad }))
        return
      }
      done = true
      approve.textContent = 'Approved'
      msg.replaceChildren(h('div', { class: 'banner good pop' }, icon('check'), ` ${outcomeText(out)}`))
      setNotice(ctx, ctx.mission ?? out.result?.mission_id, 'good', out)
      await ctx.reload()
    } catch (e) {
      msg.replaceChildren(h('div', { class: 'banner bad shake', text: e.message }))
    } finally {
      pass.value = ''
      busy = false
      ctx.ui.submitting = false
      if (!done) {
        approve.textContent = 'Approve this plan'
        reviewed.disabled = !elig.ok
      }
      refresh()
    }
  }
  reviewed.addEventListener('change', refresh)
  pass.addEventListener('input', refresh)
  pass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault?.()
      submit()
    }
  })
  eye.addEventListener('click', () => {
    const show = pass.getAttribute('type') === 'password'
    pass.setAttribute('type', show ? 'text' : 'password')
    eye.setAttribute('aria-pressed', show ? 'true' : 'false')
    eye.setAttribute('aria-label', show ? 'Hide the passphrase' : 'Show the passphrase')
  })
  approve.addEventListener('click', submit)

  const reason = h('input', { id: 'reason', autocomplete: 'off', placeholder: 'why' })
  const deny = h('button', { class: 'deny', type: 'button', text: 'Reject' })
  const denyMsg = h('div', { class: 'inline-msg', role: 'status', 'aria-live': 'polite' })
  let denying = false
  deny.addEventListener('click', async () => {
    if (denying) return
    denying = true
    ctx.ui.submitting = true
    deny.disabled = true
    denyMsg.replaceChildren(h('span', { class: 'muted working', text: 'Rejecting' }))
    try {
      const out = await ctx.api('/api/deny', { method: 'POST', body: { request_id: r.request_id, reason: reason.value } })
      const bad = cliProblem(out)
      denyMsg.replaceChildren(bad ? h('div', { class: 'banner bad shake', text: bad }) : h('div', { class: 'banner good pop', text: outcomeText(out) }))
      if (!bad) {
        setNotice(ctx, ctx.mission ?? out.result?.mission_id, 'good', out)
        await ctx.reload()
      }
    } catch (e) {
      denyMsg.replaceChildren(h('div', { class: 'banner bad shake', text: e.message }))
    } finally {
      denying = false
      ctx.ui.submitting = false
      deny.disabled = false
    }
  })

  return h('div', { class: 'decision' },
    h('section', { class: `panel decide approve-box${elig.ok ? '' : ' blocked'}` },
      h('div', { class: 'row' }, h('h3', { text: 'Your decision' }), h('span', { class: 'spacer' }), clock),
      elig.ok
        ? h('div', { class: 'checklist' }, h('div', {}, icon('check'), ' exact SQL shown (left)'), h('div', {}, icon('check'), ' rehearsal measured on a disposable copy'), h('div', {}, icon('check'), ' files unchanged since the request'))
        : h('div', { class: 'banner bad' }, h('div', {}, h('strong', { text: 'Approve is not offered' }), h('ul', { class: 'why' }, elig.reasons.map((x) => h('li', { text: x }))))),
      h('label', { class: 'check', for: 'reviewed' }, reviewed, h('span', {}, 'I reviewed the SQL and the measured rehearsal diff ', h('code', { class: 'mono', text: `(${r.plan_id})` }))),
      h('label', { for: 'passphrase' }, 'Approver passphrase', h('span', { class: 'pass-wrap' }, pass, eye)),
      h('div', { class: 'row' }, approve, h('span', { class: 'muted', text: 'Enter also approves' })),
      msg,
      h('details', { class: 'how' }, h('summary', { text: 'How approval is signed' }),
        h('p', { class: 'muted', text: 'The passphrase goes to `justrunme approve --passphrase-stdin` in a separate process; this page and the Console server never hold the approver key. The CLI checks again that the request is pending and unexpired, the files are unchanged, the rehearsal was SAFE and the database still matches the rehearsed fingerprint, then signs the authorization with the approver key. A request can be approved once.' }),
        howRecorded(r, null))),
    h('section', { class: 'panel decide reject-box' }, h('h3', { text: 'Reject' }), h('p', { class: 'muted', text: 'Needs a reason, no passphrase. A rejected request cannot be approved later.' }),
      h('label', { for: 'reason' }, 'Reason', reason), h('div', { class: 'row' }, deny), denyMsg))
}

/**
 * Keep the outcome of Approve, Reject or Undo in ctx.ui.notice so it survives ctx.reload()
 * (which rebuilds the whole view). It is cleared by its dismiss button or a mission switch.
 * The receipt shown is the one the CLI returned; when it returns none, the newest receipt
 * of the reloaded chain is shown with its kind, so the operator sees what it is.
 */
export function setNotice(ctx, mission, tone, out) {
  ctx.ui.notice = { mission, tone, text: outcomeText(out), command: out.command, receipt_hash: out.result?.receipt_hash ?? null }
}

/** @returns {HTMLElement | null} the persistent confirmation, or null when none applies to this mission. */
export function noticeBar(notice, state, ctx, mission) {
  if (!notice || notice.mission !== mission) return null
  const tl = state?.story?.result?.timeline ?? []
  const last = tl.length ? tl[tl.length - 1] : null
  const hash = notice.receipt_hash ?? last?.hash ?? null
  const seq = notice.receipt_hash ? tl.find((x) => x.hash === notice.receipt_hash)?.seq : last?.seq
  const dismiss = h('button', { class: 'ghost dismiss', type: 'button', 'aria-label': 'Dismiss this confirmation', text: 'Dismiss' })
  dismiss.addEventListener('click', () => {
    ctx.ui.notice = null
    ctx.rerender?.()
  })
  return h('div', { class: `notice ${notice.tone === 'good' ? 'good' : 'bad'} pop`, role: 'status', 'aria-live': 'polite' },
    icon(notice.tone === 'good' ? 'check' : 'alert'),
    h('div', { class: 'notice-body' },
      h('div', { text: notice.text }),
      hash
        ? h('div', { class: 'row' }, h('span', { class: 'muted', text: `signed receipt${seq === undefined || seq === null ? '' : ` #${seq}`}${notice.receipt_hash ? '' : ' (newest in the chain)'}` }), hashChip(hash, 16), h('a', { href: `#/missions/${encodeURIComponent(mission)}`, text: 'Open in the Flight Recorder' }))
        : h('div', { class: 'muted', text: 'No signed receipt was returned for this action.' })),
    dismiss)
}

function outcomeText(out) {
  const r = out.result ?? {}
  if (out.command === 'approve') return `Approved ${r.request_id} for ${r.plan_id}; authorization expires ${fmtTime(r.expires_at)}; passphrase ${passphraseWords(r.passphrase_source)}.`
  if (out.command === 'deny') return `Rejected ${r.request_id}.`
  if (out.command === 'undo') return `Undo ${r.capture_id}: ${r.status}; recovery check ${r.verification?.status ?? '—'}.`
  return 'Done.'
}

// ---- Recovery & Replay and the receipt chain ----------------------------------------

export function recoveryScreen(state, ctx) {
  const bad = storyProblem(state, 'receipt chain')
  if (bad) return bad
  const s = state.story.result
  const v = state.verify
  const replayOut = h('div', { class: 'result', 'aria-live': 'polite' })
  const replayBtn = h('button', { type: 'button', text: 'Replay every selection' })
  replayBtn.addEventListener('click', async () => {
    replayBtn.disabled = true
    replayOut.replaceChildren(stateBox('loading', 'Replaying…', ''))
    try {
      const out = await ctx.api('/api/replay')
      replayOut.replaceChildren(cliProblem(out) && !out.result ? h('div', { class: 'banner bad', text: cliProblem(out) }) : h('div', { class: out.result?.ok ? 'banner good' : 'banner bad', text: out.result?.ok ? 'Replay PASS: every recorded selection follows from the signed reports.' : `Replay FAIL: ${(out.result?.findings ?? []).map((x) => x.code ?? x.problem).join(', ')}` }))
    } catch (e) {
      replayOut.replaceChildren(h('div', { class: 'banner bad', text: e.message }))
    } finally {
      replayBtn.disabled = false
    }
  })
  const vr = v?.result
  const sum = recoverySummary(s, verifiedOk(state))
  return h('div', {},
    h('div', { class: 'row' }, h('h1', { text: 'Recovery & Replay' }), mission(s)),
    h('section', { class: `hero ${sum.tone} rsummary`, 'aria-label': sum.label },
      h('div', { class: 'hero-top' }, h('span', { class: `hero-label ${sum.tone}` }, icon(sum.tone === 'ok' ? 'shield' : sum.tone === 'bad' ? 'alert' : 'dash'), sum.label)),
      h('div', { class: 'links' }, sum.lines.map((l) => h('div', { class: 'link' }, h('span', { class: l.ok === true ? 'y' : l.ok === false ? 'n' : 'u' }, icon(l.ok === true ? 'check' : l.ok === false ? 'cross' : 'dash')), h('span', { text: l.text })))),
      sum.limit ? h('div', { class: 'callout warn limit' }, icon('alert'), h('span', { text: sum.limit })) : null),
    h('h2', { text: 'Runs and undo' }),
    h('section', { class: 'panel' }, runsTable(s.runs, ctx)),
    h('div', { class: 'grid2' },
      h('section', { class: 'panel' }, h('h3', { text: 'Verification' }),
        vr ? h('div', { class: 'links' },
          checkLine('receipt chain', vr.chain_findings.length === 0, `${vr.receipts} receipts`),
          checkLine('ordering policy', vr.policy_findings.length === 0, vr.policy_findings.map((x) => x.code ?? x.problem).join(', ')),
          checkLine('plan history archive', vr.history?.ok === true, `${vr.history?.versions ?? 0} versions${vr.history?.legacy_versions ? `, ${vr.history.legacy_versions} older than the archive` : ''}`),
          checkLine('selections replayed', vr.selections.every((x) => x.ok), `${vr.selections.length} selection(s)`))
          : stateBox('error', 'Verification did not run', cliProblem(v) ?? 'no verification'),
        h('div', { class: 'row result' }, replayBtn), replayOut),
      h('section', { class: 'panel' }, h('h3', { text: 'Links from approval to result' }),
        s.links.length === 0 ? h('p', { class: 'muted', text: (s.runs ?? []).some((r) => r.authorization && !r.request_id) ? 'Authorized at the command line: there is no approval request to link to the run.' : 'No approved request yet.' }) : s.links.map((set) => h('div', {}, h('div', { class: 'mono muted', text: `${set.request_id} · ${set.plan_id}` }),
          h('div', { class: 'links' }, set.links.map((l) => checkLine(l.code, l.ok, l.why ?? ''))))))),
    h('details', { class: 'panel chain-box' }, h('summary', {}, h('span', { text: `Receipt chain · ${s.timeline.length} signed receipts` }), ' ', s.chain_ok ? badge('verified', 'ok', 'bolt') : badge('does not verify', 'bad', 'cross')),
      receiptChain(s, ctx)))
}

function receiptChain(s, ctx) {
  const rows = receiptRows(s)
  if (rows.length === 0) return stateBox('empty', 'No receipts', 'The chain of this mission is empty.')
  const broken = rows.filter((r) => !r.sig).length
  const open = h('div', { 'aria-live': 'polite' })
  return h('div', {},
    h('div', { class: 'row' }, broken === 0 ? badge(`chain verified · ${rows.length} receipts`, 'ok', 'bolt') : badge(`${broken} finding${broken === 1 ? '' : 's'}`, 'bad', 'cross'), h('span', { class: 'muted', text: 'Each signature is checked by `justrunme verify` when the page loads; the mark is that result, not a check made in your browser.' })),
    h('ol', { class: 'chain' }, rows.map((r) => h('li', { class: r.tone },
      h('span', { class: `sig ${r.sig ? 'y' : 'n'}`, 'aria-label': r.sig ? 'signature verified' : 'does not verify' }, icon(r.sig ? 'check' : 'cross')),
      h('span', { class: 'mono seq', text: `#${r.seq ?? '—'}` }), h('span', { class: 'kind', text: r.kind }),
      r.verdict ? badge(r.verdict, r.tone) : h('span'), h('span', { class: 'mono muted', text: r.at ? fmtTime(r.at) : '' }),
      r.problem ? h('span', { class: 'bad-text', text: r.problem }) : hashChip(r.hash, 16),
      r.hash ? h('button', { type: 'button', class: 'ghost', text: 'Details', onClick: async () => {
        open.replaceChildren(stateBox('loading', 'Reading the receipt…', ''))
        const out = await ctx.api(`/api/receipt/${r.seq}`).catch((err) => ({ ok: false, error: { code: 'ERROR', message: err.message } }))
        open.replaceChildren(sqlView(JSON.stringify(out.result ?? out.error, null, 2), { title: `Receipt #${r.seq}`, sub: r.kind }))
      } }) : h('span')))),
    open)
}

function checkLine(name, good, why) {
  return h('div', { class: 'link' }, h('span', { class: good ? 'y' : 'n' }, icon(good ? 'check' : 'cross', good ? 'holds' : 'broken')), h('span', { text: name }), h('span', { class: 'muted', text: why ?? '' }))
}

function runsTable(runs, ctx) {
  if (runs.length === 0) return stateBox('empty', 'No real run yet', 'Nothing has run on the real database for this mission, so there is nothing to undo.')
  return h('table', {},
    h('thead', {}, h('tr', {}, ['#', 'when', 'plan', 'verdict', 'as rehearsed', 'capture', 'undo'].map((t) => h('th', { text: t })))),
    h('tbody', {}, runs.map((r) => h('tr', {},
      h('td', { class: 'mono', text: r.seq }), h('td', { class: 'mono', text: fmtTime(r.at) }), h('td', { class: 'mono', text: r.plan_id }),
      h('td', {}, badge(r.verdict, toneOf(r.verdict))),
      h('td', {}, r.matches_rehearsal === true ? badge('matched', 'ok', 'check') : r.matches_rehearsal === false ? badge(`${r.differences} diff`, 'bad', 'cross') : badge('not recorded', 'mute')),
      h('td', { class: 'mono', text: r.capture_id ?? '—' }),
      h('td', {}, r.undo ? badge(`${r.undo.verdict} · ${r.undo.verification ?? '—'}`, undoTone(r.undo)) : ctx.readOnly ? h('span', { class: 'muted', text: 'read only' }) : undoForm(r, ctx))))))
}

function undoForm(r, ctx) {
  if (!r.capture_id) return h('span', { class: 'muted', text: '—' })
  // Two clicks: "Undo Mission", then "Confirm Undo <capture id>". The second sends the capture id as the confirmation.
  const box = h('div', { class: 'undo-box' })
  const result = h('div', { class: 'inline-msg', 'aria-live': 'polite' })
  const first = h('button', { class: 'undo', type: 'button', text: 'Undo Mission' })
  const show = (...kids) => box.replaceChildren(...kids, result)
  first.addEventListener('click', () => {
    const confirm = h('button', { class: 'undo confirm', type: 'button' }, 'Confirm Undo ', h('code', { class: 'mono', text: r.capture_id }))
    const cancel = h('button', { class: 'ghost', type: 'button', text: 'Cancel' })
    cancel.addEventListener('click', () => {
      result.replaceChildren()
      show(first)
    })
    confirm.addEventListener('click', async () => {
      if (ctx.ui.submitting) return
      ctx.ui.submitting = true
      confirm.disabled = true
      cancel.disabled = true
      result.replaceChildren(h('span', { class: 'muted working', text: 'Restoring the captured state, then running the recovery verification' }))
      try {
        const out = await ctx.api('/api/undo', { method: 'POST', body: { capture_id: r.capture_id, confirm: r.capture_id } })
        const bad = cliProblem(out)
        // RECOVERED · VERIFIED is shown only from the verification the CLI returned, never from "no error".
        const st = out.result?.status
        const vs = out.result?.verification?.status
        result.replaceChildren(bad ? h('div', { class: 'banner bad shake', text: bad }) : h('div', { class: st === 'RECOVERED' && vs === 'PASS' ? 'banner good pop' : 'banner bad shake', text: outcomeText(out) }))
        if (!bad) setNotice(ctx, ctx.mission ?? out.result?.mission_id, st === 'RECOVERED' && vs === 'PASS' ? 'good' : 'bad', out)
        ctx.ui.submitting = false
        await ctx.reload()
      } catch (e) {
        result.replaceChildren(h('div', { class: 'banner bad shake', text: e.message }))
        confirm.disabled = false
        cancel.disabled = false
      } finally {
        ctx.ui.submitting = false
      }
    })
    show(h('div', { class: 'row' }, confirm, cancel), h('p', { class: 'muted', text: `Restores what capture ${r.capture_id} recorded before run #${r.seq}: the tracked files, the Postgres databases, the config files and the container images named in the contract; then runs the recovery verification. Writes made to these after the run are discarded. Not undone: network calls, emails, payments or any other external side effect.` }))
  })
  show(first)
  return box
}
