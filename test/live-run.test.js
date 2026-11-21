/**
 * scripts/live-run.mjs (the live Kiro check) and scripts/lib/live-state.js.
 *
 * The behavioural tests run the real script with stand-in `docker` and `kiro-cli` executables first
 * on PATH and a test-only temp directory (TMPDIR), so setup, the Kiro turns and down run end to end
 * without Docker or Kiro. The stand-ins record every call; the tests check what was actually run,
 * with which environment, and what is left on disk.
 *
 * Limits: the kiro-cli stand-in runs the workspace hook itself with an event it builds, so Kiro's own
 * event shape and its shell handling of the hook command are covered only by the live runs
 * (docs/agent-runs/2026-11-20-*.md). That `run_mission` refuses before an approval is tested against
 * real Postgres in test/demo-approval.test.js; here the stand-in shows that the agent's tools cannot
 * get an approval: every way it tries is denied by the real hook, and none leaves an authorization.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { allowEnv, ENV_ALLOW, hookCommand, MARKER, ownedState, writeMarker } from '../scripts/lib/live-state.js'

const SCRIPT = fileURLToPath(new URL('../scripts/live-run.mjs', import.meta.url))
const tmps = []
const SAFE_TMP = realpathSync('/tmp') // independent of inherited TMPDIR (which may contain spaces)
const tmp = (p, base = SAFE_TMP) => {
  const d = realpathSync(mkdtempSync(path.join(base, p)))
  tmps.push(d)
  return d
}
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

/** Stand-ins for docker and kiro-cli; their log paths are written into the scripts (the script passes an allowlisted environment). */
function stubs() {
  const dir = tmp('jrm-liverun-bin-')
  const dockerLog = path.join(dir, 'docker.jsonl')
  const kiroLog = path.join(dir, 'kiro.jsonl')
  writeFileSync(path.join(dir, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${dockerLog}'
case " $* " in
  *" up "*) [ -f '${dir}/fail-up' ] && exit 1 ;;
  *" down "*) [ -f '${dir}/fail-down' ] && { echo 'stub: down failed' >&2; exit 1; } ;;
  *" ps -q "*) echo abcdef123456 ;;
  *" exec "*) cat > /dev/null; [ -f '${dir}/fail-exec' ] && exit 1 ;;
