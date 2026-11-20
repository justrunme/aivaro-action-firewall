/**
 * Safety Evidence in the Console: the API reads `justrunme evidence` from a real signed chain,
 * the gate probe runs through the CLI child and the real hook, and the screen never colours a
 * line green unless it names a receipt.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { createApi } from '../src/console/api.js'
import { startConsole } from '../src/console/server.js'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { findAll, hasClass, installFakeDom } from './support/fake-dom.js'

const HOOK = new URL('../src/hook/pretooluse.js', import.meta.url).pathname
const CONTRACT = {
  id: 'mission-evidence-test',
  objective: 'Read Safety Evidence',
  allowed_paths: ['demo/migrations/'],
  protected_tables: ['orders'],
  time_limit_seconds: 300,
  irreversible_actions: ['notify'],
  plan: [{ id: 'notify', tool: 'shell', args: ['echo', 'sent'], reversibility: false }],
  resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['app'] },
}

let ws
let home
let savedHome
let restoreDom
let evidenceScreen
let api
before(async () => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'jrm-cev-ws-'))
  home = mkdtempSync(path.join(os.tmpdir(), 'jrm-cev-home-'))
  writeFileSync(path.join(ws, 'justrunme.mission.yaml'), stringify(CONTRACT))
  loadOrCreateKeys(home)
  savedHome = process.env.JUSTRUNME_HOME
  process.env.JUSTRUNME_HOME = home
  api = createApi({ repoDir: ws, env: { ...process.env, JUSTRUNME_HOME: home } })
  restoreDom = installFakeDom()
  ;({ evidenceScreen } = await import('../src/console/static/evidence.js'))
})
after(() => {
  restoreDom?.()
  if (savedHome === undefined) delete process.env.JUSTRUNME_HOME
  else process.env.JUSTRUNME_HOME = savedHome
  rmSync(ws, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})
const hook = (command) => spawnSync(process.execPath, [HOOK], { cwd: ws, env: { ...process.env, JUSTRUNME_GATE: 'on', JUSTRUNME_HOME: home }, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, tool_name: 'execute_bash', tool_input: { command } }) })
const text = (el) => el.textContent

describe('Console Safety Evidence', () => {
  it('reads the evidence of a chain with only hook decisions: UNKNOWN gate, nothing verified', async () => {
    assert.equal(hook('ls').status, 2)
    const s = await api.state()
    const r = s.evidence.result
    assert.equal(s.evidence.ok, true)
    assert.deepEqual([r.gate.status, r.gate.why], ['UNKNOWN', 'NEVER_PROBED'])
    assert.deepEqual(r.verified, [])
    assert.ok(r.not_verified.some((n) => n.id === 'irreversible.notify'))
    const view = evidenceScreen(s, { api: async () => ({}), readOnly: false })
    assert.match(text(findAll(view, (e) => hasClass(e, 'hero-label'))[0]), /UNKNOWN/)
    assert.match(text(view), /UNKNOWN does not mean that commands are blocked/)
  })

  it('a probe started from the Console and blocked by the real hook shows ACTIVE, then a signed gate_probe receipt', async () => {
    const start = await api.gateProbe({ action: 'start' })
    assert.equal(start.ok, true)
    let s = await api.state()
    assert.equal(s.evidence.result.gate.pending, true)
    assert.equal(s.evidence.result.gate.command, start.result.command)
    assert.equal(hook(start.result.command).status, 2)
    s = await api.state()
    assert.equal(s.evidence.result.gate.status, 'ACTIVE')
    const fin = await api.gateProbe({ action: 'finish' })
    assert.equal(fin.ok, true)
    assert.equal(fin.result.status, 'ACTIVE')
    s = await api.state()
    const r = s.evidence.result
    assert.equal(r.gate.recorded.verdict, 'ACTIVE')
    assert.equal(r.verified[0].id, 'gate')
    const view = evidenceScreen(s, { api: async () => ({}), readOnly: false })
    assert.match(text(findAll(view, (e) => hasClass(e, 'hero-label'))[0]), /ACTIVE/)
    assert.match(text(view), /not every session of this workspace/)
    // Every line under "not verified" is grey, never green.
    const open = findAll(view, (e) => hasClass(e, 'unverified'))[0]
    assert.ok(open.children.length >= 3)
    assert.ok(findAll(open, (e) => hasClass(e, 'y')).length === 0)
    for (const el of findAll(findAll(view, (e) => hasClass(e, 'verified'))[0], (e) => hasClass(e, 'link'))) assert.match(text(el), /receipt #\d+/)
  })

  it('the recorded (read-only) view has no probe buttons, and a bad action is refused', async () => {
    const s = await api.state()
    const view = evidenceScreen(s, { api: async () => ({}), readOnly: true })
    assert.equal(findAll(view, (e) => e.tag === 'button').length, 0)
    await assert.rejects(api.gateProbe({ action: 'approve' }), /action must be start or finish/)
  })

  it('INACTIVE and a missing evidence answer are shown as such', () => {
    const inactive = { evidence: { ok: true, result: { mission_id: 'm', receipts: 3, gate: { status: 'INACTIVE', why: 'PROBE_RECORDED', pending: false, recorded: { seq: 2 } }, verified: [], not_verified: [], recovery_readiness: {} } } }
    const v = evidenceScreen(inactive, { readOnly: true })
    assert.match(text(findAll(v, (e) => hasClass(e, 'hero-label'))[0]), /INACTIVE/)
    assert.match(text(v), /not protected by the gate/)
    const broken = evidenceScreen({ evidence: { ok: false, error: { code: 'CHAIN_INVALID', message: 'x' } } }, {})
    assert.match(text(broken), /cannot be shown/)
  })

  it('the server routes POST /api/gate-probe, and a recorded source cannot start a probe', async () => {
    const c = await startConsole({ repoDir: ws, env: { ...process.env, JUSTRUNME_HOME: home } })
    try {
      const base = `http://127.0.0.1:${c.port}`
      const post = (body) => fetch(`${base}/api/gate-probe`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const ok = await post({ action: 'start' })
      assert.equal(ok.status, 200)
      assert.match((await ok.json()).result.command, /^touch \.justrunme-gate-probe-/)
      assert.equal((await post({ action: 'start', source: 'recorded' })).status, 403)
      const js = await fetch(`${base}/evidence.js`)
      assert.equal(js.status, 200)
    } finally {
      await c.close()
    }
  })
})
