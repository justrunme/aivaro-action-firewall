/**
 * T19 judge scenario, report and environment rules, without Docker. The real run
 * against Postgres is in test/demo-judge.test.js.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { runScenario, STEPS } from '../src/judge/scenario.js'
import { BUDGET_MS, buildReport } from '../src/judge/report.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JudgeEnvironmentError, childEnv, createBackend, currentEndpoint, isLocalEndpoint, projectNames } from '../src/judge/env.js'
import { down, dump, imageDigests, psql, up } from '../src/rehearsal/compose.js'
import { EXIT } from '../src/cli/codes.js'
import { main } from '../src/cli/index.js'

/** A scripted stand-in for the CLI: behaves like a correct JustRunMe, with hooks to break one step. */
function fakeBackend({ override = {}, verifierAcceptsAnything = false } = {}) {
  const state = { kind: null, migrated: false, tampered: false, calls: [] }
  const db = () => ({
    schema_hash: state.migrated ? 'sha256:h2' : 'sha256:h1',
    tables: { orders: { rows: 12, checksum: 'a' }, patches: { rows: 3, checksum: 'b' } },
    columns: { orders: ['id integer not null', ...(state.migrated ? ['status text not null'] : [])] },
  })
  const dangerous = () => state.kind === 'dangerous'
  const answers = {
    keys: () => ({ exit: 0, out: { result: { public_key: 'ab'.repeat(16) } } }),
    rehearse: () =>
      dangerous()
        ? { exit: 10, out: { result: { verdict: 'DATA LOSS', rows_lost: { orders: 1, patches: 0 }, plan_id: 'plan-d', base_hash: 'base-1' } } }
        : { exit: 0, out: { result: { verdict: 'SAFE', rows_lost: { orders: 0, patches: 0 }, plan_id: 'plan-s', base_hash: 'base-1' } } },
    authorize: () =>
      dangerous()
        ? { exit: 21, out: { error: { code: 'DATA_LOSS', message: 'rehearsal measured data loss' } } }
        : { exit: 0, out: { result: { plan_id: 'plan-s', selection: { mode: 'selected' } } } },
    compare: () => ({ exit: 0, out: { result: { recommended: 'plan-s', decided_by: 'R15.4.1', removed: [{ plan_id: 'plan-d' }] } } }),
    run: () => {
      state.migrated = true
      return { exit: 0, out: { result: { ok: true, capture_id: 'cap-20261117000000-abcdef', steps: [{}] } } }
    },
    undo: () => {
      state.migrated = false
      return { exit: 0, out: { result: { status: 'RECOVERED', evidence_status: 'recorded', verification: { status: 'PASS' } } } }
    },
    verify: () =>
      state.tampered && !verifierAcceptsAnything
        ? { exit: 30, out: { result: { ok: false, receipts: 9, chain_findings: [{ problem: 'bad line' }], policy_findings: [] } } }
        : { exit: 0, out: { result: { ok: true, receipts: 9, chain_findings: [], policy_findings: [] } } },
    replay: () => ({ exit: 0, out: { result: { ok: true } } }),
  }
  const call = async (args) => {
    state.calls.push(args[0])
    return (override[args[0]] ?? answers[args[0]])(args)
  }
  return {
    state,
    cli: call,
    offlineCli: call,
    measure: async () => db(),
    useMigration: async (kind) => {
      state.kind = kind
    },
    stopStack: async () => {},
    corruptChain: () => {
      state.tampered = true
    },
    restoreChain: () => {
      state.tampered = false
    },
    readReceipts: () => ({ publicKey: 'ab'.repeat(16), receipts: [{ seq: 0, kind: 'rehearsal', verdict: 'DATA LOSS', hash: 'sha256:x' }] }),
  }
}

const report = (scenario, extra = {}) =>
  buildReport({ stepResults: scenario.stepResults, elapsedMs: 30000, imagesCached: true, missionId: 'judge-test', publicKey: scenario.publicKey, receipts: scenario.receipts, offline: scenario.offline, story: scenario.story, ...extra })

