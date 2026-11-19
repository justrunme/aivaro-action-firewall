// Home: what JustRunMe is, shown with evidence. Everything on it comes from the recorded run
// (opened read only, checked against its manifest and verified by `justrunme verify`), the
// live workspace's pending approvals, or the test report file. A part with no verified source
// says so; nothing is typed in by hand. Written fresh for this repository.

import { badge, fmtTime, h, hashChip, icon, stateBox } from './ui.js'
import { evidenceSteps, experimentCards, heroOf } from './model.js'
import { architecture, builtWithKiro } from './onboarding.js'

const TONE_ICON = { ok: 'check', bad: 'alert', warn: 'alert', fix: 'spark', info: 'bolt', mute: 'dash' }

/** A link that opens recorded evidence: it switches the Console to the recorded run first. */
function evidenceLink(H, href, text, cls = 'home-link', mission = null) {
  const a = h('a', { class: cls, href: `#/${href}` }, text)
  a.addEventListener('click', (e) => {
    e.preventDefault?.()
    H.go('recorded', `#/${href}`, mission)
  })
  return a
}

function pendingBanner(H) {
  if (!H.pending) return null
  const a = h('a', { class: 'home-pending', href: '#/approvals' },
    icon('alert'), h('span', { class: 'hp-text', text: `${H.pending} mission${H.pending === 1 ? '' : 's'} need${H.pending === 1 ? 's' : ''} your decision` }), h('span', { class: 'hp-go', text: 'Review & Decide →' }))
  a.addEventListener('click', (e) => {
    e.preventDefault?.()
    H.go('live', '#/approvals')
  })
  return a
}

function integrityBanner(H) {
  const rec = H.sources?.recorded
  if (!rec?.available || rec.integrity.ok) return null
  return h('div', { class: 'banner bad', role: 'alert' }, icon('alert'), h('div', {}, h('strong', { text: 'The recorded run does not match its manifest, so nothing from it is shown as verified.' }), h('ul', { class: 'why' }, rec.integrity.problems.slice(0, 4).map((p) => h('li', { text: p })))))
}

/** The mission whose story the hero follows: one that lost data first, else the first readable one. */
function mainMission(states) {
  const ok = Object.entries(states ?? {}).filter(([, s]) => s?.story?.ok)
  return ok.find(([, s]) => (s.story.result.versions ?? []).some((v) => v.verdict === 'DATA LOSS')) ?? ok[0] ?? null
}

function trail(H, ctx) {
  const main = mainMission(H.recStates)
  const box = h('section', { class: 'trail panel', 'aria-label': 'The recorded run, step by step' })
  if (!main) {
    box.append(stateBox('empty', 'No recorded run to show', H.sources?.recorded?.available ? 'The recorded run cannot be opened.' : 'No recorded run is installed with this Console.'))
    return box
  }
  const [id, st] = main
  const steps = evidenceSteps(st.story.result, id)
  const verified = st.verify?.result?.ok === true
  const start = ctx.ui.homeStep && steps.some((s) => s.id === ctx.ui.homeStep) ? ctx.ui.homeStep : (steps.find((s) => s.tone === 'bad') ?? steps[0]).id
  const detail = h('div', { class: 'trail-detail', 'aria-live': 'polite' })
  const list = h('ol', { class: 'trail-steps' })
  const buttons = []
  const show = (step) => {
    ctx.ui.homeStep = step.id
    for (const [sid, btn] of buttons) btn.setAttribute('aria-pressed', sid === step.id ? 'true' : 'false')
    const kids = [h('div', { class: 'row' }, badge(step.label, step.tone, TONE_ICON[step.tone]), h('span', { class: 'td-text', text: step.text }))]
    if (step.version?.available) {
      const hero = heroOf(step.version)
      for (const line of hero.why.slice(0, 3)) kids.push(h('div', { class: 'muted', text: line }))
      const trig = h('div', {})
      kids.push(trig)
      if ((step.version.impact?.evidence ?? []).some((e) => e.kind === 'trigger_fired') && H.receipt) {
        H.receipt(id, step.receipt.seq).then((out) => {
          const fired = (out?.result?.receipt?.subject?.evidence ?? []).filter((e) => e.kind === 'trigger_fired')
          trig.replaceChildren(...fired.map((e) => h('div', { class: 'callout bad' }, icon('bolt'), h('span', { class: 'k', text: 'Trigger' }), h('code', { class: 'mono tname', text: e.trigger }), h('span', { text: ' on ' }), h('code', { class: 'mono', text: e.table }), h('span', { class: 'muted', text: ` · fired ${e.fired} time${e.fired === 1 ? '' : 's'} · from signed receipt #${step.receipt.seq}` }))))
        }).catch(() => {})
      }
    }
    kids.push(h('div', { class: 'row' },
      step.receipt ? h('span', { class: 'muted', text: `signed receipt #${step.receipt.seq}` }) : h('span', { class: 'muted', text: 'no receipt behind this step' }),
      step.receipt ? hashChip(step.receipt.hash, 14) : null,
      h('span', { class: 'spacer' }),
      evidenceLink(H, step.href, 'Open this evidence →', 'home-link', id)))
    detail.replaceChildren(...kids)
  }
  steps.forEach((s) => {
    const b = h('button', { type: 'button', class: `ts ${s.tone}`, 'aria-pressed': 'false' }, h('span', { class: 'ts-dot' }, icon(TONE_ICON[s.tone] ?? 'dash')), h('span', { class: 'ts-label', text: s.label }), h('span', { class: 'ts-text', text: s.text }))
    b.addEventListener('click', () => show(s))
    buttons.push([s.id, b])
    const li = h('li', { 'data-id': s.id, class: 'ts-item' }, b)
    list.append(li)
  })
  box.append(
    h('div', { class: 'row' }, h('h2', { class: 'trail-title', text: 'One plan, measured before it ran' }), h('span', { class: 'spacer' }), badge(verified ? 'chain verified' : 'NOT VERIFIED', verified ? 'ok' : 'mute', verified ? 'bolt' : 'dash')),
    h('p', { class: 'muted', text: `${id} · recorded run · click a step to open its evidence` }), list, detail)
  show(steps.find((s) => s.id === start))
  return box
}

