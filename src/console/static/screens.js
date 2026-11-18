// The four Console screens. Each takes the loaded state and a small context
// ({ api, reload, rerender, ui, route }) and returns one DOM node.
//   Missions            cards, then the Flight Recorder of one mission
//   Impact Diff         Counterfactual Replay, then Plan A against Plan B
//   Approval Center     the plan, its measured risk, Approve or Reject
//   Recovery & Replay   runs and undo, verification, the signed receipt chain
// Everything shown is read from the signed chain and the plan history; a step the
// chain does not show is drawn greyed with the reason, never filled in.

import { badge, diffView, fmtTime, h, hashChip, icon, lineDiff, short, sqlOf, stateBox } from './ui.js'
import { approvalSource, counterfactual, flight, focus, headline, lossText, losses, missionVerdict, passphraseWords, receiptRows, sameBase, tableLines, toneOf } from './model.js'

const TONE_LABEL = { ok: 'verified', bad: 'denied', warn: 'needs approval', fix: 'repaired', mute: 'unverifiable', info: 'recorded', missing: 'not in the chain' }
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

// ---- Missions and the Flight Recorder -------------------------------------------

export function missionsScreen(state, ctx) {
  const bad = storyProblem(state, 'mission')
  if (bad) return bad
  const s = state.story.result
  if (ctx.route?.arg === s.mission_id) return flightRecorder(state, ctx)
  const v = missionVerdict(s)
  const last = s.timeline.at(-1)
  const nodes = flight(s)
  return h('div', {},
    h('div', { class: 'row' }, h('h1', { text: 'Missions' }), h('span', { class: 'spacer' }), h('span', { class: 'muted', text: 'one card per mission; open one to see its Flight Recorder' })),
    h('a', { class: 'card', href: `#/missions/${s.mission_id}`, 'aria-label': `Open the Flight Recorder of ${s.mission_id}` },
      h('div', { class: 'row' }, h('h2', { class: 'mono', text: s.mission_id }), h('span', { class: 'spacer' }), badge(v.label, v.tone, v.tone === 'ok' ? 'bolt' : null)),
      h('ol', { class: 'mini', 'aria-label': 'Flight steps' }, nodes.map((n) => h('li', { class: n.state, title: `${n.name}: ${n.note}` }, h('span', { class: 'sr', text: `${n.name}: ${TONE_LABEL[n.state]}` })))),
      story(headline(s)),
      h('div', { class: 'row meta' }, h('span', { text: last ? `last step: #${last.seq} ${last.kind}${last.verdict ? ` · ${last.verdict}` : ''}` : 'no receipts' }), h('span', { class: 'spacer' }), h('span', { class: 'mono', text: last ? fmtTime(last.at) : '' }))),
    h('hr', { class: 'stitch' }),
    h('h2', { text: 'What the colours mean' }),
    h('div', { class: 'legend' }, [['SAFE · VERIFIED', 'ok', 'measured and checked against signed receipts'], ['NEEDS APPROVAL', 'warn', 'waiting for the operator'], ['DENIED', 'bad', 'blocked, with the measured loss'], ['REPAIRED', 'fix', 'revised plan rehearsed SAFE'], ['UNVERIFIABLE', 'mute', 'the chain cannot show it']].map(([t, tone, d]) => h('div', {}, badge(t, tone), h('span', { class: 'muted', text: d })))))
}

function story(beats) {
  return h('ol', { class: 'story' }, beats.map((b, i) => h('li', { class: b.tone }, h('span', { class: 'step', text: `${i + 1}. ${b.step}` }), h('span', { text: b.text }))))
}

function flightRecorder(state, ctx) {
  const s = state.story.result
  const nodes = flight(s)
  const wanted = (ctx.route.sub ?? ctx.ui.node ?? '').toUpperCase()
  const chosen = nodes.find((n) => n.name === wanted) ?? nodes.find((n) => n.state === 'bad' || n.state === 'warn') ?? [...nodes].reverse().find((n) => n.state !== 'missing') ?? nodes[0]
  const v = missionVerdict(s)
  return h('div', {},
    h('div', { class: 'row' }, h('a', { href: '#/missions', class: 'back', text: '← Missions' }), h('h1', { text: 'Flight Recorder' }), mission(s), h('span', { class: 'spacer' }), badge(v.label, v.tone, v.tone === 'ok' ? 'bolt' : null)),
    story(headline(s)),
    h('ol', { class: 'flight', 'aria-label': 'Flight Recorder: the steps of this mission' }, nodes.map((n, i) => h('li', { class: `node ${n.state}${n === chosen ? ' on' : ''}` },
      h('a', { href: `#/missions/${s.mission_id}/${n.name.toLowerCase()}`, 'aria-current': n === chosen ? 'step' : null, 'aria-label': `${i + 1}. ${n.name}: ${TONE_LABEL[n.state]}. ${n.note}` },
        h('span', { class: 'disc' }, icon(NODE_ICON[n.state]), n.name === 'VERIFIED' && n.state === 'ok' ? h('span', { class: 'spark', title: 'verified: the real result equals the rehearsal' }, icon('spark')) : null), h('span', { class: 'name', text: n.name }), h('span', { class: 'nnote', text: n.state === 'missing' ? 'not in the chain' : n.note }))))),
    h('section', { class: 'panel evidence', 'aria-live': 'polite' }, evidence(chosen, s, ctx)))
}

