/**
 * Gate examples pack: destructive agent actions (git, files, database, secrets) and one
 * harmless read, fed as real PreToolUse events through runHook with JUSTRUNME_GATE=on
 * semantics (the gate is on when the hook is invoked), a temporary workspace without
 * spaces and NO authorization.
 *
 * These are gate decisions: the call is stopped before it runs. They are not
 * rehearsal measurements. The expected verdict and category of each case is what
 * src/hook/evaluate.js returns for it today; if the gate changes, this file shows it.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { runHook, AUDIT_FILE } from '../src/hook/run.js'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { verifyChain } from '../src/receipts/chain.js'

const CONTRACT = {
  id: 'mission-gate-examples',
  objective: 'Show the gate decisions for destructive agent actions',
  allowed_paths: ['demo/migrations/', 'demo/src/'],
  protected_tables: ['orders'],
  time_limit_seconds: 300,
  irreversible_actions: [],
  plan: [{ id: 'step-1', tool: 'shell', args: ['node', 'demo/migrations/run.js'], reversibility: true }],
  resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['app'] },
}

const GIT_CONFIG = '[core]\n\trepositoryformatversion = 0\n'
const HOOK_DEF = '{"version":"v1"}\n'

let dir
let operatorHome
let keys
let savedGate

before(() => {
  // Workspace and operator key directory are siblings in the temp directory, as in
  // scripts/agent-workspace.js. mkdtemp names contain no spaces.
  dir = mkdtempSync('/tmp/jrm-examples-')
  operatorHome = mkdtempSync('/tmp/jrm-examples-operator-')
  assert.doesNotMatch(dir, /\s/)
  mkdirSync(path.join(dir, 'demo/migrations'), { recursive: true })
  mkdirSync(path.join(dir, 'demo/src'), { recursive: true })
  mkdirSync(path.join(dir, '.git'), { recursive: true })
  mkdirSync(path.join(dir, '.kiro/hooks'), { recursive: true })
  writeFileSync(path.join(dir, 'demo/migrations/run.js'), "console.log('migrate')\n")
  writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"echo ok"}}\n')
  writeFileSync(path.join(dir, '.git/config'), GIT_CONFIG)
  writeFileSync(path.join(dir, '.kiro/hooks/pretooluse.json'), HOOK_DEF)
  writeFileSync(path.join(dir, 'justrunme.mission.yaml'), stringify(CONTRACT))
  keys = loadOrCreateKeys(operatorHome)
  savedGate = process.env.JUSTRUNME_GATE
  process.env.JUSTRUNME_GATE = 'on'
})

after(() => {
  if (savedGate === undefined) delete process.env.JUSTRUNME_GATE
  else process.env.JUSTRUNME_GATE = savedGate
  rmSync(dir, { recursive: true, force: true })
  rmSync(operatorHome, { recursive: true, force: true })
})

/** One real PreToolUse event through the actual hook runner. */
async function gate(toolName, toolInput) {
  const event = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: toolName, tool_input: toolInput })
  let stderr = ''
  const code = await runHook({
    stdin: Readable.from([Buffer.from(event)]),
    stderr: { write: (s) => { stderr += s } },
    cwd: dir,
    home: operatorHome,
  })
  const audit = readFileSync(path.join(dir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1)
  return { code, stderr, audit, out: stderr.trim() ? JSON.parse(stderr.trim()) : null }
}

const bash = (command) => ['execute_bash', { command }]

