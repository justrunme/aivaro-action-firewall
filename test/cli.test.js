/**
 * T18 CLI: exit codes, JSON output, refusals, privacy, no colour. Runs the real
 * entry point in a child process. Commands that need Docker (rehearse, a real
 * authorize/run/undo) are covered end to end in test/demo-cli.test.js.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { loadOrCreateKeys, publicKeyHex, signValue } from '../src/receipts/keys.js'
import { TEST_PASSPHRASE, loadOrCreateTestKeys } from './support/keys.js'
import { appendReceipt, chainPath } from '../src/receipts/chain.js'
import { hashValue } from '../src/util/canonical.js'
import { baseHash } from '../src/fidelity/gate.js'
import { planId, reportPath } from '../src/rehearsal/engine.js'
import { comparisonPath } from '../src/compare/select.js'
import { EXIT } from '../src/cli/codes.js'
import { printable, scrubPaths } from '../src/cli/index.js'
import { errorSummary } from '../src/privacy/redact.js'
import { appendEmergencyRecord, emergencyJournalPath, verifyEmergencyJournal } from '../src/undo/emergency.js'

const CLI = new URL('../src/cli/index.js', import.meta.url).pathname
const MISSION = 'mission-cli-test'
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}

const CONTRACT = {
  id: MISSION,
  objective: 'Exercise the CLI',
  allowed_paths: ['demo/migrations/'],
  protected_tables: ['orders', 'patches'],
  time_limit_seconds: 300,
  irreversible_actions: [],
  plan: [{ id: 'migrate', tool: 'sql_migration', args: ['demo/migrations/003.sql'], reversibility: true }],
  resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] },
}
const TARGET = { project: 'jrm-cli-test', compose_file: 'demo/docker-compose.yml', db_service: 'db', db_user: 'demo_user', db_name: 'pumpkin_patch' }

function workspace({ contract = CONTRACT, target = TARGET } = {}) {
  const dir = tmp('jrm-cli-')
  mkdirSync(path.join(dir, 'demo/migrations'), { recursive: true })
  writeFileSync(path.join(dir, 'demo/docker-compose.yml'), 'services: {}\n')
  if (contract) writeFileSync(path.join(dir, 'justrunme.mission.yaml'), typeof contract === 'string' ? contract : stringify(contract))
  if (target) writeFileSync(path.join(dir, 'justrunme.target.json'), typeof target === 'string' ? target : JSON.stringify(target))
  return dir
}

/** @returns {{ code: number, out: any, raw: string }} */
function cli(dir, args, { home } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', dir], { encoding: 'utf8', env: { ...process.env, JUSTRUNME_HOME: home ?? keysHome, JUSTRUNME_APPROVER_PASSPHRASE: TEST_PASSPHRASE, NO_COLOR: '' } })
  let out = null
  try {
    out = JSON.parse(r.stdout)
  } catch {
    out = null
  }
  return { code: r.status, out, raw: r.stdout + r.stderr }
}

const keysHome = tmp('jrm-cli-keys-')
const keys = loadOrCreateTestKeys(keysHome)

const BASE = {
  target: { project: 'jrm-cli-test', db_service: 'db', db_name: 'pumpkin_patch', compose_file_hash: 'sha256:' + 'c'.repeat(64) },
  git_head: 'a'.repeat(40),
  tree_hash: 'b'.repeat(40),
  images: { db: 'sha256:' + 'd'.repeat(64) },
  postgres: { pumpkin_patch: { schema_hash: 'sha256:' + 'e'.repeat(64), tables: { orders: { rows: 3, checksum: 'x1' } } } },
}
const pid = (n) => 'plan-' + String(n).padStart(12, '0')