function metricsCard(H) {
  const m = H.metrics
  if (!m || m.state !== 'ok') {
    return h('div', { class: 'metric mute' }, h('div', { class: 'metric-n', text: '—' }), h('div', { class: 'metric-l', text: 'No verified test report' }), h('div', { class: 'muted', text: m?.reason ?? 'The report could not be read.' }))
  }
  const r = m.report
  const clean = r.failed === 0
  return h('div', { class: `metric ${clean ? 'ok' : 'bad'}` },
    h('div', { class: 'metric-n' }, h('span', { text: String(r.passed) }), h('span', { class: 'of', text: ` / ${r.total}` })),
    h('div', { class: 'metric-l', text: clean ? 'automated tests passing' : `${r.failed} automated test${r.failed === 1 ? '' : 's'} failing` }),
    h('div', { class: 'muted mono', text: `commit ${r.commit.slice(0, 7)} · ${fmtTime(r.finished_at)}` }),
    h('div', { class: 'muted', text: r.source === 'ci' ? 'measured by CI' : `measured on a local run${r.dirty ? ' with uncommitted changes' : ''}` }),
    r.run_url ? h('a', { class: 'home-link', href: r.run_url, rel: 'noreferrer noopener', target: '_blank', text: 'Open the CI run →' }) : null)
}

function factStrip(H) {
  const main = mainMission(H.recStates)
  const facts = []
  if (main) {
    const cards = experimentCards({ [main[0]]: main[1] })
    const loss = cards[0]
    if (!loss.missing) {
      const [name, nums] = (loss.lines.find((l) => /→/.test(l) && l.split(' ')[0] !== undefined) ?? '').split(/ (.+)/)
      facts.push(h('div', { class: 'metric bad' }, h('div', { class: 'metric-n', text: nums ?? '' }), h('div', { class: 'metric-l', text: `${name} rows in the first rehearsal` }), h('div', { class: 'muted', text: loss.headline })))
    }
  }
  const receipts = Object.values(H.recStates ?? {}).filter((s) => s?.verify?.result?.ok === true).reduce((n, s) => n + s.verify.result.receipts, 0)
  if (receipts > 0) facts.push(h('div', { class: 'metric ok' }, h('div', { class: 'metric-n', text: String(receipts) }), h('div', { class: 'metric-l', text: 'signed receipts, chain verified' }), h('div', { class: 'muted', text: 'Ed25519 signatures, checked by justrunme verify when the Console loaded the recorded run' })))
  return facts
}

