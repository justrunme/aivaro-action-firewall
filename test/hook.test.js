import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync, existsSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { stringify } from 'yaml'
import { parseContract } from '../src/contract/parser.js'
import { evaluate } from '../src/hook/evaluate.js'
import { hashScript } from '../src/hook/allowlist.js'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { verifyChain, chainPath, anchorPath, reanchorChain, recoverLock, inspectChainLock } from '../src/receipts/chain.js'
import { checkPolicy } from '../src/receipts/policy.js'
import { withLock } from '../src/receipts/lock.js'
import { analyzeShell } from '../src/hook/bypass.js'
import { tokenizeShell } from '../src/hook/shell.js'

const HOOK = new URL('../src/hook/pretooluse.js', import.meta.url).pathname
const NOW = Date.now()

const CONTRACT = {
  id: 'mission-hook-test',
  objective: 'Exercise the gate in a temporary workspace',
  allowed_paths: ['demo/migrations/', 'demo/src/'],
  protected_tables: ['orders'],
  time_limit_seconds: 300,
  irreversible_actions: [],
  plan: [{ id: 'step-1', tool: 'shell', args: ['node', 'demo/migrations/run.js'], reversibility: true }],
  resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['app'] },
}

const dirs = []
function workspace({ contract = CONTRACT } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jrm-hook-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'demo/migrations'), { recursive: true })
  mkdirSync(path.join(dir, 'demo/src'), { recursive: true })
  writeFileSync(path.join(dir, 'demo/migrations/run.js'), "console.log('migrate')\n")
  writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"echo ok"}}\n')
  if (contract) writeFileSync(path.join(dir, 'justrunme.mission.yaml'), stringify(contract))
  return dir
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function context(dir, { entries = [], auth = true, over = {} } = {}) {
  const parsed = parseContract(readFileSync(path.join(dir, 'justrunme.mission.yaml'), 'utf8'))
  const authorization = auth
    ? {
        version: 1,
        mission_id: parsed.contract.id,
        contract_hash: parsed.hash,
        fingerprint_hash: 'sha256:' + '0'.repeat(64),
        issued_at: new Date(NOW - 1000).toISOString(),
        expires_at: new Date(NOW + 600000).toISOString(),
        entries,
        ...over,
      }
    : null
  return { cwd: dir, contract: parsed.contract, contractHash: parsed.hash, authorization, now: NOW }
}

const shell = (command) => ({ tool_name: 'execute_bash', tool_input: { command } })
const write = (p) => ({ tool_name: 'fs_write', tool_input: { path: p, text: 'x' } })
const migrateEntry = (dir) => ({
  action: { tool: 'shell', argv: ['node', 'demo/migrations/run.js'] },
  script_hashes: { 'demo/migrations/run.js': hashScript('demo/migrations/run.js', dir) },
})

describe('hook: contract and tool classes (R1.4, R1.5, R1.6)', () => {
  it('blocks everything when there is no contract', () => {
    const ctx = { cwd: os.tmpdir(), contract: null, authorization: null, now: NOW }
    assert.equal(evaluate({ tool_name: 'read_file', tool_input: { path: 'a' } }, ctx).category, 'NO_CONTRACT')
  })

  it('allows reads and bookkeeping tools', () => {
    const ctx = context(workspace())
    assert.equal(evaluate({ tool_name: 'read_file', tool_input: { path: 'x' } }, ctx).decision, 'allow')
    assert.equal(evaluate({ tool_name: 'todo_list', tool_input: {} }, ctx).decision, 'allow')
  })

  it('denies unknown tools', () => {
    const r = evaluate({ tool_name: 'invoke_sub_agent', tool_input: {} }, context(workspace()))
    assert.equal(r.category, 'UNKNOWN_TOOL')
  })

  it('denies malformed events', () => {
    const ctx = context(workspace())
    assert.equal(evaluate(null, ctx).category, 'MALFORMED_EVENT')
    assert.equal(evaluate({ tool_name: 5 }, ctx).category, 'MALFORMED_EVENT')
    assert.equal(evaluate({ tool_name: 'fs_write', tool_input: [] }, ctx).category, 'MALFORMED_EVENT')
    assert.equal(evaluate({ tool_name: 'execute_bash', tool_input: { command: 3 } }, context(workspace())).category, 'MALFORMED_EVENT')
  })
})