function evidence(n, s, ctx) {
  const head = h('div', { class: 'row' }, h('h2', { text: n.name }), badge(TONE_LABEL[n.state].toUpperCase(), n.state === 'missing' ? 'mute' : n.state), h('span', { class: 'muted', text: n.note }))
  if (n.state === 'missing') return h('div', {}, head, stateBox('empty', 'Not in the signed chain', `${n.note}. This step is shown greyed because the chain holds nothing for it; it is not filled in.`))
  const parts = [head]
  if (n.version?.available) parts.push(versionEvidence(n))
  if (n.request) parts.push(requestEvidence(n.request, s))
  if (n.run) parts.push(runEvidence(n.run, s))
  if (n.receipt) parts.push(receiptBlock(n.receipt, s, ctx))
  return h('div', {}, parts)
}

function versionEvidence(n) {
  const v = n.version
  const rows = tableLines(v)
  const sql = n.from ? diffView(lineDiff(sqlOf(n.from), sqlOf(v))) : h('pre', { class: 'sql', text: sqlOf(v) })
  return h('div', { class: 'grid2' },
    h('div', {}, h('h3', { text: n.from ? `SQL diff: ${n.from.plan_id} → ${v.plan_id}` : `SQL · ${v.plan_id}` }), sql),
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
    r.undo ? kv('undo', badge(`${r.undo.verdict} · recovery check ${r.undo.verification ?? '—'}`, r.undo.verification === 'PASS' ? 'ok' : 'bad')) : null,
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

const sigBadge = (s, seq) => (s.chain_ok && !(s.chain_findings ?? []).some((f) => f.seq === seq) ? badge('verified by the chain check', 'ok', 'check') : badge('does not verify', 'bad', 'cross'))

// ---- Impact Diff and the Counterfactual Replay -----------------------------------

export function impactScreen(state, ctx) {
  const bad = storyProblem(state, 'impact diff')
  if (bad) return bad
  const s = state.story.result
  const versions = s.versions.filter((v) => v.available)
  if (versions.length === 0) return stateBox('empty', 'No archived rehearsal to compare', 'The plan history has no readable rehearsal for this mission yet.')
  const f = focus(s)
  const pickA = ctx.ui.impactA ?? f.a?.seq ?? versions[0].seq
  const pickB = ctx.ui.impactB ?? f.b?.seq ?? versions.at(-1).seq
  const a = versions.find((v) => v.seq === pickA) ?? versions[0]
  const b = versions.find((v) => v.seq === pickB) ?? versions.at(-1)
  const chooser = (label, current, key) => h('label', {}, label, h('select', { onChange: (e) => { ctx.ui[key] = Number(e.target.value); ctx.rerender() } },
    versions.map((v) => h('option', { value: v.seq, selected: v.seq === current.seq, text: `#${v.seq} ${v.plan_id} ${v.verdict}` }))))
  return h('div', {},
    h('div', { class: 'row' }, h('h1', { text: 'Impact Diff' }), mission(s)),
    counterfactualPanel(s),
    h('hr', { class: 'stitch' }),
    h('div', { class: 'row' }, h('h2', { text: 'Plan against plan' }), h('span', { class: 'spacer' }), chooser('Left', a, 'impactA'), chooser('Right', b, 'impactB')),
    sameBase(a, b) ? null : h('div', { class: 'banner', text: 'Measured on different database states (the base hash differs): compare each card with its own "before", not row for row with the other.' }),
    h('div', { class: 'grid2' }, planCard('Plan A', a), planCard('Plan B', b)),
    h('h2', { text: 'SQL difference' }),
    diffView(lineDiff(sqlOf(a), sqlOf(b))))
}

function counterfactualPanel(s) {
  const c = counterfactual(s)
  const head = h('div', {}, h('h2', { text: 'Counterfactual Replay' }), h('p', { class: 'muted', text: 'The same denied plan in two worlds. The measurements in both columns come from signed rehearsals on a disposable copy of this mission; the denied plan never ran on the real database. The experiment line below is not part of this mission. Review verdicts are not recorded in the chain, so none is shown.' }))
  if (!c) return h('section', { class: 'panel counter' }, head, stateBox('empty', 'Nothing to replay', 'No plan in this mission was denied, so there is no loss to compare. The replay appears when a rehearsal is not SAFE.'))
  const a = c.without.version
  const w = c.with
  return h('section', { class: 'panel counter' }, head,
    h('div', { class: 'grid2 stitched' },
      h('div', { class: 'col without' },
        h('div', { class: 'row' }, h('h3', { text: 'WITHOUT JUSTRUNME' }), badge('PREDICTED BY REHEARSAL', 'mute')),
        h('p', { class: 'muted', text: `${a.plan_id} as written. The rehearsal measured this on a copy; it never ran on the real database:` }),
        h('div', { class: `big ${losses(a).rows_lost > 0 ? 'bad' : 'ok'}`, text: losses(a).rows_lost }), h('div', { class: 'biglabel', text: 'protected rows lost' }),
        rowsTable(c.without.tables), h('p', { text: c.without.text }),
        h('div', { class: 'experiment' }, h('div', { class: 'biglabel', text: 'Recorded experiment T25 v1 (other runs, not this mission)' }),
          h('p', { text: 'One scenario (a migration whose danger is a database-only trigger), 5 runs. Code review only: 5 of 5 reviews said REVIEW: APPROVE. Applied directly, 5 of 5 runs lost 1 of 3 orders.' }), h('p', { class: 'muted mono', text: 'docs/agent-runs/T25-results-v1.md' }))),
      h('div', { class: 'col with' },
        h('div', { class: 'row' }, h('h3', { text: 'WITH JUSTRUNME' }), badge(a.verdict === 'SAFE' ? 'SAFE' : `DENIED · ${a.verdict}`, a.verdict === 'SAFE' ? 'ok' : 'bad', a.verdict === 'SAFE' ? 'bolt' : 'cross')),
        h('div', { class: 'kv' }, h('span', { text: 'evidence' }), hashChip(a.receipt, 18)),
        w.version
          ? h('div', {}, h('p', { class: 'muted', text: `Revised plan ${w.version.plan_id}: ${w.version.verdict}.` }),
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
    h('div', { class: 'row' }, h('h3', { text: `${title} · #${v.seq}` }), h('span', { class: 'spacer' }), badge(v.verdict, tone)),
    h('div', { class: 'mono muted', text: `${v.plan_id} · report ${short(v.report_hash)} · base ${short(v.base_hash)}` }),
    h('div', { class: 'row' },
      h('div', {}, h('div', { class: `big ${l.rows_lost > 0 ? 'bad' : 'ok'}`, text: l.rows_lost }), h('div', { class: 'biglabel', text: 'protected rows lost' })),
      h('div', {}, h('div', { class: `big ${l.removed_columns.length + l.removed_tables.length > 0 ? 'bad' : 'ok'}`, text: l.removed_columns.length + l.removed_tables.length }), h('div', { class: 'biglabel', text: 'tables / columns removed' }))),
    h('div', { class: 'bars' }, tables.map(([name, t]) => bar(name, t, max))),
    h('ul', { class: 'delta' },
      l.removed_tables.map((x) => h('li', { class: 'rm', text: `− table ${x}` })), l.removed_columns.map((x) => h('li', { class: 'rm', text: `− column ${x}` })),
      l.removed_logic.map((x) => h('li', { class: 'rm', text: `− ${x}` })), l.changed_logic.map((x) => h('li', { class: 'rm', text: `~ ${x}` })),
      l.added_tables.map((x) => h('li', { class: 'add', text: `+ table ${x}` })), l.added_columns.map((x) => h('li', { class: 'add', text: `+ column ${x}` })),
      v.impact.failed_steps.map((x) => h('li', { class: 'rm', text: `✗ step ${x} failed` }))),
    h('h3', { text: 'SQL' }), h('pre', { class: 'sql', text: sqlOf(v) }))
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
  const id = ctx.ui.request ?? (requests.find((q) => q.state === 'pending') ?? requests.at(-1)).request_id
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
  const changed = r.files.filter((f) => !f.matches_now)
  const left = Date.parse(r.expires_at) - Date.now()
  const q = state.story?.result?.requests?.find((x) => x.request_id === r.request_id)
  const risk = rep?.valid ? { text: rep.verdict, tone: toneOf(rep.verdict) } : { text: 'UNVERIFIABLE', tone: 'mute' }
  const sqlAndImpact = h('div', { class: 'grid2' },
    h('section', { class: 'panel' }, h('h3', { text: 'The SQL that will run' }), r.files.map((f) => h('div', {}, h('div', { class: 'row' }, h('span', { class: 'mono', text: f.path }), badge(f.matches_now ? 'unchanged' : 'changed', f.matches_now ? 'ok' : 'bad')), h('pre', { class: 'sql', text: f.sql ?? '(file missing)' })))),
    h('section', { class: 'panel' }, h('h3', { text: 'Measured in rehearsal' }),
      rep?.valid
        ? h('ul', { class: 'delta' }, (rep.schema_delta?.removed_columns ?? []).map((c) => h('li', { class: 'rm', text: `− column ${c}` })), (rep.schema_delta?.added_columns ?? []).map((c) => h('li', { class: 'add', text: `+ column ${c}` })), (rep.schema_delta?.removed_tables ?? []).map((t) => h('li', { class: 'rm', text: `− table ${t}` })), h('li', { text: `${rep.rows_deleted} rows deleted` }))
        : h('div', { class: 'banner bad', text: rep?.problem ?? 'no report' }),
      h('h3', { text: 'How this approval is recorded' }), howRecorded(r, q)))
  return h('div', {},
    h('section', { class: `panel summary ${risk.tone}` },
      h('div', { class: 'row' }, h('div', {}, h('div', { class: 'biglabel', text: 'RISK VERDICT (measured in rehearsal)' }), h('div', { class: 'verdict' }, badge(risk.text, risk.tone, risk.tone === 'ok' ? 'bolt' : null))),
        h('span', { class: 'spacer' }), badge(r.state.toUpperCase(), toneOf(r.state)), h('span', { class: 'mono', text: r.plan_id }),
        h('span', { class: 'muted', text: r.state === 'pending' ? `expires in ${Math.max(0, Math.round(left / 60000))} min (${fmtTime(r.expires_at)})` : `expires ${fmtTime(r.expires_at)}` })),
      rep?.valid ? h('p', { class: 'lead', text: `${rep.rows_deleted} row${rep.rows_deleted === 1 ? '' : 's'} deleted in rehearsal${(rep.schema_delta?.removed_columns ?? []).length + (rep.schema_delta?.removed_tables ?? []).length === 0 ? ', no table or column removed' : ''}.` }) : h('p', { class: 'lead', text: rep?.problem ?? 'The rehearsal report cannot be shown.' }),
      changed.length ? h('div', { class: 'banner bad', text: `Changed since the request: ${changed.map((f) => f.path).join(', ')}. This request cannot be approved; the agent must rehearse again.` }) : null,
      h('div', { class: 'note' }, h('div', { class: 'muted', text: `Agent note: ${r.agent_note_is}` }), h('div', { text: r.agent_note || '(none)' }))),
    r.state === 'pending' ? decide(r, ctx) : null,
    sqlAndImpact)
}

/** Scripted against human: said plainly, from the receipt when there is one. */
function howRecorded(r, q) {
  if (r.state === 'approved' && q?.authorization) {
    const src = approvalSource(q.authorization.passphrase_source)
    return h('div', {}, badge(src.label, src.tone, src.tone === 'ok' ? 'lock' : null), h('p', { text: `${src.note}. Authorization #${q.authorization.seq}.` }))
  }
  if (r.state === 'pending') return h('p', { class: 'muted', text: 'Approving on this page records the passphrase source "stdin": the channel, not the person. Approving at a terminal records "tty". A script that sets the passphrase in the environment records "env" and is labelled SCRIPTED.' })
  return h('p', { class: 'muted', text: r.state === 'denied' ? 'The request was rejected; it cannot be approved later.' : 'No approval was recorded for this request.' })
}

function decide(r, ctx) {
  const confirm = h('input', { id: 'confirm', autocomplete: 'off', spellcheck: 'false', placeholder: r.plan_id, 'aria-describedby': 'confirm-help' })
  const pass = h('input', { id: 'passphrase', name: 'jrm-approver-once', type: 'password', autocomplete: 'new-password' })
  const reason = h('input', { id: 'reason', autocomplete: 'off', placeholder: 'why' })
  const result = h('div', { class: 'result', 'aria-live': 'polite' })
  const go = (button, path, body) => async () => {
    button.disabled = true
    result.replaceChildren(stateBox('loading', 'Working…', ''))
    try {
      const out = await ctx.api(path, body())
      pass.value = ''
      result.replaceChildren(outcome(out))
      await ctx.reload()
    } catch (e) {
      result.replaceChildren(stateBox('error', 'The action failed', e.message))
    } finally {
      pass.value = ''
      button.disabled = false
    }
  }
  const approve = h('button', { class: 'approve', type: 'button', text: 'Approve this plan' })
  const deny = h('button', { class: 'deny', type: 'button', text: 'Reject' })
  approve.addEventListener('click', go(approve, '/api/approve', () => ({ method: 'POST', body: { request_id: r.request_id, confirm: confirm.value.trim(), passphrase: pass.value } })))
  deny.addEventListener('click', go(deny, '/api/deny', () => ({ method: 'POST', body: { request_id: r.request_id, reason: reason.value } })))
  return h('div', { class: 'grid2' },
    h('section', { class: 'panel decide approve-box' }, h('h3', { text: 'Approve' }),
      h('p', { class: 'muted', id: 'confirm-help', text: `Type the plan id (${r.plan_id}) and the approver passphrase. The passphrase goes to \`justrunme approve --passphrase-stdin\`; this page and the server never hold the approver key.` }),
      h('div', { class: 'row' }, h('label', { for: 'confirm' }, 'Plan id', confirm), h('label', { for: 'passphrase' }, 'Approver passphrase', pass), approve)),
    h('section', { class: 'panel decide reject-box' }, h('h3', { text: 'Reject' }), h('p', { class: 'muted', text: 'Rejecting needs a reason, no passphrase. A rejected request cannot be approved later.' }),
      h('div', { class: 'row' }, h('label', { for: 'reason' }, 'Reason', reason), deny)),
    result)
}

function outcome(out) {
  const problem = cliProblem(out)
  if (problem) return h('div', { class: 'banner bad', text: problem })
  const r = out.result ?? {}
  if (out.command === 'approve') return h('div', { class: 'banner good', text: `Approved ${r.request_id} for ${r.plan_id}; authorization expires ${fmtTime(r.expires_at)}; passphrase ${passphraseWords(r.passphrase_source)}.` })
  if (out.command === 'deny') return h('div', { class: 'banner good', text: `Rejected ${r.request_id}.` })
  if (out.command === 'undo') return h('div', { class: r.status === 'RECOVERED' ? 'banner good' : 'banner bad', text: `Undo ${r.capture_id}: ${r.status}; recovery check ${r.verification?.status ?? '—'}.` })
  return h('pre', { class: 'sql', text: JSON.stringify(r, null, 2) })
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
  return h('div', {},
    h('div', { class: 'row' }, h('h1', { text: 'Recovery & Replay' }), mission(s)),
    h('h2', { text: 'Receipts' }),
    h('section', { class: 'panel' }, receiptChain(s, ctx)),
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
        s.links.length === 0 ? h('p', { class: 'muted', text: 'No approved request yet.' }) : s.links.map((set) => h('div', {}, h('div', { class: 'mono muted', text: `${set.request_id} · ${set.plan_id}` }),
          h('div', { class: 'links' }, set.links.map((l) => checkLine(l.code, l.ok, l.why ?? ''))))))),
    h('h2', { text: 'Runs and undo' }),
    h('section', { class: 'panel' }, runsTable(s.runs, ctx)))
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
        open.replaceChildren(h('pre', { class: 'sql', text: JSON.stringify(out.result ?? out.error, null, 2) }))
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
      h('td', {}, r.undo ? badge(`${r.undo.verdict} · ${r.undo.verification ?? '—'}`, r.undo.verification === 'PASS' ? 'ok' : 'bad') : undoForm(r, ctx))))))
}

function undoForm(r, ctx) {
  if (!r.capture_id) return h('span', { class: 'muted', text: '—' })
  const input = h('input', { autocomplete: 'off', spellcheck: 'false', placeholder: 'type the capture id', 'aria-label': `Type ${r.capture_id} to confirm the undo` })
  const btn = h('button', { class: 'undo', type: 'button', text: 'Undo' })
  const result = h('div', { 'aria-live': 'polite' })
  btn.addEventListener('click', async () => {
    btn.disabled = true
    result.replaceChildren(h('span', { class: 'muted', text: 'Restoring…' }))
    try {
      const out = await ctx.api('/api/undo', { method: 'POST', body: { capture_id: r.capture_id, confirm: input.value.trim() } })
      result.replaceChildren(outcome(out))
      await ctx.reload()
    } catch (e) {
      result.replaceChildren(h('div', { class: 'banner bad', text: e.message }))
    } finally {
      btn.disabled = false
    }
  })
  return h('div', {}, h('div', { class: 'row' }, input, btn), result)
}
