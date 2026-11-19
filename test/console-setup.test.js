/**
 * Console D2.2: Setup and its read-only diagnostics, Built with Kiro, the architecture strip,
 * recorded mission titles, and recovery claims that carry their limit.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupStatus } from '../src/console/setup.js'
import { openRecorded } from '../src/console/recorded.js'
import { main } from '../src/cli/index.js'
import { RECOVERY_LIMIT, missionSummary, recoverySummary } from '../src/console/static/model.js'
import { loadOrCreateTestKeys } from './support/keys.js'
import { findAll, hasClass, installFakeDom } from './support/fake-dom.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHIPPED = path.join(ROOT, 'demo/recorded-run')
const A = 'mission-t25v2-a'
const B = 'mission-demo-b'
const text = (n) => n.textContent.replace(/\s+/g, ' ')
const fire = (el, type, ev = {}) => Promise.all((el.listeners[type] ?? []).map((fn) => fn({ preventDefault() {}, target: el, ...ev })))
const tmps = []
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  tmps.push(d)
  return d
}

let restoreDom
let savedHome
let rec
let states
before(async () => {
  restoreDom = installFakeDom()
  savedHome = process.env.JUSTRUNME_HOME
  rec = openRecorded(SHIPPED)
  states = { [A]: await rec.api.state(A), [B]: await rec.api.state(B) }
})
after(() => {
  restoreDom?.()
  rec?.close()
  if (savedHome === undefined) delete process.env.JUSTRUNME_HOME
  else process.env.JUSTRUNME_HOME = savedHome
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

const CONTRACT = `id: setup-test-mission
objective: Check the setup page
allowed_paths: [demo/migrations/]
protected_tables: [orders]
time_limit_seconds: 300
irreversible_actions: []
plan:
  - { id: migrate, tool: sql_migration, args: [demo/migrations/003.sql], reversibility: true }
resources: { databases: [pumpkin_patch], config_files: [], compose_services: [db] }
`

describe('Setup diagnostics: read only, three states kept apart', () => {
  it('an empty workspace: nothing installed, gate unknown, mission not verified; nothing written', async () => {
    const ws = tmp('jrm-setup-empty-')
    process.env.JUSTRUNME_HOME = tmp('jrm-setup-keys-')
    const before = readdirSync(ws)
    const s = await setupStatus({ repoDir: ws, runMain: main })
    assert.deepEqual(s.states, { hook_installed: 'no', gate_enabled: 'unknown', mission_protected: 'not_verified' })
    assert.equal(s.gate.observable, false)
    assert.deepEqual([s.keys.operator, s.keys.approver, s.contract.present, s.target, s.operator_agent], [false, false, false, false, false])
    assert.deepEqual(readdirSync(ws), before, 'the diagnostics wrote nothing into the workspace')
    assert.deepEqual(readdirSync(process.env.JUSTRUNME_HOME), [], 'and created no key')
    assert.ok(!JSON.stringify(s).includes(ws) && !JSON.stringify(s).includes(process.env.JUSTRUNME_HOME), 'no local path in the answer')
  })

  it('this repository: the shipped hook counts as installed, and that alone is not protection', async () => {
    process.env.JUSTRUNME_HOME = tmp('jrm-setup-keys-')
    const s = await setupStatus({ repoDir: ROOT, runMain: main })
    assert.equal(s.states.hook_installed, 'yes')
    assert.deepEqual(s.hook.files.map((f) => f.file), ['.kiro/hooks/pretooluse.json'])
    assert.equal(s.hook.files[0].command, 'node src/hook/pretooluse.js')
    assert.equal(s.states.gate_enabled, 'unknown', 'an installed hook says nothing about the gate')
    assert.equal(s.states.mission_protected, 'not_verified')
    assert.equal(s.operator_agent, true)
  })

  it('a valid contract and a key, but no hook decisions: still not verified; with signed hook decisions: "seen", never "protected"', async () => {
    const ws = tmp('jrm-setup-ws-')
    mkdirSync(path.join(ws, '.kiro/hooks'), { recursive: true })
    cpSync(path.join(ROOT, '.kiro/hooks/pretooluse.json'), path.join(ws, '.kiro/hooks/pretooluse.json'))
    mkdirSync(path.join(ws, 'src/hook'), { recursive: true })
    writeFileSync(path.join(ws, 'src/hook/pretooluse.js'), '// stand-in for the hook script\n')
    writeFileSync(path.join(ws, 'justrunme.mission.yaml'), CONTRACT)
    const home = tmp('jrm-setup-keys-')
    const keys = loadOrCreateTestKeys(home)
    process.env.JUSTRUNME_HOME = home
    const s1 = await setupStatus({ repoDir: ws, runMain: main })
    assert.equal(s1.contract.valid, true)
    assert.equal(s1.contract.mission_id, 'setup-test-mission')
    assert.equal(s1.keys.operator, true)
    assert.equal(s1.states.hook_installed, 'yes')
    assert.equal(s1.states.mission_protected, 'not_verified', 'no hook decision in the chain yet')
    const { appendReceipt } = await import('../src/receipts/chain.js')
    appendReceipt({ repoDir: ws, keys, missionId: 'setup-test-mission', kind: 'hook_decision', verdict: 'deny', subject: { tool: 'execute_bash' } })
    const s2 = await setupStatus({ repoDir: ws, runMain: main })
    assert.equal(s2.evidence.chain_ok, true)
    assert.equal(s2.evidence.hook_decisions, 1)
    assert.equal(s2.states.mission_protected, 'seen')
    assert.ok(!/protected"?\s*:\s*"?(yes|true|protected)/i.test(JSON.stringify(s2.states)))
    writeFileSync(path.join(ws, 'justrunme.mission.yaml'), 'id: x\nunknown_key: 1\n')
    const s3 = await setupStatus({ repoDir: ws, runMain: main })
    assert.equal(s3.contract.valid, false)
    assert.ok(s3.contract.errors.length > 0)
  })
})

describe('Setup screen', () => {
  const onboarding = () => import('../src/console/static/onboarding.js')

  it('seven steps with copyable commands, three states with ≠, and no PROTECTED anywhere', async () => {
    const { setupScreen } = await onboarding()
    const status = { ok: true, node: { version: '24.0.0', ok: true }, hook: { installed: true, files: [{ file: '.kiro/hooks/pretooluse.json' }], script: true }, keys: { operator: true, approver: false }, gate: { observable: false }, contract: { present: false, valid: false, errors: [] }, target: false, operator_agent: true, evidence: { checked: false }, states: { hook_installed: 'yes', gate_enabled: 'unknown', mission_protected: 'not_verified' } }
    const root = setupScreen({ setup: { mode: 'live', status }, ui: {} })
    const t = text(root)
    assert.equal(findAll(root, (e) => hasClass(e, 'setup-step')).length, 7)
    for (const title of ['Get JustRunMe', 'Kiro PreToolUse hook', 'Operator and approver keys', 'Enable the gate for a new Kiro session', 'Mission contract', 'Check that the hook really blocks', 'Start a protected Kiro workflow']) assert.ok(t.includes(title), title)
    assert.equal(findAll(root, (e) => hasClass(e, 'st3-ne')).length, 2, 'Hook installed ≠ Gate enabled ≠ Mission protected')
    assert.ok(t.includes('Not visible from the Console') && t.includes('Not verified') && t.includes('Installed'))
    assert.ok(!/\bPROTECTED\b/.test(t.replace(/Never shown as PROTECTED\./g, '')), 'never a PROTECTED status')
    assert.ok(t.includes('JUSTRUNME_GATE=on kiro-cli chat'))
    assert.ok(t.includes('Unknown from the Console'), 'the gate step is never shown as done')
    const copies = findAll(root, (e) => e.tag === 'button' && hasClass(e, 'copy-btn'))
    assert.ok(copies.length >= 9, `copy buttons: ${copies.length}`)
    const writes = []
    const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (v) => writes.push(v) } }, configurable: true })
    try {
      await fire(copies[0], 'click')
    } finally {
      if (was) Object.defineProperty(globalThis, 'navigator', was)
    }
    assert.ok(writes[0].startsWith('git clone https://github.com/justrunme/justrunme-zero'))
  })

  it('every command and file it names exists in this repository; the hook JSON shown is the shipped one', async () => {
    const { setupScreen, KIRO_PARTS } = await onboarding()
    const root = setupScreen({ setup: { mode: 'recorded', status: null }, ui: {} })
    const t = text(root)
    assert.ok(t.includes('Informational.') && t.includes('does not inspect or control your Kiro installation'))
    assert.equal(findAll(root, (e) => hasClass(e, 'st3') && text(e).includes('Not inspected')).length, 3, 'no state is claimed in recorded mode')
    const shown = findAll(root, (e) => hasClass(e, 'cmd')).find((c) => text(c).includes('.kiro/hooks/pretooluse.json'))
    const code = findAll(shown, (e) => e.tag === 'code')[0].textContent
    assert.deepEqual(JSON.parse(code), JSON.parse(readFileSync(path.join(ROOT, '.kiro/hooks/pretooluse.json'), 'utf8')))
    for (const f of ['src/hook/pretooluse.js', 'src/cli/index.js', '.kiro/agents/justrunme-operator.json', 'test/hook.test.js', 'scripts/agent-workspace.js', 'docs/agent-runs/2026-11-18-run1.md']) assert.ok(existsSync(path.join(ROOT, f)), f)
    for (const k of KIRO_PARTS) assert.ok(existsSync(path.join(ROOT, k.path)), k.path)
    assert.match(readFileSync(path.join(ROOT, 'scripts/agent-workspace.js'), 'utf8'), /JUSTRUNME_GATE=on .*kiro-cli chat --v3 --agent justrunme-operator .*--trust-workspace --require-mcp-startup/)
    const contract = findAll(root, (e) => hasClass(e, 'cmd')).find((c) => text(c).includes('justrunme.mission.yaml'))
    const { parseContract } = await import('../src/contract/parser.js')
    assert.equal(parseContract(findAll(contract, (e) => e.tag === 'code')[0].textContent).ok, true, 'the example contract is valid')
  })

  it('loading and error states never read as a result', async () => {
    const { setupScreen } = await onboarding()
    assert.ok(text(setupScreen({ setup: null, ui: {} })).includes('Reading this Console'))
    assert.ok(text(setupScreen({ setup: { mode: 'live', status: null, error: 'UNAUTHORIZED: x' }, ui: {} })).includes('The setup checks could not be read'))
  })
})

describe('Built with Kiro and the architecture', () => {
  it('four confirmed parts with paths, Copy Path and GitHub links; live and replayed runs kept apart; no Aivaro', async () => {
    const { builtWithKiro, PUBLIC_REPO } = await import('../src/console/static/onboarding.js')
    const root = builtWithKiro()
    const t = text(root)
    for (const p of ['Kiro Specs', 'PreToolUse Hook', 'MCP Integration', 'Development Evidence', '.kiro/specs/justrunme-zero/', '.kiro/hooks/pretooluse.json', 'src/mcp/', 'docs/KIRO_LOG.md']) assert.ok(t.includes(p), p)
    assert.equal(findAll(root, (e) => e.tag === 'button' && text(e).includes('Copy path')).length, 4)
    const links = findAll(root, (e) => e.tag === 'a').map((a) => a.attrs.href)
    assert.equal(links.length, 4)
    for (const l of links) assert.ok(l.startsWith(`${PUBLIC_REPO}/`), l)
    assert.ok(t.includes('replayed from T25 v3 run T3') && t.includes('no live agent wrote them'))
    assert.ok(!/aivaro/i.test(t))
  })

  it('six stages; each opens what happens, what is checked and the evidence, with a recorded example; the hook does not rehearse', async () => {
    const { architecture, STAGES } = await import('../src/console/static/onboarding.js')
    const opened = []
    const ui = {}
    const root = architecture(ui, (href) => opened.push(href))
    const steps = findAll(root, (e) => hasClass(e, 'arch-step'))
    assert.deepEqual(steps.map((s) => text(s).replace(/^\d+/, '')), ['Agent', 'Rehearse', 'Measure', 'Approve', 'Execute', 'Verify'])
    assert.ok(text(root).includes('It does not rehearse a call by itself'))
    await fire(steps[2], 'click')
    const d = text(findAll(root, (e) => hasClass(e, 'arch-detail'))[0])
    assert.ok(d.includes('What happens') && d.includes('What is checked') && d.includes('Evidence produced') && d.includes('LOGIC BYPASS'))
    assert.equal(ui.archStage, 'measure')
    await fire(findAll(findAll(root, (e) => hasClass(e, 'arch-detail'))[0], (e) => e.tag === 'a')[0], 'click')
    assert.deepEqual(opened, ['impact'])
    for (const s of STAGES) assert.match(s.example[0], /^(impact|approvals|missions\/mission-t25v2-a\/(proposed|rehearsed|executed|verified))$/)
    const none = architecture({}, null)
    assert.ok(text(none).includes('needs the verified recorded run'), 'no example link without a verified recording')
  })
})

describe('Recorded titles and recovery claims', () => {
  it('the manifest carries the titles; the signed files did not change for them', () => {
    const m = JSON.parse(readFileSync(path.join(SHIPPED, 'manifest.json'), 'utf8'))
    assert.equal(m.provenance.missions[A].title, 'Hidden Trigger: Prevented Data Loss')
    assert.equal(m.provenance.missions[B].title, 'Backfill Quantities: Run, Undo, Recovery Check')
    assert.equal(rec.integrity.ok, true)
    assert.equal(states[A].verify.result.ok, true)
    assert.equal(states[B].verify.result.ok, true)
  })

  it('Missions shows the title next to the id for the recorded run, and the id alone for live missions', async () => {
    const { missionsScreen } = await import('../src/console/static/screens.js')
    const all = [{ mission_id: A, state: states[A] }, { mission_id: B, state: states[B] }]
    const titled = text(missionsScreen(states[A], { all, ui: {}, route: { screen: 'missions' }, titles: { [A]: 'Hidden Trigger: Prevented Data Loss' } }))
    assert.ok(titled.includes('Hidden Trigger: Prevented Data Loss') && titled.includes(A))
    const live = text(missionsScreen(states[A], { all, ui: {}, route: { screen: 'missions' }, titles: {} }))
    assert.ok(!live.includes('Hidden Trigger') && live.includes(A))
  })

  it('the revisions stay separate attempts, and a recovery claim always carries its limit', () => {
    const sa = missionSummary(states[A].story.result, true)
    assert.deepEqual(sa.revisions.map((r) => `#${r.seq} ${r.verdict}`), ['#0 DATA LOSS', '#1 LOGIC BYPASS', '#2 SAFE'])
    const sb = missionSummary(states[B].story.result, true)
    assert.ok(sb.outcome.includes('recovery verification PASS') && sb.outcome.includes('database grants were not compared'))
    const rb = recoverySummary(states[B].story.result, true)
    assert.equal(rb.label, 'RECOVERED · VERIFIED')
    assert.equal(rb.limit, RECOVERY_LIMIT)
    assert.ok(RECOVERY_LIMIT.includes('did not compare database grants or ownership'))
    const ra = recoverySummary(states[A].story.result, true)
    assert.equal(ra.label, 'EXECUTION VERIFIED')
    assert.deepEqual(ra.lines.map((l) => l.ok), [true, true, true])
    assert.equal(ra.limit, null)
    assert.equal(recoverySummary(states[B].story.result, false).label, 'NOT VERIFIED')
  })

  it('Recovery & Replay puts the summary first and the receipt chain in a disclosure below', async () => {
    const { recoveryScreen } = await import('../src/console/static/screens.js')
    const root = recoveryScreen(states[B], { ui: {}, route: { screen: 'recovery' }, readOnly: true, api: async () => ({}) })
    const t = text(root)
    assert.ok(t.indexOf('RECOVERED · VERIFIED') < t.indexOf('Receipt chain'), 'summary before the chain')
    assert.ok(t.includes('did not compare database grants'), 'the limit is next to the claim')
    assert.ok(t.includes('Authorized at the command line'))
    assert.equal(findAll(root, (e) => e.tag === 'details' && hasClass(e, 'chain-box')).length, 1)
  })
})