describe('hook: writes (R1.6)', () => {
  it('allows writes under allowed_paths only', () => {
    const ctx = context(workspace())
    assert.equal(evaluate(write('demo/migrations/003_add.sql'), ctx).decision, 'allow')
    assert.equal(evaluate(write('README.md'), ctx).category, 'OUT_OF_CONTRACT')
  })

  it('blocks traversal and absolute paths outside the workspace', () => {
    const ctx = context(workspace())
    assert.equal(evaluate(write('demo/migrations/../../../etc/x'), ctx).category, 'OUT_OF_CONTRACT')
    assert.equal(evaluate(write(path.join(os.tmpdir(), 'elsewhere.txt')), ctx).category, 'OUT_OF_CONTRACT')
  })

  it('blocks a symlink that points out of the workspace', () => {
    const dir = workspace()
    const outside = mkdtempSync(path.join(os.tmpdir(), 'jrm-out-'))
    dirs.push(outside)
    symlinkSync(outside, path.join(dir, 'demo/src/link'))
    assert.equal(evaluate(write('demo/src/link/evil.js'), context(dir)).category, 'OUT_OF_CONTRACT')
  })

  it('protects the whole JustRunMe installation when it lies inside the workspace', () => {
    const repoRoot = new URL('..', import.meta.url).pathname
    const contract = { ...CONTRACT, allowed_paths: ['src/', 'node_modules/', 'package.json', 'demo/'] }
    const parsed = parseContract(stringify(contract))
    const c = { cwd: repoRoot, contract: parsed.contract, contractHash: parsed.hash, authorization: null, now: NOW }
    for (const p of ['src/contract/parser.js', 'src/util/canonical.js', 'node_modules/yaml/dist/index.js', 'package.json']) {
      assert.equal(evaluate(write(p), c).category, 'PROTECTED_PATH', p)
    }
    assert.equal(evaluate(write('demo/src/x.js'), c).decision, 'allow')
  })

  it('never lets the agent write the gate, its inputs or git metadata', () => {
    const ctx = context(workspace())
    for (const p of ['.justrunme/authorization.json', 'justrunme.mission.yaml', 'justrunme.target.json', '.kiro/hooks/pretooluse.json', '.git/config', 'src/hook/evaluate.js']) {
      assert.equal(evaluate(write(p), ctx).category, 'PROTECTED_PATH', p)
    }
  })

  it('denies a write whose path cannot be determined', () => {
    assert.equal(evaluate({ tool_name: 'fs_write', tool_input: { text: 'x' } }, context(workspace())).decision, 'deny')
  })
})

describe('hook: shell allowlist bound to script content (R3.6, R3.7)', () => {
  it('denies shell without an authorization', () => {
    const ctx = context(workspace(), { auth: false })
    assert.equal(evaluate(shell('ls'), ctx).category, 'NO_AUTHORIZATION')
  })

  it('allows the rehearsed command and denies different arguments', () => {
    const dir = workspace()
    const ctx = context(dir, { entries: [migrateEntry(dir)] })
    assert.equal(evaluate(shell('node demo/migrations/run.js'), ctx).decision, 'allow')
    assert.equal(evaluate(shell('node   demo/migrations/run.js'), ctx).decision, 'allow')
    assert.equal(evaluate(shell('node demo/migrations/run.js --force'), ctx).decision, 'deny')
  })

  it('denies the same command string after the script content changed', () => {
    const dir = workspace()
    const ctx = context(dir, { entries: [migrateEntry(dir)] })
    writeFileSync(path.join(dir, 'demo/migrations/run.js'), "console.log('DROP TABLE orders')\n")
    const r = evaluate(shell('node demo/migrations/run.js'), ctx)
    assert.equal(r.category, 'SCRIPT_CHANGED')
  })

  it('denies an entry that has no recorded script hash', () => {
    const dir = workspace()
    const entry = { action: { tool: 'shell', argv: ['node', 'demo/migrations/run.js'] }, script_hashes: {} }
    assert.equal(evaluate(shell('node demo/migrations/run.js'), context(dir, { entries: [entry] })).category, 'UNDECLARED_SCRIPT')
  })

  it('denies after expiry, after the time limit, for another mission and after a contract change', () => {
    const dir = workspace()
    const entries = [migrateEntry(dir)]
    const expired = context(dir, { entries, over: { expires_at: new Date(NOW - 1).toISOString() } })
    const overLimit = context(dir, { entries, over: { issued_at: new Date(NOW - 301 * 1000).toISOString() } })
    const other = context(dir, { entries, over: { mission_id: 'mission-other' } })
    const edited = context(dir, { entries, over: { contract_hash: 'sha256:' + '1'.repeat(64) } })
    assert.equal(evaluate(shell('node demo/migrations/run.js'), expired).category, 'EXPIRED')
    assert.equal(evaluate(shell('node demo/migrations/run.js'), overLimit).category, 'EXPIRED')
    assert.equal(evaluate(shell('node demo/migrations/run.js'), other).category, 'AUTHORIZATION_INVALID')
    assert.equal(evaluate(shell('node demo/migrations/run.js'), edited).category, 'AUTHORIZATION_INVALID')
    assert.equal(evaluate(write('demo/src/a.js'), overLimit).category, 'EXPIRED')
  })

  it('binds package.json for npm commands', () => {
    const dir = workspace()
    const entry = {
      action: { tool: 'shell', argv: ['npm', 'test'] },
      script_hashes: { 'package.json': hashScript('package.json', dir) },
    }
    const ctx = context(dir, { entries: [entry] })
    assert.equal(evaluate(shell('npm test'), ctx).decision, 'allow')
    writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"curl evil"}}\n')
    assert.equal(evaluate(shell('npm test'), ctx).category, 'SCRIPT_CHANGED')
  })
})