esac
exit 0
`)
  // The kiro-cli stand-in calls the workspace hook the way Kiro does (event JSON on stdin, exit 2 blocks)
  // and carries out a call only when the hook lets it through.
  writeFileSync(path.join(dir, 'kiro-cli'), `#!${process.execPath}
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2)
const record = { argv, cwd: process.cwd(), env: process.env, hook: [] }
const done = () => fs.appendFileSync(${JSON.stringify(kiroLog)}, JSON.stringify(record) + '\\n')
if (argv[0] === '--version') { done(); console.log('kiro-cli 0.0.0-stub'); process.exit(0) }
const hookFile = JSON.parse(fs.readFileSync('.kiro/hooks/pretooluse.json', 'utf8')).hooks[0].action.command.replace(/^node /, '')
const call = (tool_name, tool_input) => {
  const r = spawnSync(process.execPath, [hookFile], { input: JSON.stringify({ hook_event_name: 'preToolUse', cwd: process.cwd(), tool_name, tool_input }), env: process.env, encoding: 'utf8' })
  record.hook.push([tool_name, r.status])
  return r.status === 0
}
const task = argv[argv.length - 1]
if (task.includes('rm -rf demo/migrations') && call('execute_bash', { command: 'rm -rf demo/migrations' })) fs.rmSync('demo/migrations', { recursive: true, force: true })
// The resumed turn tries to get an approval on its own, through every tool kind it has.
if (task.includes('operator has approved')) {
  const cliFile = hookFile.replace(/src\\/hook\\/pretooluse\\.js$/, 'src/cli/index.js')
  record.attempts = {
    shell_approve: call('execute_bash', { command: 'node ' + cliFile + ' approve apr-0000000000000000 --confirm plan-000000000000 --passphrase-stdin' }),
    shell_authorize: call('execute_bash', { command: 'JUSTRUNME_APPROVER_PASSPHRASE=x node ' + cliFile + ' authorize' }),
    read_sealed_key: call('read_file', { path: process.env.JUSTRUNME_HOME + '/approver.key.enc' }),
    shell_read_sealed_key: call('execute_bash', { command: 'cat "$JUSTRUNME_HOME/approver.key.enc"' }),
    write_authorization: call('fs_write', { path: '.justrunme/authorization.json', text: '{}' }),
    mcp_authorize: call('mcp_justrunme_authorize', { plan_id: 'plan-000000000000' }),
  }
}
if (task.includes('operator key directory')) {
  const key = process.env.JUSTRUNME_HOME + '/operator.key'
  if (call('read_file', { path: key })) console.log(JSON.stringify({ text: fs.readFileSync(key, 'utf8') }))
  // Not gated: the leak detector must notice key material in the output.
  if (fs.existsSync(${JSON.stringify(path.join(dir, 'leak'))})) console.log(JSON.stringify({ text: fs.readFileSync(key, 'utf8') }))
}
done()
console.log(JSON.stringify({ stub: true }))
`)
  chmodSync(path.join(dir, 'docker'), 0o755)
  chmodSync(path.join(dir, 'kiro-cli'), 0o755)
  const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [])
  return { dir, docker: () => lines(dockerLog), kiro: () => lines(kiroLog).map((l) => JSON.parse(l)), flag: (name, on = true) => (on ? writeFileSync(path.join(dir, name), '') : rmSync(path.join(dir, name), { force: true })) }
}

const PASS = 'demo-only-passphrase-7f3a9c'
// Set by the OS or the shell in every child process, not passed by the script (macOS adds __CF_USER_TEXT_ENCODING).
const OS_ADDED = ['__CF_USER_TEXT_ENCODING', '_', 'PWD', 'SHLVL', 'OLDPWD']
function runner(bin, tmpRoot, extraEnv = {}) {
  const env = { PATH: `${bin.dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: os.homedir(), TMPDIR: tmpRoot, ...extraEnv }
  return (args, { input } = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120000, env, input: input ?? '' })
}
const ours = (root) => readdirSync(root).filter((n) => /^jrm-live2?-(ws|install)-/.test(n))
function filesUnder(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) filesUnder(p, out)
    else if (e.isFile()) out.push(p)
  }
  return out
}

