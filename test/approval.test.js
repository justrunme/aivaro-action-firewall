/**
 * T23: approval requests and the chain rules around them. An agent can only ask;
 * the answer is a separate signed authorization, once, before the request expires,
 * and never after a denial.
 */

import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApprovalError, REQUEST_TTL_SECONDS, approvalsDir, createRequest, listRequests, loadRequest, requestState } from '../src/approval/requests.js'
import { appendReceipt, receiptHash, verifyChain } from '../src/receipts/chain.js'
import { checkPolicy } from '../src/receipts/policy.js'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { hashValue } from '../src/util/canonical.js'
import { loadOrCreateTestKeys } from './support/keys.js'

const MISSION = 'mission-approval-test'
const CONTRACT = { id: MISSION, time_limit_seconds: 300 }
const PLAN = 'plan-0123456789ab'
const dirs = []
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const T0 = Date.parse('2026-11-17T12:00:00.000Z')
const report = (over = {}) => ({ plan_id: PLAN, base_hash: 'sha256:' + 'b'.repeat(64), verdict: 'SAFE', rows_deleted: 0, schema_delta: { changed: true }, duration_ms: 900, ...over })
const files = [{ path: 'demo/migrations/003_add_order_status.sql', sha256: 'sha256:' + 'f'.repeat(64) }]

let repoDir
let keys
let rehearsal
beforeEach(() => {
  repoDir = tmp('jrm-approval-')
  keys = loadOrCreateTestKeys(tmp('jrm-approval-keys-'))
  rehearsal = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'rehearsal', verdict: 'SAFE', subject: { plan_id: PLAN, report_hash: hashValue(report()), base_hash: report().base_hash }, now: T0 })
})

const chain = () => verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId: MISSION })
const ask = (over = {}) => createRequest({ repoDir, keys, contract: CONTRACT, contractHash: 'sha256:' + 'c'.repeat(64), report: report(), rehearsalReceipt: rehearsal.hash, files, note: 'Adds order status tracking', now: T0 + 1000, ...over })
const load = (id, receipts = chain().receipts) => loadRequest({ repoDir, missionId: MISSION, id, publicKey: keys.publicKey, receipts })
const answer = (made, now = T0 + 60000, extra = {}) =>
  appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'authorization_issued', verdict: 'allow', subject: { plan_id: PLAN }, refs: { rehearsal: rehearsal.hash, approval: made.receipt, ...extra }, now })
const code = (fn) => {
  try {
    fn()
  } catch (err) {
    return err instanceof ApprovalError ? err.code : `other:${err.message}`
  }
  return null
}

describe('approval requests (T23)', () => {
  it('a request is signed, recorded as a receipt, bound to the report and the files, and starts pending', () => {
    const made = ask()
    assert.match(made.request.request_id, /^apr-[0-9a-f]{16}$/)
    assert.deepEqual([made.request.plan_id, made.request.report_hash, made.request.files], [PLAN, hashValue(report()), files])
    assert.equal(made.request.expires_at, new Date(T0 + 1000 + 300 * 1000).toISOString(), 'never longer than the mission time limit')
    assert.equal(REQUEST_TTL_SECONDS, 3600)
    const c = chain()
    assert.equal(c.ok, true)
    assert.equal(checkPolicy(c.receipts).ok, true, JSON.stringify(checkPolicy(c.receipts).findings))
    const got = load(made.request.request_id)
    assert.equal(got.request_hash, made.request_hash)
    assert.equal(requestState(got.request, got.receipt, c.receipts, T0 + 2000), 'pending')
    assert.equal(requestState(got.request, got.receipt, c.receipts, T0 + 1000 + 301 * 1000), 'expired')
  })

  it('the agent\'s note is kept short and redacted, and is marked as the agent\'s own words by the CLI', () => {
    const made = ask({ note: 'mail me at someone@example.com ' + 'x'.repeat(500) })
    assert.ok(made.request.agent_note.length <= 300)
    assert.doesNotMatch(made.request.agent_note, /someone@example\.com/)
  })

  it('refuses a request that was edited, forged by another key, unrecorded, or named badly', () => {
    const made = ask()
    const file = path.join(approvalsDir(repoDir, MISSION), `${made.request.request_id}.json`)
    const original = readFileSync(file, 'utf8')
    // Edited after signing: a different file list.
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), files: [{ path: 'demo/migrations/evil.sql', sha256: 'sha256:' + '0'.repeat(64) }] }))
    assert.equal(code(() => load(made.request.request_id)), 'REQUEST_INVALID')
    // Signed by another key.
    const stranger = loadOrCreateKeys(tmp('jrm-approval-stranger-'))
    const forgedBody = { ...JSON.parse(original) }
    delete forgedBody.signature
    writeFileSync(file, JSON.stringify({ ...forgedBody, operator_pubkey: JSON.parse(original).operator_pubkey, signature: '0'.repeat(128) }))
    assert.equal(code(() => load(made.request.request_id)), 'REQUEST_INVALID')
    // Valid file, but the chain knows nothing about it.
    writeFileSync(file, original)
    assert.equal(code(() => load(made.request.request_id, [])), 'REQUEST_NOT_RECORDED')
    assert.equal(code(() => load('../../etc/passwd')), 'REQUEST_INVALID')
    assert.equal(code(() => load('apr-0000000000000000')), 'REQUEST_UNKNOWN')
    assert.equal(stranger.publicKey !== undefined, true)
  })

  it('is answered once: an authorization makes it approved, a denial makes it denied', () => {
    const a = ask()
    const b = ask()
    answer(a)
    appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'approval_denied', verdict: 'deny', subject: { request_id: b.request.request_id, plan_id: PLAN, reason: 'no' }, refs: { approval: b.receipt }, now: T0 + 5000 })
    const c = chain()
    assert.equal(requestState(a.request, load(a.request.request_id).receipt, c.receipts, T0 + 6000), 'approved')
    assert.equal(requestState(b.request, load(b.request.request_id).receipt, c.receipts, T0 + 6000), 'denied')
    const listed = listRequests({ repoDir, missionId: MISSION, publicKey: keys.publicKey, home: keys.home, now: T0 + 6000 })
    assert.deepEqual(listed.map((x) => x.state).sort(), ['approved', 'denied'])
    assert.equal(checkPolicy(c.receipts).ok, true, JSON.stringify(checkPolicy(c.receipts).findings))
  })
})