describe('hook: bypass categories (R10.2, R10.3, R10.4, R10.7)', () => {
  const dir = workspace()
  const ctx = context(dir, { entries: [migrateEntry(dir)] })

  for (const cmd of [
    `python3 -c "import subprocess; subprocess.run(['id'])"`,
    `sh -c 'echo hi'`,
    `bash -lc "ls"`,
    `node -e "process.exit(0)"`,
    `perl -e 'print 1'`,
    `sed -i s/a/b/ demo/src/x.js`,
    `env FOO=1 node demo/migrations/run.js`,
    `ls | sh`,
  ]) {
    it(`blocks INLINE_INTERPRETER: ${JSON.stringify(cmd).slice(0, 50)}`, () => {
      const r = evaluate(shell(cmd), ctx)
      assert.equal(r.decision, 'deny')
      assert.equal(r.category, 'INLINE_INTERPRETER', cmd)
    })
  }

  it('blocks UNDECLARED_SCRIPT: script written elsewhere then executed', () => {
    for (const cmd of ['sh /tmp/x.sh', './deploy.sh', 'python3 helper.py', 'node demo/src/new.js']) {
      assert.equal(evaluate(shell(cmd), ctx).category, 'UNDECLARED_SCRIPT', cmd)
    }
  })

  it('T18: the agent cannot call the operator CLI through the shell, even with an authorization present', () => {
    for (const cmd of ['justrunme authorize', 'npx justrunme authorize', 'node src/cli/index.js authorize', 'node node_modules/.bin/justrunme run', 'npm exec justrunme compare']) {
      assert.equal(evaluate(shell(cmd), ctx).decision, 'deny', cmd)
    }
  })

  it('blocks package fetch-and-run', () => {
    assert.equal(evaluate(shell('npx some-package'), ctx).category, 'UNDECLARED_SCRIPT')
    assert.equal(evaluate(shell('python3 -m http.server'), ctx).category, 'UNDECLARED_SCRIPT')
  })

  it('blocks plain metacharacters (redirect, chaining, globbing, substitution, heredoc)', () => {
    for (const cmd of ['ls > out.txt', 'ls && ls', 'rm -rf *', 'echo a; echo b', 'echo $(id)', 'echo `id`', 'cat <<EOF\nid\nEOF']) {
      const r = evaluate(shell(cmd), ctx)
      assert.equal(r.decision, 'deny', cmd)
      assert.equal(r.category, 'SHELL_METACHARACTER', cmd)
    }
  })

  it('allows a complex command only when rehearsed and environment-verified', () => {
    const raw = 'echo a | wc -c'
    const verified = context(dir, { entries: [{ action: { tool: 'shell', raw }, script_hashes: {}, environment_verified: true }] })
    const unverified = context(dir, { entries: [{ action: { tool: 'shell', raw }, script_hashes: {} }] })
    assert.equal(evaluate(shell(raw), verified).decision, 'allow')
    assert.equal(evaluate(shell(raw), unverified).decision, 'deny')
    assert.equal(evaluate(shell('echo a | wc -l'), verified).decision, 'deny')
  })

  it('blocks MCP re-entry from a justrunme server and unlisted MCP tools', () => {
    assert.equal(evaluate({ tool_name: 'mcp_justrunme_undo_mission', tool_input: {} }, ctx).category, 'MCP_REENTRY')
    assert.equal(evaluate({ tool_name: 'mcp_postgres_query', tool_input: { sql: 'select 1' } }, ctx).decision, 'deny')
  })

  it('allows a rehearsed MCP call only with identical input', () => {
    const entry = { action: { tool: 'mcp_postgres_query', input: { sql: 'select 1' } }, script_hashes: {} }
    const c = context(dir, { entries: [entry] })
    assert.equal(evaluate({ tool_name: 'mcp_postgres_query', tool_input: { sql: 'select 1' } }, c).decision, 'allow')
    assert.equal(evaluate({ tool_name: 'mcp_postgres_query', tool_input: { sql: 'select 2' } }, c).decision, 'deny')
  })

  it('blocks a rehearsed statement that drops a protected table unless irreversible_approved', () => {
    const cmd = 'psql -c "DROP TABLE orders"'
    const action = { tool: 'shell', argv: ['psql', '-c', 'DROP TABLE orders'] }
    const plain = context(dir, { entries: [{ action, script_hashes: {} }] })
    const approved = context(dir, { entries: [{ action, script_hashes: {}, irreversible_approved: true }] })
    assert.equal(evaluate(shell(cmd), plain).category, 'PROTECTED_TABLE')
    assert.equal(evaluate(shell(cmd), approved).decision, 'allow')
    // A raw-form entry does not match a command that is analyzed as a plain argv list.
    const rawOnly = context(dir, { entries: [{ action: { tool: 'shell', raw: cmd }, script_hashes: {}, environment_verified: true, irreversible_approved: true }] })
    assert.equal(evaluate(shell(cmd), rawOnly).decision, 'deny')
  })

  it('blocks a rehearsed command run from another working directory (execute_bash cwd)', () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'jrm-cwd-'))
    dirs.push(other)
    const call = (cwd) => ({ tool_name: 'execute_bash', tool_input: { command: 'node demo/migrations/run.js', cwd } })
    assert.equal(evaluate(call(other), ctx).category, 'OUT_OF_CONTRACT')
    assert.equal(evaluate(call('demo'), ctx).category, 'OUT_OF_CONTRACT')
    assert.equal(evaluate(call(dir), ctx).decision, 'allow')
    assert.equal(evaluate(call(null), ctx).decision, 'allow')
    assert.equal(evaluate(call(7), ctx).category, 'MALFORMED_EVENT')
  })

  it('denies any tool call that touches the operator key directory, reads included', () => {
    const keyHome = mkdtempSync(path.join(os.tmpdir(), 'jrm-keys-'))
    dirs.push(keyHome)
    const c = { ...ctx, keyHome }
    assert.equal(evaluate({ tool_name: 'read_file', tool_input: { path: path.join(keyHome, 'operator.key') } }, c).category, 'PROTECTED_PATH')
    assert.equal(evaluate(shell(`cat ${keyHome}/operator.key`), c).category, 'PROTECTED_PATH')
    assert.equal(evaluate({ tool_name: 'read_file', tool_input: { path: 'package.json' } }, c).decision, 'allow')
  })

  it('analyzeShell reports scripts and categories', () => {
    assert.deepEqual(analyzeShell('node demo/migrations/run.js').scripts, ['demo/migrations/run.js'])
    assert.equal(analyzeShell('docker compose ps').category, null)
    assert.equal(tokenizeShell("echo 'a b' c").argv.length, 3)
    assert.equal(tokenizeShell('echo "$HOME"').complex, true)
  })
})

