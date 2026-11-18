// The four Console screens. Each takes the loaded state and a small context
// ({ api, reload, ui }) and returns one DOM node.

import { diffView, fmtTime, h, lineDiff, pill, short, sqlOf, verdictKind } from './ui.js'
import { focus, losses, passphraseWords, pipeline, sameBase } from './model.js'

const ok = (cond) => pill(cond ? '✓ holds' : '✗ broken', cond ? 'ok' : 'bad')
const linkOk = (set, code) => set?.links.find((l) => l.code === code)?.ok === true

function cliProblem(out) {
  if (!out) return 'no answer'
  if (out.ok === false && out.error) return `${out.error.code}: ${out.error.message}`
  return null
}

function lossText(v) {
  const l = losses(v)
  const parts = [`${l.rows_lost} protected row${l.rows_lost === 1 ? '' : 's'} lost`]
  for (const t of l.removed_tables) parts.push(`table ${t} removed`)
  for (const c of l.removed_columns) parts.push(`column ${c} removed`)
  for (const o of l.removed_logic) parts.push(`${o} removed`)
  for (const o of l.changed_logic) parts.push(`${o} changed`)
  if (l.removed_tables.length + l.removed_columns.length + l.removed_logic.length + l.changed_logic.length === 0) parts.push('schema and database logic kept')
  for (const c of l.added_columns) parts.push(`column ${c} added`)
  return parts.join(' · ')
}

// ---- Missions ---------------------------------------------------------------

export function missionsScreen(state) {
  const problem = cliProblem(state.story)
  if (problem) return h('div', { class: 'empty' }, h('h1', { text: 'No mission story yet' }), h('p', { text: problem }))
  const s = state.story.result
  const f = focus(s)
  const stages = pipeline(s)
  const beats = [
    f.a
      ? beat('red', '●', 'PLAN A — ' + (f.a.verdict === 'SAFE' ? 'SAFE' : 'DENIED'), lossText(f.a), `${short(f.a.plan_id, 17)} · rehearsal #${f.a.seq} · ${f.a.verdict}`, pill(f.a.verdict, 'bad'))
      : beat('gray', '○', 'PLAN A', 'no plan was denied in this mission', ''),
    f.b
      ? beat('green', '●', 'PLAN B — SAFE', lossText(f.b), `${short(f.b.plan_id, 17)} · rehearsal #${f.b.seq}`, pill('SAFE', 'ok'))
      : beat('gray', '○', 'PLAN B', 'no SAFE rehearsal yet', ''),
    f.approved
      ? beat('violet', '🔐', 'APPROVAL', `a human approved exactly this version (request ${f.approved.request_id})`, `passphrase ${passphraseWords(f.approved.authorization?.passphrase_source)} · authorization #${f.approved.authorization?.seq}`, ok(linkOk(f.links, 'APPROVED_VERSION_SAFE') && linkOk(f.links, 'AUTHORIZED_AS_REQUESTED')))
      : beat('gray', '○', 'APPROVAL', f.pending ? `waiting for the operator (request ${f.pending.request_id})` : 'not requested', ''),
    f.run
      ? beat('blue', '🚀', 'EXECUTION', 'the approved SQL ran: same files, same report as the approval', `run #${f.run.seq} · ${f.run.verdict} · capture ${f.run.capture_id}`, ok(linkOk(f.links, 'EXECUTED_AS_AUTHORIZED')))
      : beat('gray', '○', 'EXECUTION', 'not run', ''),
    f.run
      ? beat('green', '✓', 'VERIFICATION', f.run.matches_rehearsal ? 'the measured result matched the rehearsal' : `${f.run.differences ?? '?'} difference(s) from the rehearsal`, f.run.undo ? `undone afterwards: ${f.run.undo.verdict}, recovery check ${f.run.undo.verification ?? '—'}` : 'not undone', ok(linkOk(f.links, 'RESULT_AS_REHEARSED')))
      : beat('gray', '○', 'VERIFICATION', 'nothing to verify yet', ''),
  ]
  return h('div', {},
    h('div', { class: 'row' }, h('h1', { text: s.mission_id }), h('span', { class: 'spacer' }), pill(`${s.versions.length} version${s.versions.length === 1 ? '' : 's'}`, 'info'), pill(`${s.timeline.length} receipts`, 'info')),
    h('div', { class: 'pipeline', role: 'list', 'aria-label': 'Mission pipeline' },
      stages.map((st) => h('div', { class: `stage ${st.state}`, role: 'listitem', 'aria-label': `${st.name}: ${st.state}` }, h('span', { class: 'dot' }), h('div', { class: 'label', text: st.name }), h('div', { class: 'sub', text: st.state === 'none' ? '—' : st.state })))),
    h('div', { class: 'story' }, beats),
    h('h2', { text: 'Every rehearsed version' }),
    h('div', { class: 'panel' }, versionsTable(s.versions, f)),
  )
}