/** Signed report plus rehearsal receipt, the way src/rehearsal/engine.js stores them. */
function rehearsed(dir, { plan, verdict = 'SAFE', duration = 1000, base = BASE }) {
  const lost = verdict === 'DATA LOSS' ? 1 : 0
  const body = {
    version: 1,
    mission_id: MISSION,
    plan_id: plan,
    contract_hash: 'sha256:' + '0'.repeat(64),
    base_hash: baseHash({ base }),
    fingerprint: { base, plan: { plan_hash: plan } },
    duration_ms: duration,
    irreversible_actions: [],
    all_reversible: true,
    conditions: { protected_tables: ['orders', 'patches'], impact_thresholds: {}, db_name: 'pumpkin_patch', tests_measured: false },
    verdict,
    evidence: [],
    tables: {
      orders: { rows_before: 3, rows_after: 3 - lost, rows_lost: lost, content_changed: false, protected: true },
      patches: { rows_before: 4, rows_after: 4, rows_lost: 0, content_changed: false, protected: true },
    },
    operator_pubkey: publicKeyHex(keys.publicKey),
  }
  const report = { ...body, signature: signValue(keys.privateKey, body) }
  mkdirSync(path.dirname(reportPath(dir, MISSION, plan)), { recursive: true })
  writeFileSync(reportPath(dir, MISSION, plan), JSON.stringify(report))
  appendReceipt({ repoDir: dir, keys, missionId: MISSION, kind: 'rehearsal', verdict, subject: { plan_id: plan, report_hash: hashValue(report), base_hash: report.base_hash, duration_ms: duration, evidence: [] } })
  return report
}

describe('T18 CLI: usage and configuration', () => {
  it('usage errors exit 2 with JSON; --help exits 0', () => {
    const dir = workspace()
    for (const args of [[], ['frobnicate'], ['status', '--no-such-flag'], ['keys'], ['lock', 'smash'], ['status', '--mission', '../x']]) {
      const r = cli(dir, args)
      assert.equal(r.code, EXIT.USAGE, JSON.stringify(args))
      assert.equal(r.out.ok, false)
      assert.equal(r.out.error.code, 'USAGE')
    }
    assert.equal(cli(dir, ['--help']).code, EXIT.OK)
  })

  it('keys init creates the operator key once and prints only the public key', () => {
    const home = tmp('jrm-cli-newkeys-')
    const dir = workspace()
    const first = cli(dir, ['keys', 'init'], { home })
    assert.equal(first.code, EXIT.OK)
    assert.equal(first.out.result.created, true)
    assert.match(first.out.result.public_key, /^[0-9a-f]{64}$/)
    assert.equal(cli(dir, ['keys', 'init'], { home }).out.result.created, false)
    assert.ok(!first.raw.includes(home), 'no key directory path in the output')
    assert.ok(!first.raw.includes('PRIVATE KEY'))
  })

  it('no command creates a key implicitly: missing key exits 3 NO_OPERATOR_KEY', () => {
    const home = tmp('jrm-cli-nokey-')
    const dir = workspace()
    for (const args of [['verify'], ['authorize'], ['compare'], ['status']]) {
      const r = cli(dir, args, { home })
      assert.equal(r.code, EXIT.CONFIG, JSON.stringify(args))
      assert.equal(r.out.error.code, 'NO_OPERATOR_KEY')
    }
    assert.equal(cli(workspace(), ['status'], { home }).code, EXIT.CONFIG, 'still no key afterwards')
  })

  it('a missing or invalid contract or target exits 3 and names the problem', () => {
    assert.equal(cli(workspace({ contract: null }), ['authorize']).out.error.code, 'NO_CONTRACT')
    const bad = cli(workspace({ contract: 'id: x\n' }), ['authorize'])
    assert.equal(bad.code, EXIT.CONFIG)
    assert.equal(bad.out.error.code, 'CONTRACT_INVALID')
    assert.ok(Array.isArray(bad.out.error.detail))
    assert.equal(cli(workspace({ target: null }), ['authorize']).out.error.code, 'NO_TARGET')
    const badHealth = [{ service: 'app' }, { service: 'app', url: 'https://app/health' }, { service: 'app', url: 'http://app:3000/health.json' }, { service: 'app; rm', url: 'http://app/health' }]
    for (const target of ['{not json', { ...TARGET, extra: 1 }, { ...TARGET, compose_file: '/etc/compose.yml' }, { ...TARGET, compose_file: '../x.yml' }, { ...TARGET, project: 'Bad Name!' }, ...badHealth.map((health) => ({ ...TARGET, health }))]) {
      const r = cli(workspace({ target }), ['authorize'])
      assert.equal(r.code, EXIT.CONFIG, JSON.stringify(target))
      assert.equal(r.out.error.code, 'TARGET_INVALID')
    }
  })
})

