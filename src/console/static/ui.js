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

export const verdictKind = (v) => (v === 'SAFE' ? 'ok' : v === 'DATA LOSS' || v === 'FAILED' || v === 'LOGIC CHANGE' ? 'bad' : 'warn')

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