describe('Judge scenario (T19)', () => {
  it('passes when every step does what a correct JustRunMe does, in the documented order', async () => {
    const backend = fakeBackend()
    const s = await runScenario(backend)
    assert.deepEqual(s.stepResults.map((r) => r.id), STEPS.map(([id]) => id))
    assert.ok(s.stepResults.every((r) => r.status === 'passed'), JSON.stringify(s.stepResults.filter((r) => r.status !== 'passed')))
    assert.deepEqual(backend.state.calls.slice(0, 7), ['keys', 'rehearse', 'authorize', 'rehearse', 'compare', 'authorize', 'run'])
    assert.equal(s.story.dangerous.verdict, 'DATA LOSS')
    assert.equal(s.story.denied.error, 'DATA_LOSS')
    assert.equal(s.story.selection.recommended, 'plan-s')
    assert.equal(s.story.undo.evidence_status, 'recorded')
    const r = report(s)
    assert.equal(r.judge.status, 'PASS')
    assert.deepEqual([r.counts.steps, r.counts.passed, r.counts.failed, r.counts.skipped], [STEPS.length, STEPS.length, 0, 0])
    assert.deepEqual([r.counts.receipts_verified, r.counts.mismatches, r.counts.policy_violations], [9, 0, 0])
  })

  it('fails and skips the rest when the dangerous plan is NOT denied', async () => {
    const s = await runScenario(fakeBackend({ override: { authorize: () => ({ exit: 0, out: { result: { plan_id: 'plan-d', selection: { mode: 'single' } } } }) } }))
    const by = Object.fromEntries(s.stepResults.map((r) => [r.id, r.status]))
    assert.equal(by.deny, 'failed')
    assert.equal(by.run, 'skipped')
    assert.equal(by.tamper_restored, 'skipped')
    const r = report(s)
    assert.equal(r.judge.status, 'FAIL')
    assert.ok(r.findings.some((f) => f.code === 'STEP_FAILED' && f.step === 'deny'))
    assert.ok(r.findings.some((f) => f.code === 'STEP_SKIPPED'))
  })

  it('fails when the run silently lost rows, even though every exit code is 0', async () => {
    const b = fakeBackend()
    const measure = b.measure
    // The run reports success, but the real database now has one order fewer.
    b.measure = async () => {
      const m = await measure()
      if (b.state.migrated) m.tables.orders.rows -= 1
      return m
    }
    const s = await runScenario(b)
    assert.equal(s.stepResults.find((r) => r.id === 'run').status, 'failed')
    assert.equal(s.stepResults.find((r) => r.id === 'undo').status, 'skipped')
  })

  it('does not accept a verifier that approves a damaged chain', async () => {
    const s = await runScenario(fakeBackend({ verifierAcceptsAnything: true }))
    const t = s.stepResults.find((r) => r.id === 'tamper_detected')
    assert.equal(t.status, 'failed')
    assert.equal(report(s).judge.status, 'FAIL')
  })

  it('fails the report when a backend call outside a step throws, even if every step passed', async () => {
    const b = fakeBackend()
    b.readReceipts = () => {
      throw new Error('cannot read the chain')
    }
    const s = await runScenario(b)
    assert.ok(s.stepResults.every((r) => r.status === 'passed'))
    const r = report(s)
    assert.equal(r.judge.status, 'FAIL')
    assert.deepEqual(r.findings.map((f) => f.code), ['BACKEND_ERROR'])
  })

  it('does not run the offline steps when the containers could not be stopped', async () => {
    const b = fakeBackend()
    b.stopStack = async () => {
      throw new Error('docker compose down failed')
    }
    const s = await runScenario(b)
    assert.equal(s.stepResults.find((r) => r.id === 'offline_verify').status, 'skipped')
    assert.equal(report(s).judge.status, 'FAIL')
  })

  it('fails when the schema changed even though every table kept its rows', async () => {
    const b = fakeBackend()
    const measure = b.measure
    let afterUndo = false
    const cli = b.cli
    b.cli = async (args) => {
      const r = await cli(args)
      if (args[0] === 'undo') afterUndo = true
      return r
    }
    b.measure = async () => ({ ...(await measure()), ...(afterUndo ? { schema_hash: 'sha256:other' } : {}) })
    const s = await runScenario(b)
    assert.equal(s.stepResults.find((r) => r.id === 'undo').status, 'failed')
  })

  it('records a command that throws or prints no JSON as a failed step, not a crash', async () => {
    const thrown = await runScenario(fakeBackend({ override: { compare: () => { throw new Error('boom') } } }))
    assert.equal(thrown.stepResults.find((r) => r.id === 'compare').status, 'failed')
    assert.equal(thrown.stepResults.find((r) => r.id === 'compare').code, 'JUDGE_STEP_ERROR')
    const empty = await runScenario(fakeBackend({ override: { keys: () => ({ exit: 0, out: null }) } }))
    assert.equal(empty.stepResults[0].status, 'failed')
  })
})