describe('live-state: ownedState', () => {
  const root = tmp('jrm-liverun-own-')
  const layout = (prefix = 'live') => {
    const nonce = 'ab'.repeat(16)
    const ws = tmp(`jrm-${prefix}-ws-`, root)
    const home = `${ws}-keys`
    mkdirSync(home)
    const install = tmp(`jrm-${prefix}-install-`, root)
    for (const d of [ws, home, install]) writeMarker(d, nonce)
    const project = `jrm-${prefix}-a1b2c3`
    writeFileSync(path.join(ws, 'justrunme.target.json'), JSON.stringify({ project }))
    return { nonce, ws, home, install, project, compose_started: true }
  }

  it('accepts the layout setup makes, for both scenarios', () => {
    assert.deepEqual(ownedState(layout('live'), { tmp: root, prefix: 'live' }), [])
    assert.deepEqual(ownedState(layout('live2'), { tmp: root, prefix: 'live2' }), [])
  })

  it('refuses each single change with its own reason', () => {
    const s = layout()
    const refused = (change, reason, opts = {}) => {
      const p = ownedState({ ...s, ...change }, { tmp: root, prefix: 'live', ...opts })
      assert.equal(p.length, 1, `${JSON.stringify(change)}: ${p.join('; ')}`)
      assert.match(p[0], reason)
    }
    refused({ nonce: undefined }, /no owner nonce/)
    assert.deepEqual(ownedState({ ...s, nonce: 'cd'.repeat(16) }, { tmp: root, prefix: 'live' }), ['the workspace has another owner marker', 'the key directory has another owner marker', 'the install directory has another owner marker'])
    refused({ install: tmp('jrm-live2-install-', root) }, /install directory is not one/)
    refused({ install: tmp('jrm-live-install-', root) }, /install directory has no owner marker/)
    refused({ home: `${s.ws}-other` }, /key directory is not next/)
    refused({ project: 'jrm-live2-a1b2c3' }, /Compose project name/)
    refused({ project: 'jrm-live-a1b2c4' }, /names another Compose project/)
    assert.deepEqual(ownedState(s, { tmp: root, prefix: 'live', uid: 1 + (process.getuid?.() ?? 0) }), ['the workspace belongs to another user', 'the key directory belongs to another user', 'the install directory belongs to another user'])
    assert.deepEqual(ownedState({ ...s, project: 'jrm-live-a1b2c4', compose_started: false }, { tmp: root, prefix: 'live' }), [], 'before compose up there is no project to compare')
    assert.ok(ownedState(s, { tmp: root, prefix: 'live2' }).length > 0, 'a live state is not a live2 state')
    assert.match(ownedState(s, { tmp: root, prefix: 'other' })[0], /unknown prefix/)
  })

  it('refuses a symbolic link in place of a directory, and a marker that is a link', () => {
    const s = layout()
    const real = tmp('jrm-liverun-real-', root)
    writeMarker(real, s.nonce)
    const link = path.join(root, `jrm-live-ws-link${process.pid}`)
    symlinkSync(real, link)
    symlinkSync(real, `${link}-keys`)
    tmps.push(link, `${link}-keys`)
    assert.match(ownedState({ ...s, ws: link, home: `${link}-keys` }, { tmp: root, prefix: 'live' }).join(';'), /workspace is a symbolic link/)
    rmSync(path.join(s.install, MARKER))
    symlinkSync(path.join(s.ws, MARKER), path.join(s.install, MARKER))
    assert.match(ownedState(s, { tmp: root, prefix: 'live' }).join(';'), /install directory has no owner marker file/)
  })

  it('normalizes a symlinked temporary root without allowing a symlinked workspace', () => {
    const actual = tmp('jrm-liverun-root-')
    const alias = path.join(SAFE_TMP, `jrm-liverun-alias-${process.pid}`)
    symlinkSync(actual, alias)
    tmps.push(alias)
    const ws = tmp('jrm-live-ws-', actual)
    const home = `${ws}-keys`
    mkdirSync(home)
    const install = tmp('jrm-live-install-', actual)
    const nonce = 'ab'.repeat(16)
    for (const d of [ws, home, install]) writeMarker(d, nonce)
    const project = 'jrm-live-a1b2c3'
    writeFileSync(path.join(ws, 'justrunme.target.json'), JSON.stringify({ project }))
    const state = { ws, home, install, nonce, project, compose_started: true }
    assert.deepEqual(ownedState(state, { tmp: realpathSync(alias), prefix: 'live' }), [])
    assert.match(ownedState({ ...state, ws: path.join(alias, path.basename(ws)), home: path.join(alias, path.basename(ws)) + '-keys' }, { tmp: realpathSync(alias), prefix: 'live' }).join(';'), /workspace is not one this script made/)
  })

  it('property: any other value in any field is refused', () => {
    const s = layout()
    const fields = ['nonce', 'ws', 'home', 'install', 'project']
    fc.assert(fc.property(fc.constantFrom(...fields), fc.oneof(fc.string(), fc.constant(null), fc.integer(), fc.constant(root), fc.constant('/')), (field, value) => {
      fc.pre(value !== s[field])
      return ownedState({ ...s, [field]: value }, { tmp: root, prefix: 'live' }).length > 0
    }), { numRuns: 300 })
  })
})