// Observed verdicts. Each category is what the gate returns for the case; a case that
// is not denied would be a finding, and these assertions would fail and show it.
const DESTRUCTIVE = [
  { group: 'git', name: 'git push --force origin main', call: bash('git push --force origin main'), category: 'NO_AUTHORIZATION' },
  { group: 'git', name: 'git reset --hard HEAD~3', call: bash('git reset --hard HEAD~3'), category: 'SHELL_METACHARACTER' },
  { group: 'git', name: 'git clean -fdx', call: bash('git clean -fdx'), category: 'NO_AUTHORIZATION' },
  { group: 'git', name: 'rm -rf .git', call: bash('rm -rf .git'), category: 'NO_AUTHORIZATION' },
  { group: 'git', name: 'write tool editing .git/config', call: ['fs_write', { path: '.git/config', text: '[core]\n' }], category: 'PROTECTED_PATH' },
  { group: 'git', name: 'git commit --no-verify', call: bash('git commit --no-verify'), category: 'NO_AUTHORIZATION' },
  { group: 'files', name: 'rm -rf demo/migrations', call: bash('rm -rf demo/migrations'), category: 'NO_AUTHORIZATION' },
  { group: 'files', name: 'delete tool on .kiro/hooks/pretooluse.json', call: ['delete_file', { path: '.kiro/hooks/pretooluse.json' }], category: 'PROTECTED_PATH' },
  { group: 'database', name: 'psql -c "DROP TABLE orders"', call: bash('psql -c "DROP TABLE orders"'), category: 'NO_AUTHORIZATION' },
  { group: 'database', name: 'psql -c "ALTER TABLE orders DISABLE TRIGGER ALL"', call: bash('psql -c "ALTER TABLE orders DISABLE TRIGGER ALL"'), category: 'NO_AUTHORIZATION' },
  { group: 'secrets', name: 'cat of the operator key directory', call: null, category: 'PROTECTED_PATH' },
  { group: 'secrets', name: 'list_directory of .. (contains the operator key directory)', call: ['list_directory', { path: '..' }], category: 'PROTECTED_PATH' },
]

describe('gate examples: destructive agent actions without authorization', () => {
  for (const c of DESTRUCTIVE) {
    it(`${c.group}: ${c.name} -> deny ${c.category}`, async () => {
      const [tool, input] = c.call ?? bash(`cat ${operatorHome}/operator.key`)
      const r = await gate(tool, input)
      assert.equal(r.code, 2, 'exit code 2 stops the call before it runs')
      assert.equal(r.out.justrunme, 'deny')
      assert.equal(r.out.category, c.category, r.out.reason)
      assert.equal(r.audit.decision, 'deny')
      assert.equal(r.audit.category, c.category)
      assert.equal(r.audit.evidence, 'signed_receipt')
      assert.equal(r.out.signed, true)
      assert.match(r.out.receipt_hash, /^sha256:[0-9a-f]{64}$/)
    })
  }

  it('the operator key directory itself is also refused as a shell argument', async () => {
    const r = await gate(...bash(`ls ${operatorHome}`))
    assert.equal(r.code, 2)
    assert.equal(r.out.category, 'PROTECTED_PATH')
  })
})

describe('gate examples: control and effects', () => {
  it('control: a harmless read inside the workspace is allowed', async () => {
    const r = await gate('read_file', { path: 'package.json' })
    assert.equal(r.code, 0)
    assert.equal(r.out, null)
    assert.equal(r.audit.decision, 'allow')
    assert.equal(r.audit.category, 'ALLOWED')
    assert.equal(r.audit.evidence, 'signed_receipt')
  })

  it('the gate stops calls, it does not run them: protected files are untouched', () => {
    assert.equal(readFileSync(path.join(dir, '.git/config'), 'utf8'), GIT_CONFIG)
    assert.equal(readFileSync(path.join(dir, '.kiro/hooks/pretooluse.json'), 'utf8'), HOOK_DEF)
    assert.equal(readFileSync(path.join(dir, 'demo/migrations/run.js'), 'utf8'), "console.log('migrate')\n")
    assert.ok(existsSync(path.join(operatorHome, 'operator.key')))
  })

  it('every decision above is a signed receipt in a chain that verifies: 13 deny, 1 allow', () => {
    const v = verifyChain({ repoDir: dir, home: operatorHome, publicKey: keys.publicKey, missionId: CONTRACT.id })
    assert.equal(v.ok, true, JSON.stringify(v.findings))
    assert.ok(v.receipts.every((r) => r.kind === 'hook_decision'))
    assert.equal(v.receipts.filter((r) => r.verdict === 'deny').length, DESTRUCTIVE.length + 1)
    assert.equal(v.receipts.filter((r) => r.verdict === 'allow').length, 1)
  })
})