function beat(color, ico, what, detail, sub, right) {
  return h('div', { class: `beat ${color}` }, h('span', { class: 'ico', 'aria-hidden': 'true', text: ico }), h('span', { class: 'what', text: what }), h('div', { class: 'detail' }, h('div', { text: detail }), sub ? h('div', { class: 'muted mono', text: sub }) : null), right || h('span'))
}

function versionsTable(versions, f) {
  if (versions.length === 0) return h('p', { class: 'muted', text: 'No rehearsal yet.' })
  return h('table', {},
    h('thead', {}, h('tr', {}, ['#', 'when', 'plan', 'verdict', 'impact', 'archive'].map((t) => h('th', { text: t })))),
    h('tbody', {}, versions.map((v) => h('tr', { class: v === f.a || v === f.b ? 'sel' : '' },
      h('td', { class: 'mono', text: v.seq }),
      h('td', { class: 'mono', text: fmtTime(v.at) }),
      h('td', { class: 'mono', text: v.plan_id }),
      h('td', {}, pill(v.verdict, verdictKind(v.verdict))),
      h('td', { text: v.available ? lossText(v) : '—' }),
      h('td', {}, v.available ? pill('archived', 'ok') : pill(v.problem ?? 'missing', 'bad'))))))
}

// ---- Impact Diff ------------------------------------------------------------

export function impactScreen(state, ctx) {
  const problem = cliProblem(state.story)
  if (problem) return h('div', { class: 'empty', text: problem })
  const versions = state.story.result.versions.filter((v) => v.available)
  if (versions.length === 0) return h('div', { class: 'empty', text: 'No archived rehearsal to compare.' })
  const f = focus(state.story.result)
  const pickA = ctx.ui.impactA ?? f.a?.seq ?? versions[0].seq
  const pickB = ctx.ui.impactB ?? f.b?.seq ?? versions.at(-1).seq
  const a = versions.find((v) => v.seq === pickA) ?? versions[0]
  const b = versions.find((v) => v.seq === pickB) ?? versions.at(-1)
  const chooser = (label, current, key) => h('label', {}, label, h('select', { onChange: (e) => { ctx.ui[key] = Number(e.target.value); ctx.rerender() } },
    versions.map((v) => h('option', { value: v.seq, selected: v.seq === current.seq, text: `#${v.seq} ${v.plan_id} ${v.verdict}` }))))
  return h('div', {},
    h('div', { class: 'row' }, h('h1', { text: 'Impact Diff' }), h('span', { class: 'spacer' }), chooser('Left', a, 'impactA'), chooser('Right', b, 'impactB')),
    sameBase(a, b) ? null : h('div', { class: 'banner', text: 'Measured on different database states (the base hash differs): compare each card with its own "before", not row for row with the other.' }),
    h('div', { class: 'grid2' }, planCard('Plan A', a), planCard('Plan B', b)),
    h('h2', { text: 'SQL difference' }),
    diffView(lineDiff(sqlOf(a), sqlOf(b))),
  )
}

