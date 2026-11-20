// Safety Evidence: Gate Health, ProofDebt and recovery readiness of one mission, from
// `justrunme evidence` (a verified chain only). A line is green only when it names a
// signed receipt; everything else is listed with its reason and is never coloured green.
import { badge, fmtTime, h, icon, stateBox } from './ui.js'

const GATE = {
  ACTIVE: { tone: 'ok', ico: 'shield', label: 'ACTIVE' },
  INACTIVE: { tone: 'bad', ico: 'alert', label: 'INACTIVE' },
  UNKNOWN: { tone: 'warn', ico: 'dash', label: 'UNKNOWN' },
}
const WHY = {
  PROBE_OBSERVED: 'seen for the pending probe',
  PROBE_RECORDED: 'recorded by the last gate probe',
  WAITING_FOR_PROBE: 'waiting for the agent to run the probe command',
  NEVER_PROBED: 'no gate probe has been run for this workspace',
  STALE: 'the hook denial of the last probe is older than 15 minutes (counted from the denial, not from when it was recorded)',
  HOOK_RECEIPT_MISSING: 'the last probe cites no hook denial found in the chain',
}

/** "8 s ago", "4 min ago", or the time itself. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 90) return `${s} s ago`
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`
  return fmtTime(iso)
}

const seqText = (r) => (r && Number.isInteger(r.seq) ? `receipt #${r.seq}` : '')
const line = (ok, text, r) => h('div', { class: 'link' }, h('span', { class: ok ? 'y' : 'u' }, icon(ok ? 'check' : 'dash')), h('span', { text }), r ? h('span', { class: 'mono muted', text: ` ${seqText(r)}` }) : null)

/** What the gate status means, in words that do not overclaim. */
export function gateText(g) {
  if (!g) return 'Gate Health is not available.'
  if (g.status === 'ACTIVE') {
    const r = g.observed?.hook_receipt ?? g.recorded?.hook_receipt ?? g.recorded
    return `A hook in this workspace denied the probe command ${r?.at ? ago(r.at) : ''} (${seqText(r)}). This covers the session that ran it, not every session, and not an agent that can read the key directory.`
  }
  if (g.status === 'INACTIVE') return 'The probe command ran without being blocked: the session that ran it is not protected by the gate. Check that the workspace is trusted, that JUSTRUNME_GATE=on reaches the hook, and the hook file.'
  return `${WHY[g.why] ?? 'no proof either way'}. UNKNOWN does not mean that commands are blocked.`
}

function gatePanel(g, ctx) {
  const view = GATE[g?.status] ?? GATE.UNKNOWN
  const out = h('div', { class: 'result', 'aria-live': 'polite' })
  const act = async (action, btn) => {
    btn.disabled = true
    try {
      const res = await ctx.api('/api/gate-probe', { method: 'POST', body: { action } })
      if (res?.ok === false && res.error && !res.result) out.replaceChildren(h('div', { class: 'banner bad', text: `${res.error.code}: ${res.error.message}` }))
      await ctx.reload?.()
    } catch (e) {
      out.replaceChildren(h('div', { class: 'banner bad', text: e.message }))
    } finally {
      btn.disabled = false
    }
  }
  const buttons = []
  if (!ctx.readOnly) {
    const start = h('button', { type: 'button', text: g?.pending ? 'Start a new probe' : 'Check the gate' })
    start.addEventListener('click', () => act('start', start))
    buttons.push(start)
    if (g?.pending) {
      const fin = h('button', { type: 'button', class: 'ghost', text: 'Record the result (signed receipt)' })
      fin.addEventListener('click', () => act('finish', fin))
      buttons.push(fin)
    }
  }
  return h('section', { class: `hero ${view.tone} gate`, 'aria-label': `Gate Health ${view.label}` },
    h('div', { class: 'hero-top' }, h('span', { class: `hero-label ${view.tone}` }, icon(view.ico), view.label), h('span', { class: 'muted', text: 'Gate Health · PreToolUse hook' })),
    h('p', { text: gateText(g) }),
    g?.pending && g.command
      ? h('div', { class: 'callout' }, h('div', { text: 'Ask the agent, in the session to check:' }), h('code', { class: 'mono', text: `Run this shell command in the workspace and report exactly what happened: ${g.command}` }))
      : null,
    h('div', { class: 'muted', text: 'One probe at a time per workspace; a new probe replaces the pending one.' }),
    g?.last_hook_decision ? h('div', { class: 'muted', text: `Last hook decision in this workspace: ${g.last_hook_decision.verdict} ${ago(g.last_hook_decision.at)} (receipt #${g.last_hook_decision.seq}); for information only, it does not show which session was gated.` }) : null,
    buttons.length ? h('div', { class: 'row result' }, ...buttons) : null,
    out)
}

export function evidenceScreen(state, ctx) {
  const e = state?.evidence
  if (!e) return stateBox('loading', 'Reading the evidence…', '')
  if (e.ok === false || !e.result) {
    const none = e.error?.code === 'NO_RECEIPTS'
    return stateBox(none ? 'empty' : 'error', none ? 'No evidence yet' : 'The evidence cannot be shown', e.error ? `${e.error.code}: ${e.error.message}` : 'no answer')
  }
  const r = e.result
  const rr = r.recovery_readiness ?? {}
  return h('div', {},
    h('div', { class: 'row' }, h('h1', { text: 'Safety Evidence' }), h('span', { class: 'mono', text: r.mission_id }), badge(`${r.receipts} receipts verified`, 'ok', 'bolt')),
    gatePanel(r.gate, ctx),
    h('div', { class: 'grid2' },
      h('section', { class: 'panel', 'aria-label': 'Proof debt' },
        h('h3', { text: 'Proof debt' }),
        h('p', { class: 'muted', text: 'What the signed receipts prove, and what they do not. No score: a missing proof is listed, not weighed. Coverage counts what the capture holds, not every table or file of the application.' }),
        h('div', { class: 'links verified' }, (r.verified ?? []).map((v) => line(true, v.text, v.receipt))),
        h('h4', { text: `Not verified (${(r.not_verified ?? []).length})` }),
        h('div', { class: 'links unverified' }, (r.not_verified ?? []).map((n) => line(false, n.text, n.receipt)))),
      h('section', { class: 'panel', 'aria-label': 'Recovery readiness' },
        h('h3', { text: 'Recovery readiness' }),
        h('div', { class: 'links' },
          rr.last_verified_recovery ? line(true, `Last verified recovery ${ago(rr.last_verified_recovery.at)}`, rr.last_verified_recovery) : line(false, 'No recovery with a recorded list of checks has passed in this mission'),
          line(rr.latest_run_recovery === 'PASS' && Boolean(rr.latest_run_recovery_receipt), rr.latest_run_recovery === 'NOT_UNDONE' ? 'The latest run has not been undone' : rr.latest_run_recovery ? `Latest run recovery: ${rr.latest_run_recovery}` : 'No run yet', rr.latest_run_recovery_receipt),
          line(rr.recovery_rehearsed === true && Boolean(rr.recovery_rehearsal_receipt), rr.recovery_rehearsal_note ?? 'Recovery rehearsal not recorded', rr.recovery_rehearsal_receipt)))))
}
