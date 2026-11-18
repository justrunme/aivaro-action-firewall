// Console shell: token, API calls, routing, refresh.
// The token arrives in the URL fragment (#token=...), is kept in sessionStorage for
// this tab only, and is removed from the address bar at once.

import { badge, h, stateBox } from './ui.js'
import { approvalsScreen, impactScreen, missionsScreen, recoveryScreen } from './screens.js'

const SCREENS = { missions: missionsScreen, impact: impactScreen, approvals: approvalsScreen, recovery: recoveryScreen }
const KEY = 'justrunme-console-token'

// #token=<hex> or #/<route>&token=<hex>
const fromHash = /token=([0-9a-f]{64})/.exec(location.hash)
if (fromHash) {
  sessionStorage.setItem(KEY, fromHash[1])
  // Keep the route (#/missions/<id>/<node>) and drop only the token.
  const route = /^#\/(\w+(?:\/[\w.-]+){0,2})/.exec(location.hash)?.[1]
  history.replaceState(null, '', `/#/${route && SCREENS[route.split('/')[0]] ? route : 'missions'}`)
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

/** #/<screen>[/<arg>[/<sub>]]: for Missions, arg is the mission id and sub is a Flight Recorder node. */
const routeOf = () => {
  const m = /^#\/(\w+)(?:\/([\w.-]+))?(?:\/(\w+))?/.exec(location.hash)
  return m && SCREENS[m[1]] ? { screen: m[1], arg: m[2] ?? null, sub: m[3] ?? null } : { screen: 'missions', arg: null, sub: null }
}
const screenName = () => routeOf().screen

function renderChainState() {
  const v = state?.verify
  const s = state?.story?.result
  const pills = []
  if (v?.result) {
    const chainOk = v.result.chain_findings.length === 0
    pills.push(badge(chainOk ? `chain verified · ${v.result.receipts}` : 'chain does not verify', chainOk ? 'ok' : 'bad', chainOk ? 'bolt' : 'cross'))
    const other = v.result.policy_findings.length + v.result.selections.filter((x) => !x.ok).length
    if (chainOk && other > 0) pills.push(h('a', { href: '#/recovery', class: 'pill bad', text: `${other} policy finding${other === 1 ? '' : 's'}` }))
  } else if (v?.error) pills.push(badge(v.error.code, 'mute'))
  if (s?.history) pills.push(badge(s.history.ok ? 'history intact' : 'history altered', s.history.ok ? 'ok' : 'bad', s.history.ok ? 'check' : 'cross'))
  const pending = state?.approvals?.result?.requests?.filter((q) => q.state === 'pending').length ?? 0
  if (pending > 0) pills.push(h('a', { href: '#/approvals', class: 'pill warn', text: `${pending} awaiting approval` }))
  chainstate.replaceChildren(...pills)
}

function render() {
  const name = screenName()
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.screen === name)
  if (!token) {
    view.replaceChildren(stateBox('empty', 'No console token', 'Open the URL that `justrunme console` printed; it carries the token for this session.'))
    return
  }
  if (!state) return
  renderChainState()
  view.replaceChildren(SCREENS[name](state, { api, reload, rerender: render, ui, route: routeOf() }))
}

async function reload() {
  try {
    state = await api('/api/state')
    lastText = JSON.stringify(state)
  } catch (e) {
    const retry = h('button', { type: 'button', text: 'Try again' })
    retry.addEventListener('click', () => {
      view.replaceChildren(stateBox('loading', 'Loading…', 'Reading the mission from the signed chain.'))
      reload()
    })
    view.replaceChildren(stateBox('error', 'The Console cannot read the mission', e.message, retry))
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
  view.focus({ preventScroll: true })
  render()
})
if (token) await reload()
else render()
setInterval(poll, 4000)
