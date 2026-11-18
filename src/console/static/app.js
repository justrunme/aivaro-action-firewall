// Console shell: token, API calls, routing, refresh.
// The token arrives in the URL fragment (#token=...), is kept in sessionStorage for
// this tab only, and is removed from the address bar at once.

import { h, pill } from './ui.js'
import { approvalsScreen, impactScreen, missionsScreen, recoveryScreen } from './screens.js'

const SCREENS = { missions: missionsScreen, impact: impactScreen, approvals: approvalsScreen, recovery: recoveryScreen }
const KEY = 'justrunme-console-token'

// #token=<hex> or #/<screen>&token=<hex>
const fromHash = /token=([0-9a-f]{64})/.exec(location.hash)
if (fromHash) {
  sessionStorage.setItem(KEY, fromHash[1])
  const screen = /^#\/(\w+)/.exec(location.hash)?.[1]
  history.replaceState(null, '', `/#/${SCREENS[screen] ? screen : 'missions'}`)
}
const token = sessionStorage.getItem(KEY)

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ? `${data.error.code}: ${data.error.message}` : `HTTP ${res.status}`)
  return data
}

const view = document.getElementById('view')
const chainstate = document.getElementById('chainstate')
const ui = {}
let state = null
let lastText = ''

const screenName = () => {
  const m = /^#\/(\w+)/.exec(location.hash)
  return m && SCREENS[m[1]] ? m[1] : 'missions'
}

function renderChainState() {
  const v = state?.verify
  const s = state?.story?.result
  const pills = []
  if (v?.result) {
    const chainOk = v.result.chain_findings.length === 0
    pills.push(pill(chainOk ? `✓ chain verified · ${v.result.receipts}` : '✗ chain does not verify', chainOk ? 'ok' : 'bad'))
    const other = v.result.policy_findings.length + v.result.selections.filter((x) => !x.ok).length
    if (chainOk && other > 0) pills.push(h('a', { href: '#/recovery', class: 'pill bad', text: `✗ ${other} policy finding${other === 1 ? '' : 's'}` }))
  } else if (v?.error) pills.push(pill(v.error.code, 'warn'))
  if (s?.history) pills.push(pill(s.history.ok ? '✓ history intact' : '✗ history tampered', s.history.ok ? 'ok' : 'bad'))
  const pending = state?.approvals?.result?.requests?.filter((q) => q.state === 'pending').length ?? 0
  if (pending > 0) pills.push(h('a', { href: '#/approvals', class: 'pill warn', text: `${pending} awaiting approval` }))
  chainstate.replaceChildren(...pills)
}

function render() {
  const name = screenName()
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.screen === name)
  if (!token) {
    view.replaceChildren(h('div', { class: 'empty' }, h('h1', { text: 'No console token' }), h('p', { text: 'Open the URL that `justrunme console` printed; it carries the token for this session.' })))
    return
  }
  if (!state) return
  renderChainState()
  view.replaceChildren(SCREENS[name](state, { api, reload, rerender: render, ui }))
}

async function reload() {
  try {
    state = await api('/api/state')
    lastText = JSON.stringify(state)
  } catch (e) {
    view.replaceChildren(h('div', { class: 'banner bad', text: e.message }))
    return
  }
  render()
}

/** Refresh when the chain changed, unless the operator is typing. */
async function poll() {
  if (document.hidden || !token) return
  const typing = [...view.querySelectorAll('input, textarea')].some((el) => el.value !== '' || el === document.activeElement)
  if (typing) return
  try {
    const next = await api('/api/state')
    const text = JSON.stringify(next)
    if (text !== lastText) {
      state = next
      lastText = text
      render()
    }
  } catch {
    // the next poll tries again
  }
}

window.addEventListener('hashchange', () => {
  view.focus()
  render()
})
if (token) await reload()
else render()
setInterval(poll, 4000)