function planCard(title, v) {
  const l = losses(v)
  const color = v.verdict === 'SAFE' ? 'green' : v.verdict === 'DATA LOSS' || v.verdict === 'FAILED' || v.verdict === 'LOGIC CHANGE' ? 'red' : 'amber'
  const tables = Object.entries(v.impact.tables)
  const max = Math.max(1, ...tables.map(([, t]) => Math.max(t.rows_before ?? 0, t.rows_after ?? 0)))
  return h('section', { class: `panel plan-card ${color}`, 'aria-label': `${title}: ${v.verdict}` },
    h('div', { class: 'row' }, h('h3', { text: `${title} · #${v.seq}` }), h('span', { class: 'spacer' }), pill(v.verdict, verdictKind(v.verdict))),
    h('div', { class: 'mono muted', text: `${v.plan_id} · report ${short(v.report_hash)} · base ${short(v.base_hash)}` }),
    h('div', { class: 'row' },
      h('div', {}, h('div', { class: `big ${l.rows_lost > 0 ? 'red' : 'green'}`, text: l.rows_lost }), h('div', { class: 'biglabel', text: 'protected rows lost' })),
      h('div', {}, h('div', { class: `big ${l.removed_columns.length + l.removed_tables.length > 0 ? 'red' : 'green'}`, text: l.removed_columns.length + l.removed_tables.length }), h('div', { class: 'biglabel', text: 'tables / columns removed' }))),
    h('div', { class: 'bars' }, tables.map(([name, t]) => bar(name, t, max))),
    h('ul', { class: 'delta' },
      l.removed_tables.map((x) => h('li', { class: 'rm', text: `− table ${x}` })),
      l.removed_columns.map((x) => h('li', { class: 'rm', text: `− column ${x}` })),
      l.removed_logic.map((x) => h('li', { class: 'rm', text: `− ${x}` })),
      l.changed_logic.map((x) => h('li', { class: 'rm', text: `~ ${x}` })),
      l.added_tables.map((x) => h('li', { class: 'add', text: `+ table ${x}` })),
      l.added_columns.map((x) => h('li', { class: 'add', text: `+ column ${x}` })),
      v.impact.failed_steps.map((x) => h('li', { class: 'rm', text: `✗ step ${x} failed` }))),
    h('h3', { text: 'SQL' }),
    h('pre', { class: 'sql', text: sqlOf(v) }),
  )
}

function bar(name, t, max) {
  const after = h('span', { class: `fill ${t.rows_lost > 0 ? 'loss' : ''}` })
  const before = h('span', { class: 'fill before' })
  before.style.width = `${(100 * (t.rows_before ?? 0)) / max}%`
  after.style.width = `${(100 * (t.rows_after ?? 0)) / max}%`
  return h('div', { class: 'bar' },
    h('span', { class: 'mono', text: `${name}${t.protected ? ' 🛡' : ''}` }),
    h('span', { class: 'track', title: `${t.rows_before ?? '—'} → ${t.rows_after ?? '—'}` }, before, after),
    h('span', { class: 'mono', text: `${t.rows_before ?? '—'} → ${t.rows_after ?? '—'}` }))
}

// ---- Approval Center ----------------------------------------------------------