describe('T18 CLI: refusals reach CI as distinct exit codes', () => {
  it('authorize without a rehearsal exits 21, run without an authorization exits 22, both recorded', () => {
    const dir = workspace()
    const a = cli(dir, ['authorize'])
    assert.equal(a.code, EXIT.AUTHORIZATION_REFUSED)
    assert.equal(a.out.error.code, 'NO_REHEARSAL')
    const r = cli(dir, ['run'])
    assert.equal(r.code, EXIT.RUN_REFUSED)
    assert.equal(r.out.error.code, 'NO_AUTHORIZATION')
    const v = cli(dir, ['verify'])
    assert.equal(v.code, EXIT.OK, JSON.stringify(v.out))
    assert.equal(v.out.result.receipts, 2)
  })

  it('undo: a malformed capture id exits 2, an unknown capture exits 23', () => {
    const dir = workspace()
    assert.equal(cli(dir, ['undo', '../../etc']).code, EXIT.USAGE)
    const r = cli(dir, ['undo', 'cap-20261117000000-abcdef'])
    assert.equal(r.code, EXIT.UNDO_REFUSED)
    assert.equal(r.out.error.code, 'CAPTURE_INVALID')
    assert.equal(cli(dir, ['undo', 'cap-20261117000000-abcdef', '--resource', 'email']).out.error.code, 'UNSUPPORTED_RESOURCE')
  })
})

describe('T18 CLI: compare, verify, replay', () => {
  it('compare without ids takes every plan on the latest base, selects by the rule, and verify and replay pass', () => {
    const dir = workspace()
    rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS', duration: 10 })
    rehearsed(dir, { plan: pid(2), duration: 900 })
    rehearsed(dir, { plan: pid(3), duration: 400 })
    const c = cli(dir, ['compare'])
    assert.equal(c.code, EXIT.OK, JSON.stringify(c.out))
    assert.equal(c.out.result.recommended, pid(3))
    assert.equal(c.out.result.decided_by, 'R15.4.4')
    assert.deepEqual(c.out.result.plans.map((p) => p.plan_id), [pid(1), pid(2), pid(3)])
    assert.equal(cli(dir, ['verify']).code, EXIT.OK)
    const rp = cli(dir, ['replay'])
    assert.equal(rp.code, EXIT.OK)
    assert.equal(rp.out.result.recommended, pid(3))
    assert.equal(rp.out.result.reports_rechecked, 3)
  })

  it('no surviving plan exits 12; different bases exit 20 BASE_MISMATCH', () => {
    const dir = workspace()
    rehearsed(dir, { plan: pid(1), verdict: 'DATA LOSS' })
    rehearsed(dir, { plan: pid(2), verdict: 'FAILED' })
    const none = cli(dir, ['compare', pid(1), pid(2)])
    assert.equal(none.code, EXIT.NO_PLAN_SELECTED)
    assert.equal(none.out.result.recommended, null)
    const other = structuredClone(BASE)
    other.postgres.pumpkin_patch.tables.orders.rows = 4
    rehearsed(dir, { plan: pid(3), base: other })
    const mismatch = cli(dir, ['compare', pid(2), pid(3)])
    assert.equal(mismatch.code, EXIT.COMPARISON_REFUSED)
    assert.equal(mismatch.out.error.code, 'BASE_MISMATCH')
    assert.ok(mismatch.out.error.detail[0].diffs.some((d) => d.component === 'base.postgres.pumpkin_patch.tables.orders.rows'))
  })

  it('verify and replay exit 30 on a tampered chain or comparison file; replay without a selection exits 2', () => {
    const dir = workspace()
    rehearsed(dir, { plan: pid(1) })
    assert.equal(cli(dir, ['replay']).out.error.code, 'NOTHING_TO_REPLAY')
    rehearsed(dir, { plan: pid(2), duration: 5 })
    const c = cli(dir, ['compare'])
    const file = comparisonPath(dir, MISSION, c.out.result.comparison_hash)
    writeFileSync(file, readFileSync(file, 'utf8').replace(`"recommended": "${pid(2)}"`, `"recommended": "${pid(1)}"`))
    assert.equal(cli(dir, ['replay']).code, EXIT.INTEGRITY)
    const v = cli(dir, ['verify'])
    assert.equal(v.code, EXIT.INTEGRITY)
    assert.equal(v.out.result.selections[0].ok, false)
    const bytes = readFileSync(chainPath(dir, MISSION))
    bytes[30] = bytes[30] ^ 1
    writeFileSync(chainPath(dir, MISSION), bytes)
    const broken = cli(dir, ['verify'])
    assert.equal(broken.code, EXIT.INTEGRITY)
    assert.ok(broken.out.result.chain_findings.length > 0)
  })

  it('status and receipt read the chain; an out-of-range seq exits 2', () => {
    const dir = workspace()
    rehearsed(dir, { plan: pid(1) })
    const s = cli(dir, ['status'])
    assert.equal(s.code, EXIT.OK)
    assert.equal(s.out.result.chain_ok, true)
    assert.deepEqual(s.out.result.receipts, { rehearsal: 1 })
    assert.equal(s.out.result.authorization, null)
    const r = cli(dir, ['receipt', '--seq', '0'])
    assert.equal(r.code, EXIT.OK)
    assert.equal(r.out.result.receipt.kind, 'rehearsal')
    assert.match(r.out.result.hash, /^sha256:/)
    assert.equal(cli(dir, ['receipt', '--seq', '7']).code, EXIT.USAGE)
  })
})

