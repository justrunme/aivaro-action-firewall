// Small DOM helpers. Every value is set as text or as a plain attribute; nothing is
// ever parsed as HTML, so SQL, agent notes and reasons cannot inject markup.

const EVENT = /^on[A-Z]/

/**
 * h('div', { class: 'x', onClick: fn, text: 'hi' }, child, 'text', [more])
 * Attributes named on<Event> become listeners; `text` sets textContent.
 */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'text') el.textContent = String(v)
    else if (k === 'class') el.className = v
    else if (EVENT.test(k)) el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'style' || k === 'innerHTML') throw new Error('not allowed: ' + k)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return el
}

export const short = (hash, n = 12) => (typeof hash === 'string' ? hash.replace(/^sha256:/, '').slice(0, n) : '—')

export function fmtTime(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

export function pill(text, kind = '') {
  return h('span', { class: `pill ${kind}`, text })
}

export const verdictKind = (v) => (v === 'SAFE' ? 'ok' : ['DATA LOSS', 'FAILED', 'LOGIC CHANGE', 'LOGIC BYPASS', 'INVARIANT VIOLATED', 'REQUIREMENT UNMET', 'UNVERIFIABLE'].includes(v) ? 'bad' : 'warn')

// Inline SVG icons, built with the DOM (no markup parsing, no external asset).
const SVG = 'http://www.w3.org/2000/svg'
const ICONS = {
  bolt: ['M13 2 4 14h6l-1 8 9-12h-6z'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  cross: ['M6 6l12 12M18 6 6 18'],
  copy: ['M9 9h10v11H9z', 'M5 15V4h10'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  dash: ['M7 12h10'],
  spark: ['M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z'],
}
/** icon('bolt') -> an <svg> that takes its colour from the text colour around it. */
export function icon(name, label = '') {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', `icon ${name}`)
  if (label) {
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', label)
  } else svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}
/** A badge with an optional icon in front: tone is ok | warn | bad | fix | mute | info. */
export const badge = (text, tone = 'info', ico = null) => h('span', { class: `pill ${tone}` }, ico ? icon(ico) : null, text)
/** A short hash with a button that copies the full value. */
export function hashChip(full, shown = 14) {
  if (typeof full !== 'string') return h('span', { class: 'muted mono', text: '—' })
  const btn = h('button', { type: 'button', class: 'copy', 'aria-label': `Copy ${full}`, title: 'Copy the full hash' }, icon('copy'))
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(full)
      btn.setAttribute('title', 'Copied')
    } catch {
      btn.setAttribute('title', 'Copy failed: select the text instead')
    }
  })
  return h('span', { class: 'hash' }, h('code', { class: 'mono', title: full, text: short(full, shown) }), btn)
}
/** Loading, empty and error states share one look: kind is loading | empty | error. */
export function stateBox(kind, title, text, ...actions) {
  return h('div', { class: `statebox ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('h2', { text: title }), text ? h('p', { text }) : null, actions.length ? h('div', { class: 'row' }, actions) : null)
}

/** Line diff by longest common subsequence: [{ sign: ' ' | '-' | '+', text }]. */
export function lineDiff(a, b) {
  const x = String(a ?? '').replace(/\n$/, '').split('\n')
  const y = String(b ?? '').replace(/\n$/, '').split('\n')
  if (x.length * y.length > 400_000) return [...x.map((text) => ({ sign: '-', text })), ...y.map((text) => ({ sign: '+', text }))]
  const m = x.length
  const n = y.length
  const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      out.push({ sign: ' ', text: x[i] })
      i++
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ sign: '-', text: x[i++] })
    else out.push({ sign: '+', text: y[j++] })
  }
  while (i < m) out.push({ sign: '-', text: x[i++] })
  while (j < n) out.push({ sign: '+', text: y[j++] })
  return out
}

export function diffView(lines) {
  return h('div', { class: 'diff', role: 'region', 'aria-label': 'SQL difference' },
    lines.map((l) => h('div', { class: `ln ${l.sign === '-' ? 'rm' : l.sign === '+' ? 'add' : ''}` }, h('span', { class: 'sign', text: l.sign }), h('span', { text: l.text }))))
}

/** The SQL of a version as one text: each file under a comment with its path. */
export const sqlOf = (v) => (v?.files ?? []).map((f) => `-- ${f.path}\n${f.sql ?? '-- (not in the history archive)'}`).join('\n')
