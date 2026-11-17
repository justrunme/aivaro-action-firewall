import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { stringify } from 'yaml'
import { parseContract } from '../src/contract/parser.js'
import { evaluate } from '../src/hook/evaluate.js'
import { hashScript } from '../src/hook/allowlist.js'
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

  it('never lets the agent write the gate, its inputs or git metadata', () => {
    const ctx = context(workspace())
    for (const p of ['.justrunme/authorization.json', 'justrunme.mission.yaml', '.kiro/hooks/pretooluse.json', '.git/config', 'src/hook/evaluate.js']) {
      assert.equal(evaluate(write(p), ctx).category, p.startsWith('src/') ? 'PROTECTED_PATH' : 'PROTECTED_PATH', p)
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
  function run(dir, input, { gate = 'on' } = {}) {
    const env = { ...process.env }
    delete env.JUSTRUNME_GATE
    if (gate !== null) env.JUSTRUNME_GATE = gate
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

  it('exits 0 for the rehearsed command with an authorization file and 2 after the script changes', () => {
    const dir = workspace()
    const ctx = context(dir, { entries: [migrateEntry(dir)] })
    mkdirSync(path.join(dir, '.justrunme'), { recursive: true })
    const auth = { ...ctx.authorization, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 120000).toISOString() }
    writeFileSync(path.join(dir, '.justrunme/authorization.json'), JSON.stringify(auth))
    const call = ev({ tool_name: 'execute_bash', tool_input: { command: 'node demo/migrations/run.js' } })
    assert.equal(run(dir, call).status, 0)
    writeFileSync(path.join(dir, 'demo/migrations/run.js'), 'console.log(1)\n')
    const r = run(dir, call)
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stderr.trim()).category, 'SCRIPT_CHANGED')
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