export function approvalsScreen(state, ctx) {
  const problem = cliProblem(state.approvals)
  if (problem) return h('div', { class: 'empty', text: problem })
  const requests = state.approvals.result.requests
  const list = h('div', { class: 'panel' }, requests.length === 0
    ? h('p', { class: 'muted', text: 'No approval request. The agent asks with the request_approval tool after a SAFE rehearsal.' })
    : h('table', {},
      h('thead', {}, h('tr', {}, ['request', 'plan', 'state', 'requested', 'expires'].map((t) => h('th', { text: t })))),
      h('tbody', {}, requests.map((q) => h('tr', { class: `click ${ctx.ui.request === q.request_id ? 'sel' : ''}`, tabindex: '0', onClick: () => { ctx.ui.request = q.request_id; ctx.rerender() }, onKeydown: (e) => { if (e.key === 'Enter') { ctx.ui.request = q.request_id; ctx.rerender() } } },
        h('td', { class: 'mono', text: q.request_id }), h('td', { class: 'mono', text: q.plan_id ?? '—' }), h('td', {}, pill(q.state, q.state === 'approved' ? 'ok' : q.state === 'pending' ? 'warn' : 'bad')),
        h('td', { class: 'mono', text: fmtTime(q.requested_at) }), h('td', { class: 'mono', text: fmtTime(q.expires_at) }))))))
  const detail = h('div', {})
  const id = ctx.ui.request ?? requests.find((q) => q.state === 'pending')?.request_id
  if (id) {
    detail.append(h('p', { class: 'muted', text: 'Loading request…' }))
    ctx.api(`/api/approvals/${id}`).then((out) => detail.replaceChildren(requestDetail(out, ctx))).catch((e) => detail.replaceChildren(h('div', { class: 'banner bad', text: e.message })))
  }
  return h('div', {}, h('h1', { text: 'Approval Center' }), list, detail)
}

function requestDetail(out, ctx) {
  const problem = cliProblem(out)
  if (problem) return h('div', { class: 'banner bad', text: problem })
  const r = out.result
  const rep = r.report
  const changed = r.files.filter((f) => !f.matches_now)
  const left = Date.parse(r.expires_at) - Date.now()
  return h('div', {},
    h('h2', { text: 'Request' }),
    h('div', { class: 'row' }, h('span', { class: 'mono', text: r.request_id }), pill(r.state, r.state === 'pending' ? 'warn' : r.state === 'approved' ? 'ok' : 'bad'), h('span', { class: 'mono', text: r.plan_id }),
      h('span', { class: 'muted', text: r.state === 'pending' ? `expires in ${Math.max(0, Math.round(left / 60000))} min (${fmtTime(r.expires_at)})` : `expires ${fmtTime(r.expires_at)}` })),
    changed.length ? h('div', { class: 'banner bad', text: `Changed since the request: ${changed.map((f) => f.path).join(', ')}. This request cannot be approved; the agent must rehearse again.` }) : null,
    h('div', { class: 'grid2' },
      h('section', { class: 'panel' }, h('h3', { text: 'The SQL that will run' }), r.files.map((f) => h('div', {}, h('div', { class: 'row' }, h('span', { class: 'mono', text: f.path }), pill(f.matches_now ? 'unchanged' : 'changed', f.matches_now ? 'ok' : 'bad')), h('pre', { class: 'sql', text: f.sql ?? '(file missing)' })))),
      h('section', { class: 'panel' }, h('h3', { text: 'Measured in rehearsal' }),
        rep?.valid
          ? h('div', {}, h('div', { class: 'row' }, pill(rep.verdict, verdictKind(rep.verdict)), h('span', { text: `${rep.rows_deleted} rows deleted` })),
            h('ul', { class: 'delta' }, (rep.schema_delta?.removed_columns ?? []).map((c) => h('li', { class: 'rm', text: `− column ${c}` })), (rep.schema_delta?.added_columns ?? []).map((c) => h('li', { class: 'add', text: `+ column ${c}` })), (rep.schema_delta?.removed_tables ?? []).map((t) => h('li', { class: 'rm', text: `− table ${t}` }))))
          : h('div', { class: 'banner bad', text: rep?.problem ?? 'no report' }),
        h('h3', { text: 'Agent note' }),
        h('div', { class: 'note' }, h('div', { text: r.agent_note || '(none)' }), h('div', { class: 'muted', text: r.agent_note_is })))),
    r.state === 'pending' ? decide(r, ctx) : null)
}

