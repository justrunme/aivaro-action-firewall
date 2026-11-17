import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { appendReceipt, chainPath, verifyChain, readChain, receiptHash } from '../src/receipts/chain.js'
import { checkPolicy } from '../src/receipts/policy.js'

const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}
const M = 'mission-receipts'

// The full Demo B story: plan -> rehearsal -> authorization -> failed run -> undo -> verification.
function story() {
  const repoDir = tmp('jrm-rcpt-')
  const keys = loadOrCreateKeys(tmp('jrm-rcpt-keys-'))
  const add = (kind, verdict, subject = {}, refs = {}) => appendReceipt({ repoDir, keys, missionId: M, kind, verdict, subject, refs }).hash
  const reh = add('rehearsal', 'SAFE', { plan_id: 'plan-a' })
  const auth = add('authorization_issued', 'allow', { plan_id: 'plan-a' }, { rehearsal: reh })
  const run = add('run_result', 'failed', { plan_id: 'plan-a', capture_id: 'cap-1' }, { authorization: auth })
  const undo = add('undo', 'undo', { capture_id: 'cap-1' }, { run })
  add('verification', 'PASS', { capture_id: 'cap-1' }, { undo })
  return { repoDir, keys, file: chainPath(repoDir, M), verify: () => verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId: M }) }
}

describe('receipt chain integrity (R7.1 to R7.4)', () => {
  it('a genuine chain verifies and satisfies the ordering rules', () => {
    const s = story()
    const v = s.verify()
    assert.equal(v.ok, true, JSON.stringify(v.findings))
    assert.equal(v.count, 5)
    assert.equal(checkPolicy(v.receipts).ok, true)
    assert.deepEqual(v.receipts.map((r) => r.seq), [0, 1, 2, 3, 4])
    assert.match(v.receipts[0].signature, /^[0-9a-f]{128}$/)
  })

  it('property: changing any single byte of the receipt file breaks verification', () => {
    const s = story()
    const original = readFileSync(s.file)
    fc.assert(
      fc.property(fc.integer({ min: 0, max: original.length - 1 }), fc.integer({ min: 1, max: 255 }), (pos, delta) => {
        const bytes = Buffer.from(original)
        bytes[pos] = (bytes[pos] + delta) % 256
        writeFileSync(s.file, bytes)
        const ok = s.verify().ok
        writeFileSync(s.file, original)
        return ok === false
      }),
      { numRuns: 400 }
    )
    assert.equal(s.verify().ok, true)
  })

  it('a removed receipt in the middle is reported as a sequence gap and broken link', () => {
    const s = story()
    const lines = readFileSync(s.file, 'utf8').trimEnd().split('\n')
    writeFileSync(s.file, [...lines.slice(0, 2), ...lines.slice(3)].join('\n') + '\n')
    const problems = s.verify().findings.map((f) => f.problem).join(' | ')
    assert.match(problems, /sequence gap/)
    assert.match(problems, /previous-hash link is broken/)
  })

  it('a cut-off tail (last receipts deleted) is caught by the head anchor outside the workspace', () => {
    const s = story()
    const lines = readFileSync(s.file, 'utf8').trimEnd().split('\n')
    writeFileSync(s.file, lines.slice(0, 3).join('\n') + '\n') // the failed run is now the last word
    const v = s.verify()
    assert.equal(v.ok, false)
    assert.match(v.findings.map((f) => f.problem).join(' '), /does not end at the anchored head/)
  })

  it('two receipts swapped are caught', () => {
    const s = story()
    const lines = readFileSync(s.file, 'utf8').trimEnd().split('\n')
    ;[lines[1], lines[2]] = [lines[2], lines[1]]
    writeFileSync(s.file, lines.join('\n') + '\n')
    assert.equal(s.verify().ok, false)
  })

  it('a receipt copied from another mission chain is rejected (no replay across chains)', () => {
    const a = story()
    const b = story()
    const foreign = readFileSync(b.file, 'utf8').trimEnd().split('\n')[2]
    const lines = readFileSync(a.file, 'utf8').trimEnd().split('\n')
    lines[2] = foreign
    writeFileSync(a.file, lines.join('\n') + '\n')
    assert.equal(a.verify().ok, false)
  })

  it('a chain rewritten and re-signed with another key is rejected', () => {
    const s = story()
    const attacker = loadOrCreateKeys(tmp('jrm-rcpt-attacker-'))
    unlinkSync(s.file)
    appendReceipt({ repoDir: s.repoDir, keys: { ...attacker, home: tmp('jrm-rcpt-attacker-home-') }, missionId: M, kind: 'verification', verdict: 'PASS' })
    const v = s.verify()
    assert.equal(v.ok, false)
    assert.ok(v.findings.some((f) => /different key/.test(f.problem)))
  })

  it('a deleted chain with an existing head anchor is reported', () => {
    const s = story()
    unlinkSync(s.file)
    assert.equal(s.verify().ok, false)
  })

  it('appending to a chain that does not verify is refused', () => {
    const s = story()
    const bytes = readFileSync(s.file)
    bytes[20] = bytes[20] ^ 1
    writeFileSync(s.file, bytes)
    assert.throws(() => appendReceipt({ repoDir: s.repoDir, keys: s.keys, missionId: M, kind: 'verification', verdict: 'PASS' }), /does not verify/)
  })

  it('receipts never contain the home path or an e-mail address (R7.5)', () => {
    const repoDir = tmp('jrm-rcpt-')
    const keys = loadOrCreateKeys(tmp('jrm-rcpt-keys-'))
    const home = os.homedir()
    appendReceipt({ repoDir, keys, missionId: M, kind: 'run_refused', verdict: 'deny', subject: { reason: `${home}/x failed for ${['op', 'example.org'].join('@')}` } })
    const text = readFileSync(chainPath(repoDir, M), 'utf8')
    assert.ok(!text.includes(home))
    assert.ok(!text.includes('example.org'))
  })
})