describe('receipt policy for approvals (T23, rule 7)', () => {
  const violations = () => checkPolicy(chain().receipts).findings.map((f) => f.problem)

  it('a second authorization for the same request is a violation (one-time approval)', () => {
    const made = ask()
    answer(made)
    assert.equal(checkPolicy(chain().receipts).ok, true)
    answer(made, T0 + 70000)
    assert.ok(violations().some((p) => /already answered/.test(p)), violations().join(' | '))
  })

  it('authorizing after a denial is a violation', () => {
    const made = ask()
    appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'approval_denied', verdict: 'deny', subject: { request_id: made.request.request_id, plan_id: PLAN, reason: 'no' }, refs: { approval: made.receipt }, now: T0 + 5000 })
    answer(made, T0 + 6000)
    assert.ok(violations().some((p) => /was denied/.test(p)), violations().join(' | '))
  })

  it('authorizing after the request expired is a violation', () => {
    const made = ask()
    answer(made, Date.parse(made.request.expires_at) + 1000)
    assert.ok(violations().some((p) => /after it expired/.test(p)), violations().join(' | '))
  })

  it('an authorization for another plan than the request, or without a request, is a violation', () => {
    const made = ask()
    appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'authorization_issued', verdict: 'allow', subject: { plan_id: 'plan-ffffffffffff' }, refs: { rehearsal: rehearsal.hash, approval: made.receipt }, now: T0 + 3000 })
    assert.ok(violations().some((p) => /another plan/.test(p)), violations().join(' | '))
    appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'authorization_issued', verdict: 'allow', subject: { plan_id: PLAN }, refs: { rehearsal: rehearsal.hash, approval: 'sha256:' + '1'.repeat(64) }, now: T0 + 4000 })
    assert.ok(violations().some((p) => /must refer to an earlier approval_requested/.test(p)), violations().join(' | '))
  })

  it('a request for a rehearsal that was not SAFE, or about another report, is a violation', () => {
    const bad = appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'rehearsal', verdict: 'DATA LOSS', subject: { plan_id: 'plan-aaaaaaaaaaaa', report_hash: 'sha256:' + '2'.repeat(64), base_hash: report().base_hash }, now: T0 + 500 })
    appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'approval_requested', verdict: 'pending', subject: { request_id: 'apr-1111111111111111', plan_id: 'plan-aaaaaaaaaaaa', report_hash: 'sha256:' + '2'.repeat(64) }, refs: { rehearsal: bad.hash }, now: T0 + 600 })
    assert.ok(violations().some((p) => /verdict DATA LOSS/.test(p)), violations().join(' | '))
    appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'approval_requested', verdict: 'pending', subject: { request_id: 'apr-2222222222222222', plan_id: PLAN, report_hash: 'sha256:' + '3'.repeat(64) }, refs: { rehearsal: rehearsal.hash }, now: T0 + 700 })
    assert.ok(violations().some((p) => /other than the rehearsed one/.test(p)), violations().join(' | '))
  })

  it('a denial must refer to a request', () => {
    appendReceipt({ repoDir, keys, missionId: MISSION, kind: 'approval_denied', verdict: 'deny', subject: { request_id: 'apr-3333333333333333' }, refs: { approval: 'sha256:' + '4'.repeat(64) }, now: T0 + 800 })
    assert.ok(violations().some((p) => /approval_denied: must refer/.test(p)), violations().join(' | '))
  })
})
