/**
 * ProofDebt (src/evidence/proofdebt.js) and recovery coverage (src/undo/verify.js coverageOf).
 * The receipts here are built in memory (proofDebt reads a chain that was already verified);
 * the point is what is claimed from them, and above all what is not.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { proofDebt } from '../src/evidence/proofdebt.js'
import { receiptHash } from '../src/receipts/chain.js'
import { coverageOf } from '../src/undo/verify.js'

function chain() {
  const receipts = []
  const add = (kind, verdict, subject = {}, refs = {}) => {
    const r = { kind, verdict, seq: receipts.length, timestamp: new Date(1_800_000_000_000 + receipts.length * 1000).toISOString(), subject, refs }
    receipts.push(r)
    return receiptHash(r)
  }
  return { receipts, add }
}
/** rehearsal SAFE -> authorization -> run (equal to the rehearsal), optionally undo + verification. */
function story({ source = 'stdin', undo = null } = {}) {
  const c = chain()
  const reh = c.add('rehearsal', 'SAFE', { plan_id: 'plan-1', files_hash: 'sha256:f' })
  const auth = c.add('authorization_issued', 'allow', { plan_id: 'plan-1', passphrase_source: source }, { rehearsal: reh })
  const run = c.add('run_result', 'completed', { plan_id: 'plan-1', matches_rehearsal: true, differences: 0 }, { authorization: auth })
  if (undo) {
    const u = c.add('undo', 'undo', {}, { run })
    c.add('verification', undo.verdict, undo.subject, { undo: u })
  }
  return c.receipts
}
const ids = (items) => items.map((x) => x.id)
const GATE_ACTIVE = { status: 'ACTIVE', observed: null, recorded: { seq: 9, hash: 'sha256:g', at: '2026-11-20T12:00:00.000Z' } }