describe('receipt ordering rules (R8.3 groundwork)', () => {
  function chainWith(build) {
    const repoDir = tmp('jrm-rcpt-')
    const keys = loadOrCreateKeys(tmp('jrm-rcpt-keys-'))
    const add = (kind, verdict, subject = {}, refs = {}) => appendReceipt({ repoDir, keys, missionId: M, kind, verdict, subject, refs }).hash
    build(add)
    return checkPolicy(readChain(repoDir, M))
  }

  it('authorization after a DATA LOSS rehearsal is a violation', () => {
    const r = chainWith((add) => {
      const reh = add('rehearsal', 'DATA LOSS', { plan_id: 'p' })
      add('authorization_issued', 'allow', { plan_id: 'p' }, { rehearsal: reh })
    })
    assert.equal(r.ok, false)
    assert.match(r.findings[0].rule, /DATA LOSS/)
  })

  it('a run without an authorization receipt is a violation', () => {
    const r = chainWith((add) => add('run_result', 'completed', { plan_id: 'p', capture_id: 'c' }))
    assert.equal(r.findings[0].kind, 'POLICY_VIOLATION')
  })

  it('one authorization used by two runs is a violation', () => {
    const r = chainWith((add) => {
      const reh = add('rehearsal', 'SAFE', { plan_id: 'p' })
      const auth = add('authorization_issued', 'allow', { plan_id: 'p' }, { rehearsal: reh })
      add('run_result', 'completed', { plan_id: 'p', capture_id: 'c1' }, { authorization: auth })
      add('run_result', 'completed', { plan_id: 'p', capture_id: 'c2' }, { authorization: auth })
    })
    assert.ok(r.findings.some((f) => /already used/.test(f.rule)))
  })

  it('a run of another plan than the authorized one is a violation', () => {
    const r = chainWith((add) => {
      const reh = add('rehearsal', 'SAFE', { plan_id: 'safe' })
      const auth = add('authorization_issued', 'allow', { plan_id: 'safe' }, { rehearsal: reh })
      add('run_result', 'completed', { plan_id: 'dangerous', capture_id: 'c' }, { authorization: auth })
    })
    assert.ok(r.findings.some((f) => /different plan/.test(f.rule)))
  })

  it('a verification that does not directly follow its undo is a violation (no swapped results)', () => {
    const r = chainWith((add) => {
      const reh = add('rehearsal', 'SAFE', { plan_id: 'p' })
      const auth = add('authorization_issued', 'allow', { plan_id: 'p' }, { rehearsal: reh })
      const run = add('run_result', 'failed', { plan_id: 'p', capture_id: 'c' }, { authorization: auth })
      const u1 = add('undo', 'undo', { capture_id: 'c' }, { run })
      add('undo', 'undo', { capture_id: 'c' }, { run })
      add('verification', 'PASS', { capture_id: 'c' }, { undo: u1 })
    })
    assert.ok(r.findings.some((f) => /directly follow/.test(f.rule)))
  })

  it('references are by receipt hash, so pointing at a receipt that is not in the chain fails', () => {
    const r = chainWith((add) => add('authorization_issued', 'allow', { plan_id: 'p' }, { rehearsal: 'sha256:' + 'f'.repeat(64) }))
    assert.equal(r.ok, false)
  })
})