function decide(r, ctx) {
  const confirm = h('input', { id: 'confirm', autocomplete: 'off', spellcheck: 'false', placeholder: r.plan_id, 'aria-describedby': 'confirm-help' })
  const pass = h('input', { id: 'passphrase', name: 'jrm-approver-once', type: 'password', autocomplete: 'new-password' })
  const reason = h('input', { id: 'reason', autocomplete: 'off', placeholder: 'why' })
  const result = h('div', { class: 'result', 'aria-live': 'polite' })
  const go = (button, path, body) => async () => {
    button.disabled = true
    result.replaceChildren(h('p', { class: 'muted', text: 'Working…' }))
    try {
      const out = await ctx.api(path, body())
      pass.value = ''
      result.replaceChildren(outcome(out))
      await ctx.reload()
    } catch (e) {
      result.replaceChildren(h('div', { class: 'banner bad', text: e.message }))
    } finally {
      pass.value = ''
      button.disabled = false
    }
  }
  const approve = h('button', { class: 'approve', type: 'button', text: 'Approve this plan' })
  const deny = h('button', { class: 'deny', type: 'button', text: 'Deny' })
  approve.addEventListener('click', go(approve, '/api/approve', () => ({ method: 'POST', body: { request_id: r.request_id, confirm: confirm.value.trim(), passphrase: pass.value } })))
  deny.addEventListener('click', go(deny, '/api/deny', () => ({ method: 'POST', body: { request_id: r.request_id, reason: reason.value } })))
  return h('div', { class: 'grid2' },
    h('section', { class: 'panel' }, h('h3', { text: 'Approve' }),
      h('p', { class: 'muted', id: 'confirm-help', text: `Type the plan id (${r.plan_id}) and the approver passphrase. The passphrase goes to \`justrunme approve --passphrase-stdin\`; this page and the server never hold the approver key.` }),
      h('div', { class: 'row' }, h('label', { for: 'confirm' }, 'Plan id', confirm), h('label', { for: 'passphrase' }, 'Approver passphrase', pass), approve)),
    h('section', { class: 'panel' }, h('h3', { text: 'Deny' }), h('p', { class: 'muted', text: 'Refusing needs a reason, no passphrase. A denied request cannot be approved later.' }),
      h('div', { class: 'row' }, h('label', { for: 'reason' }, 'Reason', reason), deny)),
    result)
}

function outcome(out) {
  const problem = cliProblem(out)
  if (problem) return h('div', { class: 'banner bad', text: problem })
  const r = out.result ?? {}
  if (out.command === 'approve') return h('div', { class: 'banner good', text: `Approved ${r.request_id} for ${r.plan_id}; authorization expires ${fmtTime(r.expires_at)}; passphrase ${passphraseWords(r.passphrase_source)}.` })
  if (out.command === 'deny') return h('div', { class: 'banner good', text: `Denied ${r.request_id}.` })
  if (out.command === 'undo') return h('div', { class: r.status === 'RECOVERED' ? 'banner good' : 'banner bad', text: `Undo ${r.capture_id}: ${r.status}; recovery check ${r.verification?.status ?? '—'}.` })
  return h('pre', { class: 'sql', text: JSON.stringify(r, null, 2) })
}

// ---- Recovery & Replay -------------------------------------------------------