describe('ProofDebt: nothing is claimed without a receipt', () => {
  it('an empty chain claims nothing and lists what is missing', () => {
    const d = proofDebt({ receipts: [] })
    assert.deepEqual(d.verified, [])
    assert.deepEqual(ids(d.not_verified), ['gate', 'authorization', 'execution', 'external', 'recovery_rehearsal'])
    assert.equal(d.recovery_readiness.last_verified_recovery, null)
    assert.equal(d.recovery_readiness.recovery_rehearsed, null)
  })

  it('property: every verified line names a receipt, and external effects are always listed as not verified', () => {
    const kinds = ['rehearsal', 'authorization_issued', 'run_result', 'undo', 'verification', 'hook_decision', 'gate_probe']
    const verdicts = ['SAFE', 'DATA LOSS', 'allow', 'deny', 'completed', 'failed', 'undo', 'PASS', 'FAIL', 'UNVERIFIABLE', 'ACTIVE', 'INACTIVE', 'UNKNOWN']
    fc.assert(fc.property(fc.array(fc.record({ kind: fc.constantFrom(...kinds), verdict: fc.constantFrom(...verdicts), link: fc.boolean(), checked: fc.option(fc.subarray(['schema_hash', 'row_count', 'health'])), source: fc.constantFrom('tty', 'stdin', 'env', null) }), { maxLength: 12 }), (spec) => {
      const c = chain()
      let prev = null
      for (const s of spec) {
        const subject = { passphrase_source: s.source, matches_rehearsal: s.link, ...(s.checked ? { checked: s.checked } : {}) }
        prev = c.add(s.kind, s.verdict, subject, s.link && prev ? { rehearsal: prev, authorization: prev, run: prev, undo: prev } : {})
      }
      const d = proofDebt({ receipts: c.receipts })
      return d.verified.every((v) => v.receipt && typeof v.receipt.hash === 'string') && d.not_verified.some((n) => n.id === 'external') && !d.verified.some((v) => v.id === 'external' || v.id === 'gate')
    }), { numRuns: 300 })
  })

  it('a scripted approval and an approval without a recorded channel are not counted as the operator channel', () => {
    assert.equal(proofDebt({ receipts: story({ source: 'env' }) }).not_verified.find((n) => n.id === 'authorization').why, 'SCRIPTED_APPROVAL')
    assert.equal(proofDebt({ receipts: story({ source: null }) }).not_verified.find((n) => n.id === 'authorization').why, 'CHANNEL_NOT_RECORDED')
    const ok = proofDebt({ receipts: story({ source: 'tty' }) })
    assert.match(ok.verified.find((v) => v.id === 'authorization').text, /the channel, not who typed it/)
    assert.deepEqual(ids(ok.verified), ['authorization', 'rehearsal', 'execution'])
  })

  it('a run that is not undone has no recovery claim; readiness says so', () => {
    const d = proofDebt({ receipts: story() })
    assert.ok(!d.verified.some((v) => v.id.startsWith('recovery')))
    assert.equal(d.recovery_readiness.latest_run_recovery, 'NOT_UNDONE')
  })

  it('an undo without a verification receipt is not reported as "not undone", and claims no recovery', () => {
    const c = chain()
    const reh = c.add('rehearsal', 'SAFE', { plan_id: 'plan-1' })
    const auth = c.add('authorization_issued', 'allow', { passphrase_source: 'stdin' }, { rehearsal: reh })
    const run = c.add('run_result', 'completed', { matches_rehearsal: true }, { authorization: auth })
    c.add('undo', 'undo', {}, { run })
    const d = proofDebt({ receipts: c.receipts })
    assert.equal(d.recovery_readiness.latest_run_recovery, 'UNDONE · NOT VERIFIED')
    assert.equal(d.recovery_readiness.latest_run_recovery_receipt.seq, 3)
    assert.equal(d.not_verified.find((n) => n.id === 'recovery').why, 'NO_VERIFICATION')
  })

  it('a legacy PASS (no list of checks) claims no check', () => {
    const d = proofDebt({ receipts: story({ undo: { verdict: 'PASS', subject: { checks: 7, integration_tests: 'not configured' } } }) })
    assert.ok(!d.verified.some((v) => v.id.startsWith('recovery')))
    assert.equal(d.not_verified.find((n) => n.id === 'recovery').why, 'CHECKS_NOT_RECORDED')
    assert.equal(d.recovery_readiness.last_verified_recovery, null, 'a legacy PASS is not a verified recovery')
  })

  it('a current PASS with coverage names each check with its coverage; health, tests and containers stay open', () => {
    const coverage = { by_check: { schema_hash: 1, row_count: 3, table_checksum: 3, container_image: 1 }, captured: { files: 0, databases: 1, tables: 3, container_images: 1 }, health: 'not configured' }
    const d = proofDebt({ receipts: story({ undo: { verdict: 'PASS', subject: { checked: ['container_image', 'row_count', 'schema_hash', 'table_checksum'], coverage, integration_tests: 'not configured' } } }) })
    const texts = d.verified.filter((v) => v.id.startsWith('recovery.')).map((v) => v.text)
    assert.ok(texts.includes('Recovery checked: row counts of 3 table(s); 3 captured'))
    assert.ok(texts.includes('Recovery checked: image of 1 container(s); 1 captured'))
    assert.deepEqual(ids(d.not_verified).filter((i) => i.startsWith('recovery.')), ['recovery.health', 'recovery.integration_tests', 'recovery.containers'])
    assert.ok(d.recovery_readiness.last_verified_recovery)
  })

  it('a current PASS without coverage lists the checks but says the coverage is not recorded', () => {
    const d = proofDebt({ receipts: story({ undo: { verdict: 'PASS', subject: { checked: ['row_count'], integration_tests: 'not configured' } } }) })
    assert.ok(d.verified.some((v) => v.text === 'Recovery checked: row_count'))
    assert.ok(d.not_verified.some((n) => n.why === 'COVERAGE_NOT_RECORDED'))
    assert.ok(d.not_verified.some((n) => n.why === 'HEALTH_NOT_CONFIGURED'))
  })

  it('UNVERIFIABLE and not_checked are open debts, never verified', () => {
    const d = proofDebt({ receipts: story({ undo: { verdict: 'UNVERIFIABLE', subject: { checked: ['row_count'], not_checked: [{ check: 'privileges', resource: 'pumpkin_patch' }], integration_tests: 'not configured' } } }) })
    assert.ok(!d.verified.some((v) => v.id.startsWith('recovery')))
    assert.ok(d.not_verified.some((n) => n.text === 'Recovery not checked: privileges (pumpkin_patch)'))
    assert.equal(d.not_verified.find((n) => n.id === 'recovery').why, 'RECOVERY_UNVERIFIABLE')
  })

  it('irreversible steps of the contract, legacy rehearsals and the gate are listed', () => {
    const d = proofDebt({ receipts: story(), contract: { irreversible_actions: ['send-mail'] }, legacyVersions: 2, gate: GATE_ACTIVE })
    assert.ok(d.not_verified.some((n) => n.id === 'irreversible.send-mail'))
    assert.ok(d.not_verified.some((n) => n.why === 'LEGACY_REHEARSALS'))
    assert.equal(d.verified[0].id, 'gate')
    assert.equal(proofDebt({ receipts: [], gate: { status: 'INACTIVE', recorded: null } }).not_verified[0].why, 'GATE_INACTIVE')
  })
})

describe('recovery coverage', () => {
  it('counts each check and what the capture holds', () => {
    const checks = [{ check: 'row_count' }, { check: 'row_count' }, { check: 'schema_hash' }, { check: 'file_sha256' }]
    const manifest = { files: { files: [{}, {}] }, postgres: [{ measurement: { tables: { a: {}, b: {} } } }], containers: { images: { db: 'x' } } }
    assert.deepEqual(coverageOf(checks, manifest, null), { by_check: { row_count: 2, schema_hash: 1, file_sha256: 1 }, captured: { files: 2, databases: 1, tables: 2, container_images: 1 }, health: 'not configured' })
    assert.equal(coverageOf([], { postgres: [] }, { service: 'app', url: 'http://x/' }).health, 'checked')
  })
})
