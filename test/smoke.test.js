/**
 * smoke.test.js
 *
 * Structural smoke tests — verify project scaffolding invariants without
 * requiring any production source to be implemented yet.
 *
 * Run: node --test test/smoke.test.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// Helper: read a file relative to repo root.
function readRoot(rel) {
  return readFileSync(path.join(root, rel), 'utf8')
}

// Helper: parse package.json once.
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readRoot('package.json'))

// ---------------------------------------------------------------------------
// package.json invariants
// ---------------------------------------------------------------------------

describe('package.json', () => {
  it('has "type": "module"', () => {
    assert.equal(pkg.type, 'module')
  })

  it('requires Node.js >= 24', () => {
    const engines = pkg.engines?.node ?? ''
    assert.match(engines, />=\s*24/, 'engines.node must require >= 24')
  })

  it('npm test script uses node --test', () => {
    assert.match(pkg.scripts?.test ?? '', /node --test/)
  })

  it('has no dependency versions with ^ or ~ (exact pins only)', () => {
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
    }
    for (const [name, version] of Object.entries(allDeps)) {
      assert.doesNotMatch(
        version,
        /^[\^~]/,
        `Dependency "${name}" uses a range specifier ("${version}"); exact pin required`
      )
    }
  })

  it('exports entry points do not reference dist/', () => {
    const exportsStr = JSON.stringify(pkg.exports ?? {})
    assert.doesNotMatch(exportsStr, /dist\//, 'exports must not reference dist/ at scaffold stage')
  })
})

// ---------------------------------------------------------------------------
// Spec files exist and are non-empty
// ---------------------------------------------------------------------------

describe('spec files', () => {
  const specDir = '.kiro/specs/justrunme-zero'
  const files = ['requirements.md', 'design.md', 'tasks.md']

  for (const file of files) {
    it(`${specDir}/${file} exists and is non-empty`, () => {
      const p = path.join(root, specDir, file)
      assert.ok(existsSync(p), `${file} does not exist`)
      const content = readFileSync(p, 'utf8')
      assert.ok(content.trim().length > 0, `${file} is empty`)
    })
  }
})

// ---------------------------------------------------------------------------
// Steering files exist
// ---------------------------------------------------------------------------

describe('steering files', () => {
  const files = [
    '.kiro/steering/product.md',
    '.kiro/steering/engineering.md',
    '.kiro/steering/scope.md',
  ]

  for (const file of files) {
    it(`${file} exists`, () => {
      assert.ok(existsSync(path.join(root, file)), `${file} does not exist`)
    })
  }
})

// ---------------------------------------------------------------------------
// Agent definitions exist and are valid JSON
// ---------------------------------------------------------------------------

describe('agent definitions', () => {
  const agents = [
    '.kiro/agents/justrunme-builder.json',
    '.kiro/agents/justrunme-skeptic.json',
  ]

  for (const file of agents) {
    it(`${file} is valid JSON with required fields`, () => {
      const p = path.join(root, file)
      assert.ok(existsSync(p), `${file} does not exist`)
      const agent = JSON.parse(readFileSync(p, 'utf8'))
      assert.ok(typeof agent.name === 'string' && agent.name.length > 0, 'agent.name required')
      assert.ok(typeof agent.description === 'string', 'agent.description required')
      assert.ok(typeof agent.prompt === 'string' && agent.prompt.length > 0, 'agent.prompt required')
    })
  }

  it('justrunme-builder has read, write, and shell tools', () => {
    const agent = JSON.parse(readFileSync(path.join(root, '.kiro/agents/justrunme-builder.json'), 'utf8'))
    assert.ok(Array.isArray(agent.tools), 'tools must be an array')
    assert.ok(agent.tools.includes('read'), 'builder must include read tool')
    assert.ok(agent.tools.includes('write'), 'builder must include write tool')
    assert.ok(agent.tools.includes('shell'), 'builder must include shell tool')
  })

  it('justrunme-skeptic has only read-only tools (no write, no shell)', () => {
    const agent = JSON.parse(readFileSync(path.join(root, '.kiro/agents/justrunme-skeptic.json'), 'utf8'))
    assert.ok(Array.isArray(agent.tools), 'tools must be an array')
    assert.ok(agent.tools.includes('read'), 'skeptic must include read tool')
    assert.ok(!agent.tools.includes('write'), 'skeptic must not include write tool')
    assert.ok(!agent.tools.includes('shell'), 'skeptic must not include shell tool')
  })

  it('justrunme-skeptic prompt covers all six review categories', () => {
    const agent = JSON.parse(readFileSync(path.join(root, '.kiro/agents/justrunme-skeptic.json'), 'utf8'))
    const prompt = agent.prompt
    assert.ok(prompt.includes('BYPASS VECTORS'), 'skeptic prompt must list BYPASS VECTORS category')
    assert.ok(prompt.includes('FALSE CLAIMS'), 'skeptic prompt must list FALSE CLAIMS category')
    assert.ok(prompt.includes('NAMING VIOLATIONS'), 'skeptic prompt must list NAMING VIOLATIONS category')
    assert.ok(prompt.includes('SCOPE CREEP'), 'skeptic prompt must list SCOPE CREEP category')
    assert.ok(prompt.includes('PRIVACY LEAKS'), 'skeptic prompt must list PRIVACY LEAKS category')
    assert.ok(prompt.includes('CODE ORIGIN'), 'skeptic prompt must list CODE ORIGIN category')
  })

  it('justrunme-skeptic prompt names specific bypass vectors (R10.2, R10.3, R10.4)', () => {
    const agent = JSON.parse(readFileSync(path.join(root, '.kiro/agents/justrunme-skeptic.json'), 'utf8'))
    const prompt = agent.prompt
    // R10.2 — inline interpreter
    assert.ok(
      prompt.includes('inline interpreter') || prompt.includes('INLINE_INTERPRETER'),
      'skeptic must check for inline interpreter bypass (R10.2)'
    )
    // R10.3 — undeclared script
    assert.ok(
      prompt.includes('undeclared script') || prompt.includes('UNDECLARED_SCRIPT'),
      'skeptic must check for undeclared script bypass (R10.3)'
    )
    // R10.4 — MCP re-entry
    assert.ok(
      prompt.includes('MCP re-entry') || prompt.includes('MCP_REENTRY') || prompt.includes('re-entr'),
      'skeptic must check for MCP re-entry bypass (R10.4)'
    )
  })

  it('agent definitions do not contain hardcoded absolute paths', () => {
    for (const file of ['.kiro/agents/justrunme-builder.json', '.kiro/agents/justrunme-skeptic.json']) {
      const content = readFileSync(path.join(root, file), 'utf8')
      assert.doesNotMatch(content, /\/Users\//, `${file} must not contain hardcoded /Users/ paths`)
      assert.doesNotMatch(content, /\/home\//, `${file} must not contain hardcoded /home/ paths`)
    }
  })
})

// ---------------------------------------------------------------------------
// Hook definitions exist and are valid JSON (v1 format)
// ---------------------------------------------------------------------------

describe('hook definitions', () => {
  const hooks = [
    '.kiro/hooks/test-on-save.json',
    '.kiro/hooks/stop-checklist.json',
  ]

  for (const file of hooks) {
    it(`${file} is valid JSON with version and hooks array`, () => {
      const p = path.join(root, file)
      assert.ok(existsSync(p), `${file} does not exist`)
      const def = JSON.parse(readFileSync(p, 'utf8'))
      assert.equal(def.version, 'v1', 'hook file version must be "v1"')
      assert.ok(Array.isArray(def.hooks) && def.hooks.length > 0, 'hooks array must be non-empty')
      for (const hook of def.hooks) {
        assert.ok(typeof hook.name === 'string' && hook.name.length > 0, 'hook.name required')
        assert.ok(typeof hook.trigger === 'string' && hook.trigger.length > 0, 'hook.trigger required')
        assert.ok(typeof hook.action === 'object', 'hook.action required')
        assert.ok(typeof hook.action.type === 'string', 'hook.action.type required')
      }
    })
  }

  it('test-on-save uses PostFileSave trigger with a command action', () => {
    const def = JSON.parse(readFileSync(path.join(root, '.kiro/hooks/test-on-save.json'), 'utf8'))
    const hook = def.hooks[0]
    assert.equal(hook.trigger, 'PostFileSave')
    assert.equal(hook.action.type, 'command')
    assert.ok(typeof hook.action.command === 'string' && hook.action.command.includes('npm test'))
  })

  it('stop-checklist uses the documented Stop trigger and references justrunme-zero tasks.md', () => {
    const def = JSON.parse(readFileSync(path.join(root, '.kiro/hooks/stop-checklist.json'), 'utf8'))
    const hook = def.hooks[0]
    // kiro.dev/docs/hooks lists "Stop" as the JSON trigger name (UI label: Agent Stop)
    assert.equal(hook.trigger, 'Stop')
    // The stop prompt must reference the JustRunMe spec path, not the old firewall path
    const promptText = JSON.stringify(hook.action)
    assert.ok(
      promptText.includes('justrunme-zero'),
      'stop-checklist must reference justrunme-zero spec path, not kiro-action-firewall'
    )
  })
})

// ---------------------------------------------------------------------------
// requirements.md — JustRunMe R-IDs (R1–R12) and EARS format
// ---------------------------------------------------------------------------

describe('requirements.md content', () => {
  const content = readRoot('.kiro/specs/justrunme-zero/requirements.md')

  // All twelve top-level requirement groups must be present
  const topLevelIds = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16']
  for (const id of topLevelIds) {
    it(`contains ${id} requirement section`, () => {
      assert.ok(
        content.includes(`## ${id} —`) || content.includes(`## ${id}—`) || content.includes(`**${id}.`),
        `No requirement section for ${id} found`
      )
    })
  }

  // Core JustRunMe sub-IDs that must be present
  const requiredIds = [
    'R1.1', 'R1.4', 'R1.5',  // contract parsing and gate enforcement
    'R2.1', 'R2.3', 'R2.5',  // rehearsal, impact report, cleanup
    'R3.1', 'R3.2', 'R3.3',  // fidelity fingerprint, re-check, mismatch block
    'R4.1', 'R4.3', 'R4.6',  // undo capture, restore, unsupported type rejection
    'R5.1', 'R5.5', 'R5.6',  // recovery verification pass/fail receipts
    'R6.1', 'R6.3', 'R6.5',  // irreversible flag, WebAuthn challenge, assertion fail
    'R7.1', 'R7.2', 'R7.3',  // Ed25519 receipt, hash chain append, chain verify
    'R8.1', 'R8.2', 'R8.4',  // judge mode re-verify, < 60 s, structured report
    'R9.1', 'R9.3',           // MCP tools list, MCP approval gate
    'R10.2', 'R10.3', 'R10.4', 'R10.5', // bypass categories and exit 2
    'R11.1', 'R11.2',         // privacy: no paths or emails in artifacts
    'R12.1', 'R12.3',         // demo health endpoint, compose teardown
  ]

  for (const id of requiredIds) {
    it(`contains requirement ${id}`, () => {
      assert.ok(content.includes(`**${id}**`) || content.includes(`${id} `), `Requirement ${id} not found`)
    })
  }

  it('requirements use EARS format (WHEN … THE SYSTEM SHALL)', () => {
    assert.ok(
      content.includes('WHEN') && content.includes('THE SYSTEM SHALL'),
      'requirements.md must use EARS format (WHEN … THE SYSTEM SHALL)'
    )
  })

  it('contains a threat model section', () => {
    assert.ok(
      content.includes('Threat Model') || content.includes('threat model'),
      'Threat model section missing'
    )
  })

  it('threat model names specific bypass vectors', () => {
    // R10.2 / R10.3 / R10.4 vectors must be named
    assert.ok(content.includes('inline interpreter') || content.includes('INLINE_INTERPRETER'), 'inline interpreter vector missing from threat model')
    assert.ok(content.includes('undeclared script') || content.includes('UNDECLARED_SCRIPT') || content.includes('shell script'), 'undeclared script vector missing from threat model')
    assert.ok(content.includes('MCP') && (content.includes('re-entr') || content.includes('re-entry') || content.includes('second MCP')), 'MCP re-entry vector missing from threat model')
  })

  it('fidelity requirements name fingerprint components (R3.1)', () => {
    assert.ok(content.includes('git HEAD') || content.includes('commit SHA'), 'R3.1 must name git HEAD as a fingerprint component')
    assert.ok(content.includes('row count') || content.includes('row counts'), 'R3.1 must name Postgres row counts as a fingerprint component')
    assert.ok(content.includes('schema hash'), 'R3.1 must name schema hash as a fingerprint component')
    assert.ok(content.includes('image digest') || content.includes('image digests'), 'R3.1 must name Docker image digests as a fingerprint component')
  })

  it('undo explicitly limits supported resource types (R4.6)', () => {
    // R4.6 must state which resource types are supported for undo
    assert.ok(content.includes('R4.6') || content.includes('not supported'), 'R4.6 unsupported resource type rejection missing')
    assert.ok(
      content.includes('tracked git') || content.includes('Postgres databases') || content.includes('config file'),
      'undo resource types must be named explicitly'
    )
  })

  it('does not use banned JustRunMe naming terms for our own features', () => {
    // These terms must not appear as names for JustRunMe features
    // (They may appear in comparisons to Kiro's own features, so we check for
    // feature headings / section titles only)
    const bannedHeadings = ['# Checkpoint', '# Snapshot', '# Rewind', '# Time Machine', '# Mission Control']
    for (const heading of bannedHeadings) {
      assert.ok(!content.includes(heading), `Banned feature heading "${heading}" found in requirements.md`)
    }
  })
})

// ---------------------------------------------------------------------------
// tasks.md — T12–T20 queue and test mapping
// ---------------------------------------------------------------------------

describe('tasks.md content', () => {
  const content = readRoot('.kiro/specs/justrunme-zero/tasks.md')

  it('contains T12–T20 milestone task entries', () => {
    for (const milestone of ['T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T18', 'T19', 'T20']) {
      assert.ok(content.includes(`## ${milestone}`), `Milestone ${milestone} missing from tasks.md`)
    }
  })

  it('contains sub-task IDs in T-NN.N format', () => {
    assert.match(content, /T1[2-9]\.\d/, 'No T12–T19 sub-task IDs found')
  })

  it('tasks reference JustRunMe R-IDs (R1–R12)', () => {
    // At least some tasks must cite R-IDs in the R-NN.N form
    assert.match(content, /R\d+\.\d+/, 'No R-NN.N requirement IDs found in tasks.md')
  })

  it('contains test-to-requirement mapping table', () => {
    assert.ok(
      content.includes('Test-to-Requirement') || content.includes('Test-to-requirement') || content.includes('R-IDs covered'),
      'Test-to-requirement mapping table missing from tasks.md'
    )
  })

  it('mapping table covers key test files', () => {
    const keyTestFiles = [
      'test/contract.test.js',
      'test/fidelity.test.js',
      'test/undo.test.js',
      'test/receipts.test.js',
      'test/hook.test.js',
    ]
    for (const f of keyTestFiles) {
      assert.ok(content.includes(f), `${f} missing from test-to-requirement mapping`)
    }
  })
})

// ---------------------------------------------------------------------------
// CI workflow exists
// ---------------------------------------------------------------------------

describe('CI workflow', () => {
  it('.github/workflows/ci.yml exists', () => {
    assert.ok(
      existsSync(path.join(root, '.github/workflows/ci.yml')),
      '.github/workflows/ci.yml does not exist'
    )
  })
})

// ---------------------------------------------------------------------------
// KIRO_LOG.md exists and contains entries
// ---------------------------------------------------------------------------

describe('docs/KIRO_LOG.md', () => {
  it('exists and contains bootstrap run entry', () => {
    const p = path.join(root, 'docs/KIRO_LOG.md')
    assert.ok(existsSync(p), 'docs/KIRO_LOG.md does not exist')
    const content = readFileSync(p, 'utf8')
    assert.ok(content.includes('2026-11-16'), 'Bootstrap run date not found in KIRO_LOG.md')
  })

  it('contains a task 11 JustRunMe entry', () => {
    const content = readFileSync(path.join(root, 'docs/KIRO_LOG.md'), 'utf8')
    assert.ok(
      content.includes('justrunme-zero') || content.includes('JustRunMe'),
      'KIRO_LOG.md must contain a JustRunMe / task 11 session entry'
    )
  })

  it('log does not contain hardcoded home-directory paths', () => {
    const content = readFileSync(path.join(root, 'docs/KIRO_LOG.md'), 'utf8')
    assert.doesNotMatch(content, /\/Users\/[a-zA-Z]/, 'KIRO_LOG.md must not contain /Users/<name> paths')
    assert.doesNotMatch(content, /\/home\/[a-zA-Z]/, 'KIRO_LOG.md must not contain /home/<name> paths')
  })
})