describe('T18 CLI: maintenance', () => {
  it('lock inspect and recover by exact hash; a wrong hash exits 24; reanchor with nothing to do exits 24', () => {
    const dir = workspace()
    rehearsed(dir, { plan: pid(1) })
    writeFileSync(chainPath(dir, MISSION) + '.lock', 'garbage\n')
    const seen = cli(dir, ['lock', 'inspect'])
    assert.equal(seen.code, EXIT.OK)
    assert.equal(seen.out.result.owner, 'unknown')
    assert.equal(cli(dir, ['lock', 'recover', '--sha256', 'sha256:' + '0'.repeat(64), '--reason', 'garbage lock after crash']).code, EXIT.MAINTENANCE_REFUSED)
    const ok = cli(dir, ['lock', 'recover', '--sha256', seen.out.result.sha256, '--reason', 'garbage lock after crash'])
    assert.equal(ok.code, EXIT.OK, JSON.stringify(ok.out))
    assert.equal(cli(dir, ['verify']).code, EXIT.OK)
    const re = cli(dir, ['reanchor', '--reason', 'nothing is wrong here'])
    assert.equal(re.code, EXIT.MAINTENANCE_REFUSED)
    assert.equal(re.out.error.code, 'REANCHOR_REFUSED')
  })
})

describe('T18 CLI: output', () => {
  it('never prints colour codes, home paths or the key directory, in JSON or --text', () => {
    const dir = workspace()
    rehearsed(dir, { plan: pid(1) })
    rehearsed(dir, { plan: pid(2), duration: 5 })
    for (const args of [['compare'], ['status'], ['verify', '--text'], ['receipt', '--text'], ['authorize', '--text'], ['frobnicate', '--text']]) {
      const r = cli(dir, args)
      assert.ok(!r.raw.includes('\x1b'), `ANSI in ${args}`)
      assert.ok(!r.raw.includes(os.homedir()), `home path in ${args}`)
      assert.ok(!r.raw.includes(keysHome), `key directory in ${args}`)
    }
    const t = cli(dir, ['status', '--text'])
    assert.equal(t.out, null, '--text is not JSON')
    assert.match(t.raw, /^status: ok \(exit 0\)/)
  })
})