describe('Judge report (T19.3)', () => {
  const steps = (n, status = 'passed') => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: 't', status, expected_exit: 0, observed_exit: 0, code: null, checks: [] }))
  const build = (over) => buildReport({ stepResults: steps(3), elapsedMs: 1000, imagesCached: true, missionId: 'judge-x', publicKey: null, receipts: [], offline: { receipts: 9, chain_findings: 0, policy_findings: 0 }, story: {}, ...over })

  it('has the fields R8.4 asks for', () => {
    const r = build({})
    assert.deepEqual(Object.keys(r).sort(), ['counts', 'findings', 'judge', 'limits', 'operator_public_key', 'receipts', 'steps', 'story'])
    assert.deepEqual(Object.keys(r.counts).sort(), ['failed', 'mismatches', 'passed', 'policy_violations', 'receipts_verified', 'skipped', 'steps'])
    assert.ok(['PASS', 'FAIL'].includes(r.judge.status))
  })

  it('enforces the 60 s budget only when the images were already on the machine', () => {
    assert.equal(BUDGET_MS, 60000)
    assert.equal(build({ elapsedMs: BUDGET_MS - 1 }).judge.status, 'PASS')
    const slow = build({ elapsedMs: BUDGET_MS })
    assert.equal(slow.judge.status, 'FAIL')
    assert.equal(slow.findings[0].code, 'OVER_BUDGET')
    const firstRun = build({ elapsedMs: 5 * BUDGET_MS, imagesCached: false })
    assert.equal(firstRun.judge.status, 'PASS')
    assert.equal(firstRun.judge.budget_enforced, false)
    assert.equal(firstRun.judge.within_budget, false, 'the time is still reported honestly')
  })

  it('property: PASS exactly when no step failed or was skipped and the budget holds', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('passed', 'failed', 'skipped'), { maxLength: 15 }), fc.integer({ min: 0, max: 200000 }), fc.boolean(), (list, elapsed, cached) => {
        const stepResults = list.map((status, i) => ({ id: `s${i}`, title: 't', status, expected_exit: 0, observed_exit: 0, code: null, checks: [{ name: 'x', ok: status === 'passed' }] }))
        const r = build({ stepResults, elapsedMs: elapsed, imagesCached: cached })
        const expected = list.every((s) => s === 'passed') && !(cached && elapsed >= BUDGET_MS)
        return (r.judge.status === 'PASS') === expected && r.counts.passed + r.counts.failed + r.counts.skipped === list.length
      })
    )
  })
})