describe('hook: property tests (R10.1, R10.6)', () => {
  it('no random shell command is allowed when the allowlist does not contain it', () => {
    const dir = workspace()
    const ctx = context(dir, { entries: [migrateEntry(dir)] })
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (cmd) => {
        if (cmd.trim() === 'node demo/migrations/run.js') return true
        return evaluate(shell(cmd), ctx).decision === 'deny'
      }),
      { numRuns: 500 }
    )
  })

  it('random tool names never produce an allow for non-read tools without a rule', () => {
    const ctx = context(workspace(), { auth: false })
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), (name) => {
        const r = evaluate({ tool_name: 'x_' + name, tool_input: {} }, ctx)
        return r.decision === 'deny'
      }),
      { numRuns: 200 }
    )
  })

  it('evaluate never throws on arbitrary JSON events', () => {
    const ctx = context(workspace())
    fc.assert(
      fc.property(fc.jsonValue(), (event) => {
        const r = evaluate(event, ctx)
        return r.decision === 'allow' || r.decision === 'deny'
      }),
      { numRuns: 300 }
    )
  })
})

describe('hook process: exit codes as Kiro sees them (R10.5, R10.6, R10.8)', () => {
  // Operator key directory shared by these tests; the hook signs each decision with it.
  const operatorHome = mkdtempSync(path.join(os.tmpdir(), 'jrm-hook-operator-'))
  dirs.push(operatorHome)
  const operatorKeys = loadOrCreateKeys(operatorHome)
  function run(dir, input, { gate = 'on', home } = {}) {
    const env = { ...process.env }
    delete env.JUSTRUNME_GATE
    if (gate !== null) env.JUSTRUNME_GATE = gate
    env.JUSTRUNME_HOME = home ?? operatorHome
    return spawnSync(process.execPath, [HOOK], { cwd: dir, input, env, encoding: 'utf8' })
  }
  const ev = (o) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: '.', ...o })

  it('is inactive when JUSTRUNME_GATE is not on', () => {
    const dir = workspace({ contract: null })
    assert.equal(run(dir, 'garbage', { gate: null }).status, 0)
    assert.equal(run(dir, 'garbage', { gate: 'off' }).status, 0)
  })

  it('exits 2 with a reason on stderr and writes an audit line for a blocked call', () => {
    const dir = workspace()
    const r = run(dir, ev({ tool_name: 'execute_bash', tool_input: { command: 'rm -rf demo' } }))
    assert.equal(r.status, 2)
    const out = JSON.parse(r.stderr.trim())
    assert.equal(out.justrunme, 'deny')
    assert.match(out.denial_id, /^den-[0-9a-f]{16}$/)
    const audit = readFileSync(path.join(dir, '.justrunme/audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(audit.at(-1).decision, 'deny')
    assert.equal(audit.at(-1).denial_id, out.denial_id)
    assert.doesNotMatch(JSON.stringify(audit), /\/Users\/|@/)
  })

  it('exits 0 for an allowed write and read', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'fs_write', tool_input: { path: 'demo/src/new.js', text: '1' } })).status, 0)
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'package.json' } })).status, 0)
  })

  it('rejects an unsigned authorization file written into the workspace (self-issued)', () => {
    const dir = workspace()
    const ctx = context(dir, { entries: [migrateEntry(dir)] })
    mkdirSync(path.join(dir, '.justrunme'), { recursive: true })
    const auth = { ...ctx.authorization, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 120000).toISOString() }
    writeFileSync(path.join(dir, '.justrunme/authorization.json'), JSON.stringify(auth))
    const call = ev({ tool_name: 'execute_bash', tool_input: { command: 'node demo/migrations/run.js' } })
    const r = run(dir, call)
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stderr.trim()).category, 'AUTHORIZATION_INVALID')
  })

  // T16.1: hook decisions in the signed chain.
  const verifyHookChain = (dir) => verifyChain({ repoDir: dir, home: operatorHome, publicKey: operatorKeys.publicKey, missionId: CONTRACT.id })

  it('T16.1: every decision with an active contract is a signed hook_decision receipt', () => {
    const dir = workspace()
    const deny = run(dir, ev({ tool_name: 'execute_bash', tool_input: { command: 'rm -rf demo' } }))
    const allow = run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'package.json' } }))
    assert.equal(deny.status, 2)
    assert.equal(allow.status, 0)
    assert.match(JSON.parse(deny.stderr.trim()).receipt_hash, /^sha256:[0-9a-f]{64}$/)
    const v = verifyHookChain(dir)
    assert.equal(v.ok, true, JSON.stringify(v.findings))
    assert.deepEqual(v.receipts.map((r) => [r.kind, r.verdict, r.subject.tool]), [
      ['hook_decision', 'deny', 'execute_bash'],
      ['hook_decision', 'allow', 'read_file'],
    ])
    // Only a hash of the tool input is recorded, never the input itself.
    assert.ok(!readFileSync(chainPath(dir, CONTRACT.id), 'utf8').includes('rm -rf demo'))
  })

  it('T16.1: 24 hook processes deciding at the same time produce one gap-free chain', async () => {
    const dir = workspace()
    const env = { ...process.env, JUSTRUNME_GATE: 'on', JUSTRUNME_HOME: operatorHome }
    const { spawn } = await import('node:child_process')
    const one = (i) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [HOOK], { cwd: dir, env })
        const input = i % 2 === 0 ? { tool_name: 'read_file', tool_input: { path: `f${i}` } } : { tool_name: 'execute_bash', tool_input: { command: `echo ${i}` } }
        child.on('close', (code) => resolve({ i, code }))
        child.stdin.end(ev(input))
      })
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => one(i)))
    for (const { i, code } of results) assert.equal(code, i % 2 === 0 ? 0 : 2, `process ${i}`)
    const v = verifyHookChain(dir)
    assert.equal(v.ok, true, JSON.stringify(v.findings))
    assert.equal(v.count, 24)
    assert.deepEqual(v.receipts.map((r) => r.seq), Array.from({ length: 24 }, (_, i) => i))
    assert.equal(v.receipts.filter((r) => r.verdict === 'allow').length, 12)
  })

  it('T16.1: no allow without a record: a broken chain makes the hook deny everything', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    const file = chainPath(dir, CONTRACT.id)
    const bytes = readFileSync(file)
    bytes[30] = bytes[30] ^ 1
    writeFileSync(file, bytes)
    const r = run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } }))
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stderr.trim()).category, 'RECEIPT_FAILED')
  })

  it('T16.1: without an installed operator key the gate denies (it never creates one itself)', () => {
    const dir = workspace()
    const empty = mkdtempSync(path.join(os.tmpdir(), 'jrm-hook-nokey-'))
    dirs.push(empty)
    const r = run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } }), { home: empty })
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stderr.trim()).category, 'NO_OPERATOR_KEY')
    assert.equal(existsSync(path.join(empty, 'operator.key')), false)
  })

  // Review points on PR 8.
  const lockOf = (dir) => chainPath(dir, CONTRACT.id) + '.lock'
  const tokenFor = (pid) => `${pid} ${os.hostname()} ${'a'.repeat(16)}\n`

  it('PR 8 review 1: a lock of a LIVE owner is never broken, however old the file is', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    // The test runner itself is a live process: use its pid as the owner.
    writeFileSync(lockOf(dir), tokenFor(process.pid))
    const hourAgo = new Date(Date.now() - 3600 * 1000)
    utimesSync(lockOf(dir), hourAgo, hourAgo)
    const r = run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } }))
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stderr.trim()).category, 'RECEIPT_FAILED')
    assert.equal(readFileSync(lockOf(dir), 'utf8'), tokenFor(process.pid), 'the live owner still holds its lock')
    assert.equal(verifyHookChain(dir).count, 1)
    rmSync(lockOf(dir))
  })

  it('PR 8 review 1: a lock of a DEAD owner on this host is removed and the decision proceeds', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
    const deadPid = Number(gone.stdout.trim())
    writeFileSync(lockOf(dir), tokenFor(deadPid))
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } })).status, 0)
    assert.equal(existsSync(lockOf(dir)), false)
    const v = verifyHookChain(dir)
    assert.equal(v.ok, true)
    assert.equal(v.count, 2)
  })

  it('PR 8 review 1: a lock whose owner cannot be determined (other host, garbage) is never removed', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    for (const token of [`1 some-other-host ${'b'.repeat(16)}\n`, 'garbage\n']) {
      writeFileSync(lockOf(dir), token)
      assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } })).status, 2)
      assert.equal(readFileSync(lockOf(dir), 'utf8'), token)
    }
    rmSync(lockOf(dir))
  })

  it('PR 8 review 2: an append interrupted between receipt and anchor fails closed until an explicit reanchor', async () => {
    const { reanchorChain } = await import('../src/receipts/chain.js')
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    const anchorFile = anchorPath(operatorHome, CONTRACT.id, dir)
    const anchorBefore = readFileSync(anchorFile)
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } })).status, 0)
    // Simulate a crash after the receipt line was written but before the anchor moved.
    writeFileSync(anchorFile, anchorBefore)
    const v = verifyHookChain(dir)
    assert.equal(v.ok, false)
    assert.equal(v.findings[0].code, 'ANCHOR_BEHIND')
    // Fail closed: nothing is allowed while the chain is in this state.
    const blocked = run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'c' } }))
    assert.equal(blocked.status, 2)
    assert.equal(JSON.parse(blocked.stderr.trim()).category, 'RECEIPT_FAILED')
    // Recovery is an explicit operator act with a reason, and is itself a signed receipt.
    assert.throws(() => reanchorChain({ repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id, reason: '' }), /written reason/)
    const r = reanchorChain({ repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id, reason: 'hook crashed during append; receipt 1 reviewed' })
    assert.deepEqual(r.accepted_seqs, [1])
    const after = verifyHookChain(dir)
    assert.equal(after.ok, true, JSON.stringify(after.findings))
    assert.equal(after.receipts.at(-1).kind, 'chain_reanchored')
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'c' } })).status, 0)
  })

  it('PR 8 review 2: reanchor refuses a cut-off tail and a tampered receipt', async () => {
    const { reanchorChain } = await import('../src/receipts/chain.js')
    const dir = workspace()
    for (const p of ['a', 'b', 'c']) assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: p } })).status, 0)
    const file = chainPath(dir, CONTRACT.id)
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.trimEnd().split('\n').slice(0, 2).join('\n') + '\n') // tail removed: anchor ahead
    assert.throws(() => reanchorChain({ repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id, reason: 'attempted cover-up' }), /refused/)
    const bytes = Buffer.from(original)
    bytes[40] = bytes[40] ^ 1
    writeFileSync(file, bytes)
    assert.throws(() => reanchorChain({ repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id, reason: 'attempted cover-up' }), /refused/)
  })

  // Second review of PR 8 (commit 2107f76).
  it('PR 8 review 2.1: reanchor writes its receipt before moving the anchor; a crash in between is REANCHOR_PENDING', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    const anchorFile = anchorPath(operatorHome, CONTRACT.id, dir)
    const stale = readFileSync(anchorFile)
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } })).status, 0)
    writeFileSync(anchorFile, stale) // interrupted append: anchor behind
    const r = reanchorChain({ repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id, reason: 'hook crashed during append; receipt 1 reviewed' })
    assert.equal(r.completed_pending, false)
    const reanchor = verifyHookChain(dir).receipts.at(-1)
    assert.equal(reanchor.kind, 'chain_reanchored')
    assert.equal(reanchor.subject.previous_anchor_seq, 0)
    assert.match(reanchor.subject.previous_anchor_hash, /^sha256:[0-9a-f]{64}$/)

    // Crash between the two steps of the reanchor: receipt written, anchor not moved.
    writeFileSync(anchorFile, stale)
    const pending = verifyHookChain(dir)
    assert.equal(pending.ok, false)
    assert.deepEqual(pending.findings.map((f) => f.code), ['REANCHOR_PENDING'])
    assert.equal(pending.receipts.at(-1).kind, 'chain_reanchored', 'the intent is already signed and on record')
    const blocked = run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'c' } }))
    assert.equal(blocked.status, 2)
    assert.equal(JSON.parse(blocked.stderr.trim()).category, 'RECEIPT_FAILED')

    // Explicit completion: anchor moves onto the existing receipt, no second receipt.
    const done = reanchorChain({ repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id, reason: 'completing interrupted reanchor' })
    assert.equal(done.completed_pending, true)
    assert.deepEqual(done.accepted_seqs, [1])
    const after = verifyHookChain(dir)
    assert.equal(after.ok, true, JSON.stringify(after.findings))
    assert.equal(after.count, 3)
    assert.equal(after.receipts.filter((x) => x.kind === 'chain_reanchored').length, 1)
    assert.throws(() => reanchorChain({ repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id, reason: 'nothing left to do here' }), /nothing to reanchor/)
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'c' } })).status, 0)
  })

  it('PR 8 review 2.1: in every reachable state of a reanchor, the chain verifies only with the chain_reanchored receipt present', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    const anchorFile = anchorPath(operatorHome, CONTRACT.id, dir)
    const file = chainPath(dir, CONTRACT.id)
    const staleAnchor = readFileSync(anchorFile)
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } })).status, 0)
    writeFileSync(anchorFile, staleAnchor)
    const linesBefore = readFileSync(file)
    reanchorChain({ repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id, reason: 'hook crashed during append; receipt 1 reviewed' })
    const linesAfter = readFileSync(file)
    const newAnchor = readFileSync(anchorFile)
    // Every combination of {chain before/after the receipt} x {anchor before/after the move}.
    for (const [lines, anchor] of [[linesBefore, staleAnchor], [linesAfter, staleAnchor], [linesBefore, newAnchor], [linesAfter, newAnchor]]) {
      writeFileSync(file, lines)
      writeFileSync(anchorFile, anchor)
      const v = verifyHookChain(dir)
      if (v.ok) assert.equal(v.receipts.at(-1).kind, 'chain_reanchored')
    }
    // The only verifying state is the completed one.
    writeFileSync(file, linesBefore)
    writeFileSync(anchorFile, newAnchor)
    assert.equal(verifyHookChain(dir).findings[0].code, 'ANCHOR_AHEAD')
  })

  it('PR 8 review 2.2: an empty lock blocks the hook until an explicit, hash-bound, recorded recovery', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    writeFileSync(lockOf(dir), '') // what a crash between create and write used to leave
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } })).status, 2)
    const seen = inspectChainLock({ repoDir: dir, missionId: CONTRACT.id })
    assert.deepEqual({ exists: seen.exists, bytes: seen.bytes, owner: seen.owner }, { exists: true, bytes: 0, owner: 'unknown' })

    const args = { repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id }
    assert.throws(() => recoverLock({ ...args, expectedSha256: seen.sha256, reason: '' }), /written reason/)
    assert.throws(() => recoverLock({ ...args, reason: 'empty lock after crash' }), /pass the sha256/)
    assert.throws(() => recoverLock({ ...args, expectedSha256: 'sha256:' + '0'.repeat(64), reason: 'empty lock after crash' }), /changed since it was inspected/)
    assert.equal(readFileSync(lockOf(dir), 'utf8'), '', 'a refused recovery leaves the lock as it was')

    const r = recoverLock({ ...args, expectedSha256: seen.sha256, reason: 'empty lock after crash' })
    assert.equal(existsSync(lockOf(dir)), false)
    assert.equal(r.removed.removed_sha256, seen.sha256)
    assert.ok(existsSync(path.join(path.dirname(lockOf(dir)), r.removed.kept_as)), 'removed lock kept as evidence')
    const v = verifyHookChain(dir)
    assert.equal(v.ok, true, JSON.stringify(v.findings))
    const last = v.receipts.at(-1)
    assert.equal(last.kind, 'lock_recovered')
    assert.deepEqual([last.subject.removed_sha256, last.subject.kept_as], [seen.sha256, r.removed.kept_as])
    assert.equal(checkPolicy(v.receipts).ok, true)
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } })).status, 0)

    // Swapping the kept evidence breaks verification.
    writeFileSync(path.join(path.dirname(lockOf(dir)), r.removed.kept_as), 'something else\n')
    assert.deepEqual(verifyHookChain(dir).findings.map((f) => f.code), ['LOCK_RECOVERY_UNRECORDED'])
  })

  it('PR 8 review 2.2: recovery never removes the lock of a live local owner', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    writeFileSync(lockOf(dir), tokenFor(process.pid))
    const seen = inspectChainLock({ repoDir: dir, missionId: CONTRACT.id })
    assert.equal(seen.owner, 'alive')
    assert.throws(() => recoverLock({ repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id, expectedSha256: seen.sha256, reason: 'operator thinks it is stuck' }), /live process/)
    assert.equal(readFileSync(lockOf(dir), 'utf8'), tokenFor(process.pid))
    rmSync(lockOf(dir))
  })

  it('PR 8 review 2.2: a crash that leaves both a bad lock and an anchor behind is recovered in explicit steps, each recorded', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    const anchorFile = anchorPath(operatorHome, CONTRACT.id, dir)
    const stale = readFileSync(anchorFile)
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } })).status, 0)
    writeFileSync(anchorFile, stale)
    writeFileSync(lockOf(dir), 'garbage\n')
    const args = { repoDir: dir, keys: operatorKeys, missionId: CONTRACT.id }
    const seen = inspectChainLock(args)
    // Step 1: the lock is removed, but the receipt cannot be written to a chain that does not verify.
    assert.throws(() => recoverLock({ ...args, expectedSha256: seen.sha256, reason: 'garbage lock after crash' }), /reanchorChain/)
    assert.equal(existsSync(lockOf(dir)), false)
    assert.deepEqual(verifyHookChain(dir).findings.map((f) => f.code).sort(), ['ANCHOR_BEHIND', 'LOCK_RECOVERY_UNRECORDED'])
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'c' } })).status, 2)
    // Step 2: reanchor. Step 3: record the pending removal (no lock left, so no hash).
    reanchorChain({ ...args, reason: 'hook crashed during append; receipt 1 reviewed' })
    assert.deepEqual(verifyHookChain(dir).findings.map((f) => f.code), ['LOCK_RECOVERY_UNRECORDED'])
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'c' } })).status, 2)
    const r = recoverLock({ ...args, reason: 'garbage lock after crash' })
    assert.equal(r.removed, null)
    assert.equal(r.recorded.length, 1)
    const v = verifyHookChain(dir)
    assert.equal(v.ok, true, JSON.stringify(v.findings))
    assert.deepEqual(v.receipts.slice(-2).map((x) => x.kind), ['chain_reanchored', 'lock_recovered'])
    assert.throws(() => recoverLock({ ...args, reason: 'garbage lock after crash' }), /no lock to recover/)
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'c' } })).status, 0)
  })

  it('PR 8 review 2.2: a held lock always has its full owner token (never empty) and no temp files remain', () => {
    const dir = workspace()
    const lock = path.join(dir, 'probe.lock')
    for (let i = 0; i < 50; i++) {
      withLock(lock, () => assert.match(readFileSync(lock, 'utf8'), /^\d+ \S+ [0-9a-f]{16}\n$/))
    }
    assert.equal(existsSync(lock), false)
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('probe.lock')), [])
  })

  it('PR 8 review 3: decisions without a contract are marked unsigned diagnostics, and no chain is created', () => {
    const dir = workspace({ contract: null })
    const r = run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } }))
    assert.equal(r.status, 2)
    const out = JSON.parse(r.stderr.trim())
    assert.equal(out.category, 'NO_CONTRACT')
    assert.equal(out.signed, false)
    assert.equal(out.receipt_hash, null)
    const line = JSON.parse(readFileSync(path.join(dir, '.justrunme/audit.jsonl'), 'utf8').trim().split('\n').at(-1))
    assert.equal(line.evidence, 'unsigned_diagnostic')
    assert.equal(existsSync(path.join(dir, '.justrunme/missions')), false)
  })

  it('T16.1: a lock held by a live writer makes the hook wait and then deny, never write past it', () => {
    const dir = workspace()
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'a' } })).status, 0)
    const lock = chainPath(dir, CONTRACT.id) + '.lock'
    writeFileSync(lock, 'held\n') // fresh lock: not stale
    const started = Date.now()
    const r = run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } }))
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stderr.trim()).category, 'RECEIPT_FAILED')
    assert.ok(Date.now() - started >= 7000, 'waited for the lock')
    assert.equal(verifyHookChain(dir).count, 1)
    rmSync(lock)
    assert.equal(run(dir, ev({ tool_name: 'read_file', tool_input: { path: 'b' } })).status, 0)
    assert.equal(verifyHookChain(dir).count, 2)
  })

  it('fails closed on malformed stdin, empty stdin, missing contract and invalid contract', () => {
    const dir = workspace()
    assert.equal(run(dir, '{not json').status, 2)
    assert.equal(run(dir, '').status, 2)
    assert.equal(run(workspace({ contract: null }), ev({ tool_name: 'read_file', tool_input: {} })).status, 2)
    const bad = workspace()
    writeFileSync(path.join(bad, 'justrunme.mission.yaml'), 'id: x\n')
    assert.equal(run(bad, ev({ tool_name: 'read_file', tool_input: {} })).status, 2)
  })

  it('fails closed on a corrupt authorization file', () => {
    const dir = workspace()
    mkdirSync(path.join(dir, '.justrunme'), { recursive: true })
    writeFileSync(path.join(dir, '.justrunme/authorization.json'), '{broken')
    const r = run(dir, ev({ tool_name: 'fs_write', tool_input: { path: 'demo/src/a.js', text: '' } }))
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stderr.trim()).category, 'AUTHORIZATION_INVALID')
  })

  it('ships a PreToolUse hook definition that runs this entry point', () => {
    const def = JSON.parse(readFileSync(new URL('../.kiro/hooks/pretooluse.json', import.meta.url), 'utf8'))
    assert.equal(def.version, 'v1')
    assert.equal(def.hooks[0].trigger, 'PreToolUse')
    assert.equal(def.hooks[0].action.type, 'command')
    assert.match(def.hooks[0].action.command, /src\/hook\/pretooluse\.js/)
    assert.ok(existsSync(HOOK))
  })
})