// PR 10 review: no exit 1 where a refusal is meant, nothing unrecorded reported as success, nothing leaked.
describe('PR 10 review: refusals keep their code when the chain cannot record them', () => {
  const tamper = (dir) => {
    const bytes = readFileSync(chainPath(dir, MISSION))
    bytes[30] = bytes[30] ^ 1
    writeFileSync(chainPath(dir, MISSION), bytes)
  }

  it('a plan whose steps invoke JustRunMe is refused before rehearsal runs anything (exit 25), and nothing is recorded', () => {
    const dir = workspace({ contract: { ...CONTRACT, plan: [{ id: 'sneaky', tool: 'shell', args: ['node', 'src/cli/index.js', 'compare'], reversibility: true }] } })
    const r = cli(dir, ['rehearse'])
    assert.equal(r.code, EXIT.REHEARSAL_REFUSED, JSON.stringify(r.out))
    assert.equal(r.out.error.code, 'SELF_REFERENCE')
    assert.match(r.out.error.message, /nothing was executed/)
    assert.equal(cli(dir, ['verify']).out.error.code, 'NO_RECEIPTS')
  })

  it('on a chain that does not verify: rehearse 25, compare 20, authorize 21 CHAIN_INVALID, run 22 (recorded: false), status 30', () => {
    const dir = workspace()
    rehearsed(dir, { plan: planId(CONTRACT) })
    rehearsed(dir, { plan: pid(9) })
    tamper(dir)
    const reh = cli(dir, ['rehearse'])
    assert.deepEqual([reh.code, reh.out.error.code], [EXIT.REHEARSAL_REFUSED, 'CHAIN_INVALID'])
    const cmp = cli(dir, ['compare'])
    assert.deepEqual([cmp.code, cmp.out.error.code], [EXIT.COMPARISON_REFUSED, 'CHAIN_INVALID'])
    const auth = cli(dir, ['authorize'])
    assert.deepEqual([auth.code, auth.out.error.code], [EXIT.AUTHORIZATION_REFUSED, 'CHAIN_INVALID'])
    assert.equal(auth.out.error.detail.recorded, false)
    const run = cli(dir, ['run'])
    assert.deepEqual([run.code, run.out.error.code], [EXIT.RUN_REFUSED, 'NO_AUTHORIZATION'])
    assert.equal(run.out.error.detail.recorded, false)
    assert.equal(cli(dir, ['status']).code, EXIT.INTEGRITY)
  })

  it('a lock with an unknown owner is reported at once as exit 31 by every command that writes receipts', () => {
    const dir = workspace()
    rehearsed(dir, { plan: pid(1) })
    rehearsed(dir, { plan: pid(2) })
    writeFileSync(chainPath(dir, MISSION) + '.lock', '')
    for (const args of [['rehearse'], ['compare'], ['authorize'], ['run'], ['undo', 'cap-20261117000000-abcdef']]) {
      const started = Date.now()
      const r = cli(dir, args)
      assert.deepEqual([r.code, r.out.error.code], [EXIT.CHAIN_LOCKED, 'CHAIN_LOCKED'], JSON.stringify(args))
      assert.ok(Date.now() - started < 5000, 'no waiting for the lock timeout')
    }
  })
})

describe('PR 10 review: status, verify and replay report only what checks out', () => {
  it('a forged report and a forged authorization are shown as invalid, never as rehearsed or pending', () => {
    const dir = workspace()
    rehearsed(dir, { plan: pid(1) })
    const otherKeys = loadOrCreateKeys(tmp('jrm-cli-forger-'))
    const body = { mission_id: MISSION, plan_id: planId(CONTRACT), verdict: 'SAFE', operator_pubkey: publicKeyHex(otherKeys.publicKey) }
    mkdirSync(path.dirname(reportPath(dir, MISSION, planId(CONTRACT))), { recursive: true })
    writeFileSync(reportPath(dir, MISSION, planId(CONTRACT)), JSON.stringify({ ...body, signature: signValue(otherKeys.privateKey, body) }))
    const auth = { mission_id: MISSION, plan_id: planId(CONTRACT), expires_at: '2099-01-01T00:00:00.000Z', approver_pubkey: publicKeyHex(otherKeys.publicKey) }
    writeFileSync(path.join(dir, '.justrunme/authorization.json'), JSON.stringify({ ...auth, signature: signValue(otherKeys.privateKey, auth) }))
    const s = cli(dir, ['status'])
    assert.equal(s.code, EXIT.OK)
    assert.equal(s.out.result.rehearsal.valid, false)
    assert.equal(s.out.result.rehearsal.verdict, undefined)
    assert.equal(s.out.result.authorization.valid, false)
    assert.match(s.out.result.authorization.problem, /not signed by the installed approver key/)
  })

  it('verify of an empty or mistyped mission exits 2, not 0; replay --receipt of a non-selection exits 2', () => {
    const dir = workspace()
    assert.equal(cli(dir, ['verify', '--mission', 'mission-typo']).out.error.code, 'NO_RECEIPTS')
    rehearsed(dir, { plan: pid(1) })
    rehearsed(dir, { plan: pid(2), duration: 5 })
    assert.equal(cli(dir, ['compare']).code, EXIT.OK)
    const first = cli(dir, ['receipt', '--seq', '0']).out.result.hash
    const r = cli(dir, ['replay', '--receipt', first])
    assert.deepEqual([r.code, r.out.error.code], [EXIT.USAGE, 'NOT_A_SELECTION'])
  })
})