describe('Judge environment (T19.2)', () => {
  it('passes on Docker settings and PATH only; credentials in the caller environment stay behind', () => {
    const env = childEnv(
      { PATH: '/bin', HOME: '/h', DOCKER_HOST: 'unix:///x', AWS_SECRET_ACCESS_KEY: 's', DATABASE_URL: 'postgres://u:p@h/d', PGPASSWORD: 'p', GITHUB_TOKEN: 't', JUSTRUNME_HOME: '/real/keys', JUSTRUNME_GATE: 'on' },
      '/tmp/throwaway'
    )
    assert.deepEqual(Object.keys(env).sort(), ['DOCKER_HOST', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'JUSTRUNME_HOME', 'PATH'])
    assert.equal(env.JUSTRUNME_HOME, '/tmp/throwaway')
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null', 'the caller git configuration is ignored')
    assert.ok(!('GIT_DIR' in childEnv({ GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere' }, '/tmp/x')), 'GIT_DIR cannot redirect git to another repository')
  })

  it('refuses a remote Docker daemon before creating anything', async () => {
    for (const host of ['tcp://10.0.0.5:2375', 'ssh://deploy@prod.example']) {
      await assert.rejects(createBackend({ env: { PATH: '/bin', DOCKER_HOST: host } }), (err) => err instanceof JudgeEnvironmentError && err.code === 'REMOTE_DOCKER')
    }
  })

  it('accepts only a local socket as the Docker endpoint and reads the active context from the CLI listing', () => {
    for (const ok of ['unix:///var/run/docker.sock', 'unix:///run/user/1000/docker.sock', 'npipe:////./pipe/docker_engine']) assert.equal(isLocalEndpoint(ok), true, ok)
    for (const bad of ['tcp://10.0.0.5:2376', 'ssh://deploy@prod', 'http://localhost:2375', 'unix://', '', null, undefined]) assert.equal(isLocalEndpoint(bad), false, String(bad))
    assert.equal(currentEndpoint('false\ttcp://prod:2376\ntrue\tunix:///var/run/docker.sock\n'), 'unix:///var/run/docker.sock')
    assert.equal(currentEndpoint('true\ttcp://prod:2376\nfalse\tunix:///var/run/docker.sock\n'), 'tcp://prod:2376')
    assert.equal(currentEndpoint(''), null)
    assert.equal(currentEndpoint('true\ta\ntrue\tb\n'), null, 'two current contexts is ambiguous: refuse')
  })

  it('refuses a remote context chosen by the Docker configuration, before creating anything', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'jrm-fake-docker-'))
    try {
      writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\ncase "$1" in context) printf "false\\tunix:///var/run/docker.sock\\ntrue\\tssh://deploy@prod.example\\n";; esac\nexit 0\n', { mode: 0o755 })
      await assert.rejects(createBackend({ env: { PATH: `${bin}:/usr/bin:/bin` } }), (err) => err instanceof JudgeEnvironmentError && err.code === 'REMOTE_DOCKER')
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('runs every docker call of a target with the target environment, not the caller one', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jrm-fake-docker-'))
    const log = path.join(dir, 'calls.log')
    const before = process.env.DOCKER_HOST
    process.env.DOCKER_HOST = 'tcp://elsewhere.example:2376'
    try {
      writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\necho "$DOCKER_HOST" >> "$FAKE_LOG"\ncase "$*" in *"ps -q"*) echo abcdef123456;; esac\nexit 0\n', { mode: 0o755 })
      const target = { project: 'jrm-pin-test', composeFile: '/x/docker-compose.yml', dbService: 'db', dbUser: 'u', dbName: 'd', env: { PATH: `${dir}:/usr/bin:/bin`, DOCKER_HOST: 'unix:///pinned.sock', FAKE_LOG: log } }
      await up(target, ['db'])
      await psql(target, { sql: 'select 1' })
      await dump(target)
      await imageDigests(target)
      await down(target)
      const hosts = readFileSync(log, 'utf8').split('\n').filter(Boolean)
      assert.ok(hosts.length >= 6, `only ${hosts.length} docker calls seen`)
      assert.deepEqual([...new Set(hosts)], ['unix:///pinned.sock'])
    } finally {
      if (before === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = before
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names what a run created, so that an early exit can remove the rehearsal copies too', () => {
    assert.deepEqual(projectNames('ab12cd34'), { stack: 'jrm-judge-ab12cd34', rehearsalPrefix: 'jrm-reh-judgeab12cd34-' })
    // The rehearsal engine names its copies jrm-reh-<mission id, lower case, letters and digits only>-<hex>.
    const mission = 'judge-ab12cd34'
    assert.ok(`jrm-reh-${mission.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}-0f0f0f0f`.startsWith(projectNames('ab12cd34').rehearsalPrefix))
  })
})

describe('judge command line', () => {
  it('takes no --repo and no --mission, and has its own exit codes', async () => {
    for (const extra of [['--repo', '.'], ['--mission', 'abc-123']]) {
      const r = await main(['judge', ...extra])
      assert.equal(r.exit, EXIT.USAGE)
      assert.equal(r.output.error.code, 'USAGE')
    }
    assert.deepEqual([EXIT.JUDGE_FAILED, EXIT.JUDGE_ENVIRONMENT], [40, 41])
  })
})