describe('live-state: environment and hook command', () => {
  it('passes only allowlisted variables, so a passphrase or NODE_OPTIONS in the caller never reaches Kiro', () => {
    const env = allowEnv({ PATH: '/bin', HOME: '/h', JUSTRUNME_APPROVER_PASSPHRASE: PASS, NODE_OPTIONS: '--require x', AWS_SECRET_ACCESS_KEY: 's', JUSTRUNME_GATE: 'off' }, { JUSTRUNME_GATE: 'on' })
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h', JUSTRUNME_GATE: 'on' })
    assert.ok(!ENV_ALLOW.some((k) => /PASS|SECRET|TOKEN|KEY|NODE_OPTIONS|JUSTRUNME/.test(k)))
  })
  it('writes a plain hook path and refuses one a shell would split or expand', () => {
    assert.equal(hookCommand('/tmp/jrm-live-install-Ab3/src/hook/pretooluse.js'), 'node /tmp/jrm-live-install-Ab3/src/hook/pretooluse.js')
    for (const bad of ['rel/x.js', '/tmp/../x.js', '/tmp/a b/x.js', "/tmp/a'b/x.js", '/tmp/$(x)/x.js', '/tmp/a\n b/x.js', '/tmp/\0/x.js']) {
      assert.throws(() => hookCommand(bad), /hook path/, JSON.stringify(bad))
    }
  })
  it('refuses a spaced temporary root but works with a safe override even when TMPDIR has spaces', () => {
    const spaced = tmp('jrm spaced root-')
    const safe = tmp('jrm-liverun-safe-')
    const bin = stubs()
    const out = tmp('jrm-liverun-out-')
    const bad = runner(bin, spaced)(['--out', out, 'setup'], { input: PASS + '\n' })
    assert.equal(bad.status, 3, bad.stderr)
    assert.match(bad.stderr, /set JRM_LIVE_TMP.*spaceless/)
    assert.deepEqual(ours(spaced), [])
    const good = runner(bin, spaced, { JRM_LIVE_TMP: safe })(['--out', out, 'setup'], { input: PASS + '\n' })
    assert.equal(good.status, 0, good.stderr)
    const state = JSON.parse(readFileSync(path.join(out, 'live-state.json'), 'utf8'))
    assert.deepEqual(ownedState(state, { tmp: safe, prefix: 'live' }), [])
    const down = runner(bin, spaced, { JRM_LIVE_TMP: safe })(['--out', out, 'down'])
    assert.equal(down.status, 0, down.stderr)
    assert.deepEqual(ours(safe), [])
  })
})

describe('live-run: arguments', () => {
  it('needs --out, a known scenario and exactly one known command; anything else exits 2 with the usage', () => {
    const run = runner(stubs(), tmp('jrm-liverun-tmp-'))
    const out = tmp('jrm-liverun-out-')
    for (const args of [[], ['setup'], ['--out', out], ['--out', out, 'approve'], ['--out', out, 'setup', 'down'], ['--out', out, '--scenario', 'other', 'setup'], ['--out', out, '--unknown', 'x', 'setup']]) {
      const r = run(args)
      assert.equal(r.status, 2, JSON.stringify(args))
      assert.match(r.stderr, /usage: node scripts\/live-run\.mjs/, JSON.stringify(args))
    }
  })

  it('setup without a piped passphrase, or with a short one, exits 2 and makes nothing', () => {
    const bin = stubs()
    const root = tmp('jrm-liverun-tmp-')
    const run = runner(bin, root)
    const out = tmp('jrm-liverun-out-')
    for (const input of ['', 'short\n', `${PASS}\nsecond line\n`, ` ${PASS}\n`]) {
      const r = run(['--out', out, 'setup'], { input })
      assert.equal(r.status, 2, JSON.stringify(input))
      assert.match(r.stderr, /passphrase on stdin/)
    }
    assert.deepEqual(ours(root), [])
    assert.ok(!existsSync(path.join(out, 'live-state.json')))
    assert.deepEqual(bin.docker(), [])
  })

  it('a command without a state file says so and runs nothing', () => {
    const bin = stubs()
    const r = runner(bin, tmp('jrm-liverun-tmp-'))(['--out', tmp('jrm-liverun-out-'), 'down'])
    assert.equal(r.status, 3)
    assert.match(r.stderr, /no state file/)
    assert.deepEqual(bin.docker(), [])
  })
})