describe('PR 10 review: output hygiene', () => {
  it('paths that redact() does not know are replaced, longest first', () => {
    const out = scrubPaths({ message: "EACCES: mkdir '/opt/jrm/keys/heads'", nested: ['/srv/repo/.justrunme/x', '/srv/repo2'] }, [['/opt/jrm/keys', '$JUSTRUNME_HOME'], ['/srv/repo', '$REPO'], ['/srv/repo2', '$OTHER']])
    assert.deepEqual(out, { message: "EACCES: mkdir '$JUSTRUNME_HOME/heads'", nested: ['$REPO/.justrunme/x', '$OTHER'] })
  })

  it('--text cannot carry colour codes or fake lines', () => {
    assert.equal(printable('step failed\x1b[32m\nok: true'), 'step failed?[32m?ok: true')
  })

  it('stderr summaries drop Postgres lines that quote row values and mask URL credentials', () => {
    const stderr = [
      'psql:<stdin>:3: ERROR:  null value in column "email" violates not-null constraint',
      'DETAIL:  Failing row contains (3, Alice Smith, null).',
      'CONTEXT:  SQL statement "INSERT INTO customers VALUES (3, \'Alice Smith\')"',
      'could not connect: postgres://demo_user:hunter2@db:5432/pumpkin_patch',
    ].join('\n')
    const s = errorSummary(stderr)
    assert.ok(!s.includes('Alice'), s)
    assert.ok(!s.includes('hunter2'), s)
    assert.match(s, /violates not-null constraint/)
    assert.match(s, /postgres:\/\/\[REDACTED\]@db:5432/)
  })
})

describe('Break-glass recovery (operator decision on PR 10)', () => {
  it('the flag exists only for undo, and needs a reason and the capture id typed again', () => {
    const dir = workspace()
    for (const args of [['verify', '--emergency-recovery'], ['run', '--emergency-recovery'], ['status', '--confirm', 'x']]) {
      const r = cli(dir, args)
      assert.deepEqual([r.code, r.out.error.code], [EXIT.USAGE, 'USAGE'], JSON.stringify(args))
    }
    const cap = 'cap-20261117000000-abcdef'
    assert.equal(cli(dir, ['undo', cap, '--emergency-recovery', '--confirm', cap]).out.error.code, 'EMERGENCY_REASON_REQUIRED')
    assert.equal(cli(dir, ['undo', cap, '--emergency-recovery', '--reason', 'short', '--confirm', cap]).out.error.code, 'EMERGENCY_REASON_REQUIRED')
    assert.equal(cli(dir, ['undo', cap, '--emergency-recovery', '--reason', 'chain damaged after crash', '--confirm', 'cap-20261117000000-ffffff']).out.error.code, 'CONFIRMATION_REQUIRED')
    // A capture that is not operator-signed is refused even in break-glass mode.
    const r = cli(dir, ['undo', cap, '--emergency-recovery', '--reason', 'chain damaged after crash', '--confirm', cap])
    assert.deepEqual([r.code, r.out.error.code], [EXIT.UNDO_REFUSED, 'CAPTURE_INVALID'])
  })

  it('the emergency journal is signed and hash-linked: an edited or removed entry is detected', () => {
    const dir = workspace()
    const home = tmp('jrm-cli-glass-')
    const k = loadOrCreateKeys(home)
    appendEmergencyRecord({ repoDir: dir, keys: k, missionId: MISSION, record: { kind: 'emergency_undo', capture_id: 'cap-1', reason: 'first' } })
    appendEmergencyRecord({ repoDir: dir, keys: k, missionId: MISSION, record: { kind: 'emergency_undo', capture_id: 'cap-2', reason: 'second' } })
    const ok = verifyEmergencyJournal({ home, publicKey: k.publicKey, missionId: MISSION, repoDir: dir })
    assert.equal(ok.ok, true, JSON.stringify(ok.findings))
    assert.deepEqual(ok.entries.map((e) => [e.seq, e.evidence_status]), [[0, 'unverified'], [1, 'unverified']])
    const file = emergencyJournalPath(home, MISSION, dir)
    assert.ok(file.startsWith(home), 'kept with the operator key, outside the workspace')
    const [first, second] = readFileSync(file, 'utf8').trim().split('\n')
    writeFileSync(file, first.replace('first', 'FIRST') + '\n' + second + '\n')
    assert.equal(verifyEmergencyJournal({ home, publicKey: k.publicKey, missionId: MISSION, repoDir: dir }).ok, false)
    writeFileSync(file, second + '\n')
    const cut = verifyEmergencyJournal({ home, publicKey: k.publicKey, missionId: MISSION, repoDir: dir })
    assert.ok(cut.findings.some((f) => /sequence gap|previous-hash/.test(f)))
  })
})
