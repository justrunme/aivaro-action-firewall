/**
 * Gate Health (src/gate): the probe command, the hook's answer to it, and the three states.
 * The end-to-end tests run the real hook process and the real CLI on a temporary workspace.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { stringify } from 'yaml'
import { parseContract } from '../src/contract/parser.js'
import { evaluate } from '../src/hook/evaluate.js'
import { canaryName, probeCommand, probeNonce, probeReason } from '../src/gate/command.js'
import { FRESH_MS, finishProbe, gateHealth, observeProbe, pendingProbe } from '../src/gate/probe.js'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { verifyChain } from '../src/receipts/chain.js'
import { checkPolicy } from '../src/receipts/policy.js'

const HOOK = new URL('../src/hook/pretooluse.js', import.meta.url).pathname
const CLI = new URL('../src/cli/index.js', import.meta.url).pathname
const CONTRACT = {
  id: 'mission-gate-test',
  objective: 'Check the gate probe',
  allowed_paths: ['demo/migrations/'],
  protected_tables: ['orders'],
  time_limit_seconds: 300,
  irreversible_actions: [],
  plan: [{ id: 'step-1', tool: 'shell', args: ['echo', 'x'], reversibility: true }],
  resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['app'] },
}
const NONCE = '0123456789abcdef'

const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}
function setup() {
  const ws = tmp('jrm-gate-ws-')
  const home = tmp('jrm-gate-home-')
  writeFileSync(path.join(ws, 'justrunme.mission.yaml'), stringify(CONTRACT))
  const keys = loadOrCreateKeys(home)
  const env = { ...process.env, JUSTRUNME_HOME: home }
  delete env.JUSTRUNME_GATE
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--repo', ws], { env, encoding: 'utf8' })
    return { exit: r.status, out: JSON.parse(r.stdout) }
  }
  // What Kiro does: the hook first, then the command only if the hook did not block it.
  const agentRuns = (command, { gate = 'on' } = {}) => {
    const e = { ...env, ...(gate ? { JUSTRUNME_GATE: gate } : {}) }
    const h = spawnSync(process.execPath, [HOOK], { cwd: ws, env: e, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, tool_name: 'execute_bash', tool_input: { command } }) })
    if (h.status !== 2) {
      const m = /^touch (\S+)$/.exec(command)
      if (m) writeFileSync(path.join(ws, m[1]), '')
    }
    return h
  }
  const chain = () => verifyChain({ repoDir: ws, home, publicKey: keys.publicKey, missionId: CONTRACT.id })
  return { ws, home, keys, cli, agentRuns, chain }
}

describe('gate probe: the command', () => {
  it('recognises exactly `touch .justrunme-gate-probe-<16 hex>`', () => {
    assert.equal(probeNonce(probeCommand(NONCE)), NONCE)
    assert.equal(probeNonce(`  ${probeCommand(NONCE)}\n`), NONCE)
    for (const c of [`touch .justrunme-gate-probe-${NONCE}; rm -rf demo`, `touch .justrunme-gate-probe-${NONCE} x`, `touch .justrunme-gate-probe-${NONCE.toUpperCase()}`, `touch ./.justrunme-gate-probe-${NONCE}`, `touch .justrunme-gate-probe-${NONCE}0`, `echo touch .justrunme-gate-probe-${NONCE}`, null, 42]) {
      assert.equal(probeNonce(c), null, String(c))
    }
  })

  it('property: a command with anything around the probe is not the probe', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), fc.string(), (a, b) => {
      fc.pre((a + b).trim() !== '')
      const c = `${a}${probeCommand(NONCE)}${b}`
      return probeNonce(c) === null || c.trim() === probeCommand(NONCE)
    }), { numRuns: 300 })
  })

  it('the hook denies the probe even when an authorization allowlists exactly that command', () => {
    const ws = tmp('jrm-gate-eval-')
    writeFileSync(path.join(ws, 'justrunme.mission.yaml'), stringify(CONTRACT))
    const parsed = parseContract(readFileSync(path.join(ws, 'justrunme.mission.yaml'), 'utf8'))
    const now = Date.now()
    const ctx = {
      cwd: ws,
      contract: parsed.contract,
      contractHash: parsed.hash,
      now,
      authorization: { version: 1, mission_id: CONTRACT.id, contract_hash: parsed.hash, fingerprint_hash: 'sha256:' + '0'.repeat(64), issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 600000).toISOString(), entries: [{ action: { tool: 'shell', argv: ['touch', canaryName(NONCE)] }, script_hashes: {} }] },
    }
    const d = evaluate({ tool_name: 'execute_bash', tool_input: { command: probeCommand(NONCE) } }, ctx)
    assert.deepEqual(d, { decision: 'deny', category: 'GATE_PROBE', reason: probeReason(NONCE) })
  })
})

describe('gate probe: end to end with the real hook and CLI', () => {
  it('ACTIVE: the hook blocks the probe, signs it, and the outcome becomes a gate_probe receipt', () => {
    const s = setup()
    const start = s.cli('gate-probe', 'start')
    assert.equal(start.exit, 0)
    assert.match(start.out.result.command, /^touch \.justrunme-gate-probe-[0-9a-f]{16}$/)
    assert.equal(s.cli('gate-probe', 'status').exit, 35, 'UNKNOWN before the agent ran anything')
    const h = s.agentRuns(start.out.result.command)
    assert.equal(h.status, 2)
    assert.equal(JSON.parse(h.stderr.trim()).category, 'GATE_PROBE')
    assert.ok(!existsSync(path.join(s.ws, canaryName(start.out.result.nonce))))
    const st = s.cli('gate-probe', 'status')
    assert.equal(st.exit, 0)
    assert.equal(st.out.result.status, 'ACTIVE')
    assert.equal(s.cli('evidence').out.result.gate.status, 'ACTIVE')
    const fin = s.cli('gate-probe', 'finish')
    assert.equal(fin.exit, 0)
    const c = s.chain()
    assert.equal(c.ok, true)
    assert.deepEqual(checkPolicy(c.receipts).findings, [])
    const g = c.receipts.at(-1)
    assert.deepEqual([g.kind, g.verdict, g.subject.nonce, g.subject.canary_present], ['gate_probe', 'ACTIVE', start.out.result.nonce, false])
    assert.ok(g.refs.hook_decision)
    assert.equal(existsSync(path.join(s.ws, '.justrunme/gate-probe.json')), false)
    const ev = s.cli('evidence').out.result
    assert.equal(ev.gate.status, 'ACTIVE')
    assert.equal(ev.gate.recorded.seq, g.seq)
  })

  it('INACTIVE: with the gate off the command runs, the canary proves it, and finish removes the canary', () => {
    const s = setup()
    const start = s.cli('gate-probe', 'start').out.result
    const h = s.agentRuns(start.command, { gate: null })
    assert.equal(h.status, 0)
    assert.ok(existsSync(path.join(s.ws, canaryName(start.nonce))))
    const st = s.cli('gate-probe', 'status')
    assert.equal(st.exit, 34)
    assert.equal(st.out.result.status, 'INACTIVE')
    assert.equal(s.cli('gate-probe', 'finish').exit, 34)
    assert.equal(s.chain().receipts.at(-1).verdict, 'INACTIVE')
    assert.equal(existsSync(path.join(s.ws, canaryName(start.nonce))), false)
    assert.equal(s.cli('evidence').out.result.gate.status, 'INACTIVE')
  })

  it('a canary the agent turned into a directory does not hide the recorded INACTIVE', () => {
    const s = setup()
    const p = s.cli('gate-probe', 'start').out.result
    mkdirSync(path.join(s.ws, canaryName(p.nonce), 'x'), { recursive: true })
    writeFileSync(path.join(s.ws, canaryName(p.nonce), 'x', 'y'), '')
    const fin = s.cli('gate-probe', 'finish')
    assert.equal(fin.exit, 34)
    assert.equal(fin.out.result.status, 'INACTIVE')
    assert.equal(fin.out.result.canary_removed, false)
    assert.equal(s.chain().receipts.at(-1).verdict, 'INACTIVE')
  })

  it('UNKNOWN is recorded as UNKNOWN when the agent never ran the command', () => {
    const s = setup()
    s.cli('gate-probe', 'start')
    const fin = s.cli('gate-probe', 'finish')
    assert.equal(fin.exit, 35)
    assert.equal(s.chain().receipts.at(-1).verdict, 'UNKNOWN')
    assert.equal(s.cli('evidence').out.result.gate.status, 'UNKNOWN')
  })

  it('INACTIVE wins over a receipt, and a denial of an older or another nonce is not ACTIVE', () => {
    const s = setup()
    const old = s.cli('gate-probe', 'start').out.result
    s.agentRuns(old.command)
    const cur = s.cli('gate-probe', 'start').out.result
    assert.equal(s.cli('gate-probe', 'status').out.result.status, 'UNKNOWN', 'the denial of the older nonce does not count')
    s.agentRuns(cur.command)
    writeFileSync(path.join(s.ws, canaryName(cur.nonce)), '')
    assert.equal(s.cli('gate-probe', 'status').out.result.status, 'INACTIVE')
  })

  it('a denial that predates the probe start is not ACTIVE', () => {
    const s = setup()
    const p = s.cli('gate-probe', 'start').out.result
    s.agentRuns(p.command)
    const receipts = s.chain().receipts
    const later = { nonce: p.nonce, started_at: new Date(Date.now() + 60_000).toISOString() }
    assert.equal(observeProbe({ repoDir: s.ws, receipts, probe: later }).status, 'UNKNOWN')
  })

  it('ACTIVE goes stale after 15 minutes; recent hook receipts alone never make it ACTIVE', () => {
    const s = setup()
    const p = s.cli('gate-probe', 'start').out.result
    s.agentRuns(p.command)
    s.cli('gate-probe', 'finish')
    const receipts = s.chain().receipts
    assert.equal(gateHealth({ repoDir: s.ws, receipts }).status, 'ACTIVE')
    const stale = gateHealth({ repoDir: s.ws, receipts, now: Date.now() + FRESH_MS + 1000 })
    assert.deepEqual([stale.status, stale.why], ['UNKNOWN', 'STALE'])
    const s2 = setup()
    s2.agentRuns('ls')
    const g = gateHealth({ repoDir: s2.ws, receipts: s2.chain().receipts })
    assert.deepEqual([g.status, g.why], ['UNKNOWN', 'NEVER_PROBED'])
    assert.equal(g.last_hook_decision.verdict, 'deny')
  })

  it('the ordering policy refuses an ACTIVE gate_probe that does not rest on the hook denial of its own probe', () => {
    const s = setup()
    const p = s.cli('gate-probe', 'start').out.result
    s.agentRuns(p.command)
    s.cli('gate-probe', 'finish')
    const rs = s.chain().receipts
    assert.deepEqual(checkPolicy(rs).findings, [])
    const probe = rs.at(-1)
    const forged = (over) => checkPolicy([...rs.slice(0, -1), { ...probe, ...over, subject: { ...probe.subject, ...(over.subject ?? {}) } }]).findings.map((f) => f.rule)
    assert.deepEqual(forged({ refs: {} }), ['ACTIVE must refer to an earlier hook denial of the probe command'])
    assert.deepEqual(forged({ subject: { nonce: 'ffffffffffffffff' } }), ['ACTIVE refers to a hook denial of another probe'])
    assert.deepEqual(forged({ subject: { started_at: new Date(Date.now() + 60_000).toISOString() } }), ['ACTIVE refers to a hook denial from before the probe started'])
    assert.deepEqual(forged({ verdict: 'INACTIVE' }), ['INACTIVE without the canary file'])
  })

  it('freshness counts from the hook denial: a late finish records UNKNOWN (stale), never a fresh ACTIVE', () => {
    const s = setup()
    const p = s.cli('gate-probe', 'start').out.result
    s.agentRuns(p.command)
    const before = s.chain().receipts
    const denial = before.at(-1)
    const t0 = Date.parse(denial.timestamp)
    // Finish 30 minutes after the denial (the hook denial is the only evidence of a gated session).
    const r = finishProbe({ repoDir: s.ws, keys: s.keys, missionId: CONTRACT.id, receipts: before, now: t0 + 30 * 60_000 })
    assert.deepEqual([r.status, r.stale], ['UNKNOWN', true])
    const rs = s.chain().receipts
    const g = rs.at(-1)
    assert.deepEqual([g.kind, g.verdict, g.subject.stale], ['gate_probe', 'UNKNOWN', true])
    assert.deepEqual(checkPolicy(rs).findings, [])
    const h = gateHealth({ repoDir: s.ws, receipts: rs, now: t0 + 30 * 60_000 })
    assert.deepEqual([h.status, h.why], ['UNKNOWN', 'STALE'])
    assert.equal(pendingProbe(s.ws), null)
  })

  it('a recorded ACTIVE ages from its hook denial, not from the gate_probe receipt', () => {
    const s = setup()
    const p = s.cli('gate-probe', 'start').out.result
    s.agentRuns(p.command)
    const before = s.chain().receipts
    const t0 = Date.parse(before.at(-1).timestamp)
    // Recorded 10 minutes after the denial: still fresh then.
    const r = finishProbe({ repoDir: s.ws, keys: s.keys, missionId: CONTRACT.id, receipts: before, now: t0 + 10 * 60_000 })
    assert.equal(r.status, 'ACTIVE')
    const rs = s.chain().receipts
    assert.deepEqual(checkPolicy(rs).findings, [])
    assert.equal(gateHealth({ repoDir: s.ws, receipts: rs, now: t0 + 14 * 60_000 }).status, 'ACTIVE')
    // 20 minutes after the denial: stale, although the gate_probe receipt is only 10 minutes old.
    const h = gateHealth({ repoDir: s.ws, receipts: rs, now: t0 + 20 * 60_000 })
    assert.deepEqual([h.status, h.why], ['UNKNOWN', 'STALE'])
    assert.equal(h.recorded.hook_receipt.seq, before.at(-1).seq)
  })

  it('a recorded ACTIVE whose hook denial is not in the chain is UNKNOWN', () => {
    const s = setup()
    const p = s.cli('gate-probe', 'start').out.result
    s.agentRuns(p.command)
    s.cli('gate-probe', 'finish')
    const rs = s.chain().receipts
    const probe = rs.at(-1)
    const h = gateHealth({ repoDir: s.ws, receipts: [{ ...probe, refs: { hook_decision: 'sha256:' + '0'.repeat(64) } }] })
    assert.deepEqual([h.status, h.why], ['UNKNOWN', 'HOOK_RECEIPT_MISSING'])
  })

  it('the ordering policy refuses an ACTIVE recorded after its hook denial went stale', () => {
    const s = setup()
    const p = s.cli('gate-probe', 'start').out.result
    s.agentRuns(p.command)
    s.cli('gate-probe', 'finish')
    const rs = s.chain().receipts
    const probe = rs.at(-1)
    const late = { ...probe, timestamp: new Date(Date.parse(rs.at(-2).timestamp) + FRESH_MS + 1000).toISOString() }
    assert.deepEqual(checkPolicy([...rs.slice(0, -1), late]).findings.map((f) => f.rule), ['ACTIVE recorded after its hook denial went stale'])
  })

  it('gate-probe refuses another mission and unknown actions', () => {
    const s = setup()
    assert.equal(s.cli('gate-probe', 'start', '--mission', 'mission-other').exit, 2)
    assert.equal(s.cli('gate-probe', 'approve').exit, 2)
    assert.equal(s.cli('gate-probe', 'finish').out.error.code, 'NO_PROBE')
  })
})