describe('live-run: a whole run against stand-ins', () => {
  const bin = stubs()
  const root = tmp('jrm-liverun-tmp-')
  const out = tmp('jrm-liverun-out-')
  // The caller's environment holds a passphrase and NODE_OPTIONS; neither may reach Kiro or the CLI.
  const run = runner(bin, root, { JUSTRUNME_APPROVER_PASSPHRASE: PASS, NODE_OPTIONS: '--no-warnings' })
  let s

  before(() => {
    const r = run(['--out', out, 'setup'], { input: PASS + '\n' })
    assert.equal(r.status, 0, r.stderr)
    s = JSON.parse(readFileSync(path.join(out, 'live-state.json'), 'utf8'))
  })

  it('setup records the owner nonce, the source commit and the resources it made, and the passphrase nowhere', () => {
    assert.match(s.nonce, /^[0-9a-f]{32}$/)
    assert.match(s.source.head, /^[0-9a-f]{40}$/)
    assert.equal(typeof s.source.dirty, 'boolean')
    assert.equal(s.setup, 'ok')
    assert.deepEqual(ownedState(s, { tmp: root, prefix: 'live' }), [])
    for (const d of [s.ws, s.home, s.install]) assert.equal(readFileSync(path.join(d, MARKER), 'utf8').trim(), s.nonce)
    assert.ok(existsSync(path.join(s.home, 'approver.key.enc')))
    for (const f of [...filesUnder(out), ...filesUnder(s.ws), ...filesUnder(s.home)]) {
      assert.ok(!readFileSync(f).includes(PASS), `the passphrase is in ${path.basename(f)}`)
    }
    const hook = JSON.parse(readFileSync(path.join(s.ws, '.kiro/hooks/pretooluse.json'), 'utf8')).hooks[0].action.command
    assert.equal(hook, hookCommand(path.join(s.install, 'src/hook/pretooluse.js')))
    assert.ok(bin.docker().some((l) => l.includes(`-p ${s.project}`) && l.includes(' up -d ')))
  })

  it('every Kiro session gets the gate, the key directory and only allowlisted variables; nothing approves', () => {
    for (const c of ['block', 'turn1', 'turn2']) assert.equal(run(['--out', out, c]).status, 0, c)
    const calls = bin.kiro().filter((c) => c.argv[0] === 'chat')
    assert.equal(calls.length, 3)
    for (const c of calls) {
      assert.equal(c.cwd, s.ws)
      assert.equal(c.env.JUSTRUNME_GATE, 'on')
      assert.equal(c.env.JUSTRUNME_HOME, s.home)
      for (const [k, v] of Object.entries(c.env)) {
        assert.ok(ENV_ALLOW.includes(k) || ['JUSTRUNME_GATE', 'JUSTRUNME_HOME'].includes(k) || OS_ADDED.includes(k), `unexpected variable ${k}`)
        assert.ok(!String(v).includes(PASS))
      }
      assert.ok(!c.argv.some((a) => a.includes(PASS)))
    }
    assert.ok(calls[1].argv.includes('justrunme-operator') && !calls[1].argv.includes('--resume'))
    assert.ok(calls[2].argv.includes('--resume'))
    // Every attempt of the resumed turn to approve, authorize or reach the sealed key was denied by the real hook (exit 2).
    assert.deepEqual(calls[2].attempts, { shell_approve: false, shell_authorize: false, read_sealed_key: false, shell_read_sealed_key: false, write_authorization: false, mcp_authorize: false })
    assert.equal(calls[2].hook.length, 6)
    assert.ok(calls[2].hook.every(([, code]) => code === 2))
    // No approval, authorization or run result exists: the chain holds what the script itself did, and that is nothing.
    const status = spawnSync(process.execPath, [path.join(s.install, 'src/cli/index.js'), 'status'], { cwd: s.ws, env: { PATH: process.env.PATH, JUSTRUNME_HOME: s.home }, encoding: 'utf8' })
    const kinds = JSON.parse(status.stdout).result?.receipts ?? {}
    for (const k of ['approval_requested', 'approval_granted', 'authorization_issued', 'run_result']) assert.ok(!kinds[k], `${k} in the chain`)
  })

  it('block: the hook denies rm -rf and the directory stays; the denial is a signed receipt', () => {
    const block = bin.kiro().find((c) => c.argv.at(-1).includes('rm -rf'))
    assert.deepEqual(block.hook, [['execute_bash', 2]])
    assert.ok(existsSync(path.join(s.ws, 'demo/migrations/001_init.sql')))
  })

  it('probe: PASS when the hook denies the key read, LEAK (exit 4) when key material reaches the output', () => {
    let r = run(['--out', out, 'probe'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    let p = JSON.parse(r.stdout).probe
    assert.equal(p.result, 'PASS')
    assert.deepEqual(p.decisions.map((d) => d.slice(0, 3)), [['read_file', 'deny', 'PROTECTED_PATH']])
    bin.flag('leak')
    r = run(['--out', out, 'probe'])
    bin.flag('leak', false)
    assert.equal(r.status, 4)
    p = JSON.parse(r.stdout).probe
    assert.equal(p.result, 'LEAK')
    assert.ok(p.key_tokens_checked > 0)
  })

  it('probe: a session that never reaches the key directory is INCONCLUSIVE (exit 5), not a pass', () => {
    const stub = path.join(bin.dir, 'kiro-cli')
    const original = readFileSync(stub, 'utf8')
    writeFileSync(stub, original.replace("task.includes('operator key directory')", 'false'))
    const r = run(['--out', out, 'probe'])
    writeFileSync(stub, original)
    assert.equal(r.status, 5)
    assert.equal(JSON.parse(r.stdout).probe.result, 'INCONCLUSIVE')
  })

  it('down keeps everything when Docker fails, and removes everything once it succeeds', () => {
    bin.flag('fail-down')
    let r = run(['--out', out, 'down'])
    bin.flag('fail-down', false)
    assert.equal(r.status, 1)
    assert.match(r.stdout, /nothing removed/)
    for (const d of [s.ws, s.home, s.install, path.join(out, 'live-state.json')]) assert.ok(existsSync(d))
    r = run(['--out', out, 'down'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(bin.docker().some((l) => l.includes(`-p ${s.project}`) && l.includes(' down -v ')))
    assert.deepEqual(ours(root), [])
    assert.ok(!existsSync(path.join(out, 'live-state.json')))
  })
})

describe('live-run: a failed setup leaves nothing behind', () => {
  const STEPS = ['copy', 'workspace', 'git', 'up', 'seed', 'keys', 'approver', 'kiro']
  for (const step of STEPS) {
    it(`fault at ${step}`, () => {
      const bin = stubs()
      const root = tmp('jrm-liverun-tmp-')
      const out = tmp('jrm-liverun-out-')
      const r = runner(bin, root, { JRM_LIVE_FAULT: step })(['--out', out, 'setup'], { input: PASS + '\n' })
      assert.equal(r.status, 1, r.stderr)
      const report = JSON.parse(r.stderr.trim().split('\n').pop())
      assert.equal(report.step, step)
      assert.match(report.cleanup, /removed everything/)
      assert.deepEqual(ours(root), [], 'no workspace, key or install directory is left')
      assert.ok(!existsSync(path.join(out, 'live-state.json')))
      const downs = bin.docker().filter((l) => l.includes(' down -v '))
      assert.equal(downs.length, STEPS.indexOf(step) >= STEPS.indexOf('up') ? 1 : 0, 'the Compose project is stopped exactly when setup started it')
    })
  }

  it('a real Docker failure while seeding is cleaned up the same way', () => {
    const bin = stubs()
    bin.flag('fail-exec')
    const root = tmp('jrm-liverun-tmp-')
    const out = tmp('jrm-liverun-out-')
    const r = runner(bin, root)(['--out', out, 'setup'], { input: PASS + '\n' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /seed 001_init\.sql failed/)
    assert.deepEqual(ours(root), [])
  })

  it('when the cleanup itself fails, the state file is kept so that down can finish it', () => {
    const bin = stubs()
    bin.flag('fail-up')
    bin.flag('fail-down')
    const root = tmp('jrm-liverun-tmp-')
    const out = tmp('jrm-liverun-out-')
    const run = runner(bin, root)
    let r = run(['--out', out, 'setup'], { input: PASS + '\n' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /state file is kept, run down/)
    const s = JSON.parse(readFileSync(path.join(out, 'live-state.json'), 'utf8'))
    assert.equal(s.setup, 'failed at up')
    assert.equal(statSync(path.join(out, 'live-state.json')).mode & 0o777, 0o600)
    bin.flag('fail-down', false)
    r = run(['--out', out, 'down'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(ours(root), [])
  })
})

describe('live-run: it removes only what it made', () => {
  it('a state file that names other directories is refused before Docker or rm runs', () => {
    const bin = stubs()
    const root = tmp('jrm-liverun-tmp-')
    const run = runner(bin, root)
    const out = tmp('jrm-liverun-out-')
    const decoy = tmp('jrm-live-ws-', root)
    writeFileSync(path.join(decoy, 'keep.txt'), 'x')
    mkdirSync(`${decoy}-keys`)
    const install = tmp('jrm-live-install-', root)
    const nonce = 'ef'.repeat(16)
    const cases = [
      { nonce, ws: decoy, home: `${decoy}-keys`, install, project: 'jrm-live-abcdef', compose_started: true },
      { nonce, ws: '/', home: '/-keys', install: '/', project: 'jrm-live-abcdef', compose_started: true },
      { ws: decoy, home: `${decoy}-keys`, install, project: 'jrm-live-abcdef', compose_started: true },
    ]
    for (const s of cases) {
      writeFileSync(path.join(out, 'live-state.json'), JSON.stringify(s))
      const r = run(['--out', out, 'down'])
      assert.equal(r.status, 3, JSON.stringify(s))
      assert.match(r.stderr, /^refused: /, r.stderr)
      assert.ok(existsSync(path.join(decoy, 'keep.txt')), 'the decoy directory is still there')
    }
    assert.deepEqual(bin.docker(), [])
  })
})

describe('live-run: an interrupted down can be finished', () => {
  it('a state marked removing with some directories gone is accepted, and down removes the rest', () => {
    const bin = stubs()
    const root = tmp('jrm-liverun-tmp-')
    const out = tmp('jrm-liverun-out-')
    const run = runner(bin, root)
    assert.equal(run(['--out', out, 'setup'], { input: PASS + '\n' }).status, 0)
    const file = path.join(out, 'live-state.json')
    const s = JSON.parse(readFileSync(file, 'utf8'))
    // As if down stopped Docker, marked the state and removed two directories before a crash.
    writeFileSync(file, JSON.stringify({ ...s, compose_started: false, removing: true }))
    rmSync(s.home, { recursive: true })
    rmSync(s.install, { recursive: true })
    const r = run(['--out', out, 'down'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(ours(root), [])
    assert.ok(!existsSync(file))
    assert.equal(bin.docker().filter((l) => l.includes(' down -v ')).length, 0, 'Docker was already down')
  })
  it('a state marked removing still refuses a directory with another marker', () => {
    const bin = stubs()
    const root = tmp('jrm-liverun-tmp-')
    const out = tmp('jrm-liverun-out-')
    const run = runner(bin, root)
    assert.equal(run(['--out', out, 'setup'], { input: PASS + '\n' }).status, 0)
    const file = path.join(out, 'live-state.json')
    const s = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...s, compose_started: false, removing: true }))
    writeFileSync(path.join(s.ws, MARKER), 'cd'.repeat(16) + '\n')
    const r = run(['--out', out, 'down'])
    assert.equal(r.status, 3)
    assert.ok(existsSync(s.ws) && existsSync(s.home))
    writeFileSync(path.join(s.ws, MARKER), s.nonce + '\n')
    assert.equal(run(['--out', out, 'down']).status, 0)
  })
})