function card(H, c) {
  if (c.missing) return h('article', { class: 'xcard mute' }, h('h3', { text: c.title }), h('p', { class: 'muted', text: c.missing }))
  return h('article', { class: `xcard ${c.tone}` },
    h('div', { class: 'row' }, badge(c.label, c.tone, TONE_ICON[c.tone])),
    h('h3', { text: c.title }),
    h('p', { class: 'xhead', text: c.headline }),
    h('ul', { class: 'xlines' }, c.lines.slice(0, 3).map((l) => h('li', { text: l }))),
    h('p', { class: 'muted', text: c.note }),
    h('div', { class: 'row' }, evidenceLink(H, c.href, `${c.cta} →`, 'home-cta', c.mission), c.receipt ? h('span', { class: 'muted mono', text: `receipt #${c.receipt.seq}` }) : null))
}

function provenance(H) {
  const p = H.sources?.recorded?.provenance
  if (!p) return null
  return h('details', { class: 'prov' }, h('summary', { text: 'How this run was recorded' }),
    h('p', { class: 'muted', text: p.scenario ?? '' }),
    ...Object.entries(p.missions ?? {}).map(([id, m]) => h('div', { class: 'prov-m' }, h('code', { class: 'mono', text: id }),
      h('div', {}, h('span', { class: 'k', text: 'Agent: ' }), m.agent ?? '—'),
      h('div', {}, h('span', { class: 'k', text: 'Approval: ' }), m.approval ?? '—'),
      m.limit ? h('div', {}, h('span', { class: 'k', text: 'Limit: ' }), m.limit) : null)),
    p.not_included ? h('p', { class: 'muted', text: p.not_included }) : null)
}

export function homeScreen(ctx) {
  const H = ctx.home
  // Without the sources the page knows nothing; it must not say that nothing exists.
  if (!H.sources) return stateBox('error', 'The Console API has not answered yet', 'Home shows the recorded run and the test report only after the Console has read them.')
  const rec = H.sources?.recorded
  const recOk = Boolean(rec?.available && rec.integrity.ok)
  const live = Boolean(H.sources?.live?.available)
  // One primary action (onboarding, always real), one secondary (the verified demo, only when it is verified).
  const start = h('button', { type: 'button', class: 'home-primary' }, icon('bolt'), 'Get Started with Kiro')
  start.addEventListener('click', () => H.go(H.source ?? 'live', '#/setup'))
  const demo = recOk ? h('button', { type: 'button', class: 'home-secondary' }, 'Explore Verified Demo →') : null
  demo?.addEventListener('click', () => {
    const main = mainMission(H.recStates)
    H.go('recorded', main ? `#/missions/${main[0]}` : '#/missions', main?.[0] ?? null)
  })
  const facts = recOk ? factStrip(H) : []
  const cards = recOk ? experimentCards(H.recStates, rec.provenance) : []
  return h('div', { class: 'home' },
    pendingBanner(H),
    integrityBanner(H),
    h('section', { class: 'home-hero' },
      h('div', { class: 'hero-copy' },
        h('div', { class: 'eyebrow', text: 'BUILT FOR KIRO · AI AGENT EXECUTION SAFETY' }),
        h('h2', { class: 'hero-title' }, 'Let Kiro write code.', h('br'), h('span', { class: 'grad', text: 'JustRunMe checks what happens before it runs.' })),
        h('p', { class: 'hero-p', text: 'An execution safety layer for Kiro AI agents. Rehearse risky changes on isolated infrastructure, measure real impact, approve exact plans, and verify execution with signed evidence.' }),
        h('p', { class: 'hero-sub', text: 'Rehearse. Run. Recover.' }),
        h('div', { class: 'row home-ctas' }, start, demo),
        demo ? h('p', { class: 'muted', text: 'The demo is a RECORDED RUN · READ ONLY: a genuine signed run, opened without Docker or PostgreSQL.' }) : h('p', { class: 'muted', text: 'No verified recorded run is installed with this Console.' })),
      recOk ? trail(H, ctx) : h('section', { class: 'trail panel' }, stateBox('empty', 'No verified recorded run', 'The evidence trail appears here when a recorded run is installed and matches its manifest.'))),
    h('section', { class: 'home-section' },
      h('div', { class: 'row' }, h('h2', { text: 'What was measured' }), h('span', { class: 'spacer' })),
      h('div', { class: 'metrics' }, metricsCard(H), ...facts)),
    recOk ? h('section', { class: 'home-section' },
      h('h2', { text: 'Featured experiments' }),
      h('p', { class: 'muted', text: 'Each card opens the signed evidence it was read from.' }),
      h('div', { class: 'xcards' }, cards.map((c) => card(H, c))),
      provenance(H)) : null,
    architecture(ctx.ui, recOk ? (href) => H.go('recorded', `#/${href}`, href.startsWith('missions/') ? href.split('/')[1] : (mainMission(H.recStates)?.[0] ?? null)) : null),
    builtWithKiro())
}