export function recoveryScreen(state, ctx) {
  const problem = cliProblem(state.story)
  if (problem) return h('div', { class: 'empty', text: problem })
  const s = state.story.result
  const v = state.verify
  const replayOut = h('div', { class: 'result', 'aria-live': 'polite' })
  const replayBtn = h('button', { type: 'button', text: 'Replay every selection' })
  replayBtn.addEventListener('click', async () => {
    replayBtn.disabled = true
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
    h('h1', { text: 'Recovery & Replay' }),
    h('section', { class: 'panel' }, h('h3', { text: 'Runs' }), runsTable(s.runs, ctx)),
    h('div', { class: 'grid2' },
      h('section', { class: 'panel' }, h('h3', { text: 'Verification' }),
        vr ? h('div', { class: 'links' },
          checkLine('receipt chain', vr.chain_findings.length === 0, `${vr.receipts} receipts`),
          checkLine('ordering policy', vr.policy_findings.length === 0, vr.policy_findings.map((x) => x.code ?? x.problem).join(', ')),
          checkLine('plan history archive', vr.history?.ok === true, `${vr.history?.versions ?? 0} versions${vr.history?.legacy_versions ? `, ${vr.history.legacy_versions} older than the archive` : ''}`),
          checkLine('selections replayed', vr.selections.every((x) => x.ok), `${vr.selections.length} selection(s)`))
          : h('div', { class: 'banner bad', text: cliProblem(v) ?? 'no verification' }),
        h('div', { class: 'row result' }, replayBtn), replayOut),
      h('section', { class: 'panel' }, h('h3', { text: 'Links from approval to result' }),
        s.links.length === 0 ? h('p', { class: 'muted', text: 'No approved request yet.' }) : s.links.map((set) => h('div', {}, h('div', { class: 'mono muted', text: `${set.request_id} · ${set.plan_id}` }),
          h('div', { class: 'links' }, set.links.map((l) => checkLine(l.code, l.ok, l.why ?? ''))))))),
    h('h2', { text: 'Evidence timeline' }),
    h('section', { class: 'panel' }, timeline(s.timeline, ctx)),
  )
}

function checkLine(name, good, why) {
  return h('div', { class: 'link' }, h('span', { class: good ? 'y' : 'n', text: good ? '✓' : '✗' }), h('span', { text: name }), h('span', { class: 'muted', text: why ?? '' }))
}

function runsTable(runs, ctx) {
  if (runs.length === 0) return h('p', { class: 'muted', text: 'No real run yet.' })
  return h('table', {},
    h('thead', {}, h('tr', {}, ['#', 'when', 'plan', 'verdict', 'as rehearsed', 'capture', 'undo'].map((t) => h('th', { text: t })))),
    h('tbody', {}, runs.map((r) => h('tr', {},
      h('td', { class: 'mono', text: r.seq }), h('td', { class: 'mono', text: fmtTime(r.at) }), h('td', { class: 'mono', text: r.plan_id }),
      h('td', {}, pill(r.verdict, r.verdict === 'completed' ? 'ok' : 'bad')),
      h('td', {}, r.matches_rehearsal === true ? pill('✓ matched', 'ok') : r.matches_rehearsal === false ? pill(`✗ ${r.differences} diff`, 'bad') : pill('not recorded', 'warn')),
      h('td', { class: 'mono', text: r.capture_id ?? '—' }),
      h('td', {}, r.undo ? pill(`${r.undo.verdict} · ${r.undo.verification ?? '—'}`, r.undo.verification === 'PASS' ? 'ok' : 'bad') : undoForm(r, ctx))))))
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

const GOOD = new Set(['SAFE', 'allow', 'completed', 'PASS', 'undo', 'selected'])
const BAD = new Set(['DATA LOSS', 'FAILED', 'LOGIC CHANGE', 'deny', 'blocked', 'FAIL', 'failed'])

function timeline(items, ctx) {
  if (items.length === 0) return h('p', { class: 'muted', text: 'No receipts.' })
  const detail = h('div', { 'aria-live': 'polite' })
  return h('div', {},
    h('ol', { class: 'timeline' }, items.map((t) => h('li', { class: GOOD.has(t.verdict) ? 'ok' : BAD.has(t.verdict) ? 'bad' : 'info' },
      h('a', { href: '#/recovery', onClick: async (e) => {
        e.preventDefault()
        const out = await ctx.api(`/api/receipt/${t.seq}`).catch((err) => ({ ok: false, error: { code: 'ERROR', message: err.message } }))
        detail.replaceChildren(h('pre', { class: 'sql', text: JSON.stringify(out.result ?? out.error, null, 2) }))
      } }, h('span', { class: 'k', text: `#${t.seq} ${t.kind}` })),
      h('span', { text: ` · ${t.verdict ?? '—'} · ${fmtTime(t.at)} · ` }), h('span', { class: 'muted', text: short(t.hash) })))),
    detail)
}
