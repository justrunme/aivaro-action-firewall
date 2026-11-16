/**
 * smoke.test.js
 *
 * Structural smoke tests — verify project scaffolding invariants without
 * requiring any production source to be implemented yet.
 *
 * Run: node --test test/smoke.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Helper: read a file relative to repo root.
function readRoot(rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}

// Helper: parse package.json once.
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readRoot('package.json'));

// ---------------------------------------------------------------------------
// package.json invariants
// ---------------------------------------------------------------------------

describe('package.json', () => {
  it('has "type": "module"', () => {
    assert.equal(pkg.type, 'module');
  });

  it('requires Node.js >= 24', () => {
    const engines = pkg.engines?.node ?? '';
    assert.match(engines, />=\s*24/, 'engines.node must require >= 24');
  });

  it('npm test script uses node --test', () => {
    assert.match(pkg.scripts?.test ?? '', /node --test/);
  });

  it('has no dependency versions with ^ or ~ (exact pins only)', () => {
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
    };
    for (const [name, version] of Object.entries(allDeps)) {
      assert.doesNotMatch(
        version,
        /^[\^~]/,
        `Dependency "${name}" uses a range specifier ("${version}"); exact pin required`
      );
    }
  });

  it('exports entry points do not reference dist/', () => {
    const exportsStr = JSON.stringify(pkg.exports ?? {});
    assert.doesNotMatch(exportsStr, /dist\//, 'exports must not reference dist/ at scaffold stage');
  });
});

// ---------------------------------------------------------------------------
// Spec files exist and are non-empty
// ---------------------------------------------------------------------------

describe('spec files', () => {
  const specDir = '.kiro/specs/kiro-action-firewall';
  const files = ['requirements.md', 'design.md', 'tasks.md'];

  for (const file of files) {
    it(`${specDir}/${file} exists and is non-empty`, () => {
      const p = path.join(root, specDir, file);
      assert.ok(existsSync(p), `${file} does not exist`);
      const content = readFileSync(p, 'utf8');
      assert.ok(content.trim().length > 0, `${file} is empty`);
    });
  }
});

// ---------------------------------------------------------------------------
// Steering files exist
// ---------------------------------------------------------------------------

describe('steering files', () => {
  const files = [
    '.kiro/steering/product.md',
    '.kiro/steering/engineering.md',
    '.kiro/steering/scope.md',
  ];

  for (const file of files) {
    it(`${file} exists`, () => {
      assert.ok(existsSync(path.join(root, file)), `${file} does not exist`);
    });
  }
});

// ---------------------------------------------------------------------------
// Agent definitions exist and are valid JSON
// ---------------------------------------------------------------------------

describe('agent definitions', () => {
  const agents = [
    '.kiro/agents/aivaro-builder.json',
    '.kiro/agents/aivaro-skeptic.json',
  ];

  for (const file of agents) {
    it(`${file} is valid JSON with required fields`, () => {
      const p = path.join(root, file);
      assert.ok(existsSync(p), `${file} does not exist`);
      const agent = JSON.parse(readFileSync(p, 'utf8'));
      assert.ok(typeof agent.name === 'string' && agent.name.length > 0, 'agent.name required');
      assert.ok(typeof agent.description === 'string', 'agent.description required');
      assert.ok(typeof agent.prompt === 'string' && agent.prompt.length > 0, 'agent.prompt required');
    });
  }

  it('aivaro-builder has read, write, and shell tools', () => {
    const agent = JSON.parse(readFileSync(path.join(root, '.kiro/agents/aivaro-builder.json'), 'utf8'));
    assert.ok(Array.isArray(agent.tools), 'tools must be an array');
    assert.ok(agent.tools.includes('read'), 'builder must include read tool');
    assert.ok(agent.tools.includes('write'), 'builder must include write tool');
    assert.ok(agent.tools.includes('shell'), 'builder must include shell tool');
  });

  it('aivaro-skeptic has only read-only tools (read, shell — no write)', () => {
    const agent = JSON.parse(readFileSync(path.join(root, '.kiro/agents/aivaro-skeptic.json'), 'utf8'));
    assert.ok(Array.isArray(agent.tools), 'tools must be an array');
    assert.ok(agent.tools.includes('read'), 'skeptic must include read tool');
    assert.ok(!agent.tools.includes('write'), 'skeptic must not include write tool');
  });

  it('agent definitions do not contain hardcoded absolute paths', () => {
    for (const file of ['.kiro/agents/aivaro-builder.json', '.kiro/agents/aivaro-skeptic.json']) {
      const content = readFileSync(path.join(root, file), 'utf8');
      assert.doesNotMatch(content, /\/Users\//, `${file} must not contain hardcoded /Users/ paths`);
    }
  });
});

// ---------------------------------------------------------------------------
// Hook definitions exist and are valid JSON (v1 format)
// ---------------------------------------------------------------------------

describe('hook definitions', () => {
  const hooks = [
    '.kiro/hooks/test-on-save.json',
    '.kiro/hooks/stop-checklist.json',
  ];

  for (const file of hooks) {
    it(`${file} is valid JSON with version and hooks array`, () => {
      const p = path.join(root, file);
      assert.ok(existsSync(p), `${file} does not exist`);
      const def = JSON.parse(readFileSync(p, 'utf8'));
      assert.equal(def.version, 'v1', 'hook file version must be "v1"');
      assert.ok(Array.isArray(def.hooks) && def.hooks.length > 0, 'hooks array must be non-empty');
      for (const hook of def.hooks) {
        assert.ok(typeof hook.name === 'string' && hook.name.length > 0, 'hook.name required');
        assert.ok(typeof hook.trigger === 'string' && hook.trigger.length > 0, 'hook.trigger required');
        assert.ok(typeof hook.action === 'object', 'hook.action required');
        assert.ok(typeof hook.action.type === 'string', 'hook.action.type required');
      }
    });
  }

  it('test-on-save uses PostFileSave trigger with a command action', () => {
    const def = JSON.parse(readFileSync(path.join(root, '.kiro/hooks/test-on-save.json'), 'utf8'));
    const hook = def.hooks[0];
    assert.equal(hook.trigger, 'PostFileSave');
    assert.equal(hook.action.type, 'command');
    assert.ok(typeof hook.action.command === 'string' && hook.action.command.includes('npm test'));
  });

  it('stop-checklist uses AgentStop trigger', () => {
    const def = JSON.parse(readFileSync(path.join(root, '.kiro/hooks/stop-checklist.json'), 'utf8'));
    const hook = def.hooks[0];
    assert.equal(hook.trigger, 'AgentStop');
  });
});

// ---------------------------------------------------------------------------
// requirements.md contains expected R-ID prefixes
// ---------------------------------------------------------------------------

describe('requirements.md content', () => {
  const content = readRoot('.kiro/specs/kiro-action-firewall/requirements.md');

  const expectedPrefixes = ['R-TG-', 'R-PE-', 'R-PK-', 'R-RC-', 'R-AL-', 'R-MCP-', 'R-JR-', 'R-NF-'];

  for (const prefix of expectedPrefixes) {
    it(`contains at least one ${prefix} requirement`, () => {
      assert.ok(content.includes(prefix), `No requirement with prefix "${prefix}" found`);
    });
  }

  it('contains a threat model section', () => {
    assert.ok(content.includes('Threat Model') || content.includes('threat model'), 'Threat model section missing');
  });
});

// ---------------------------------------------------------------------------
// tasks.md contains T-ID references and test mapping table
// ---------------------------------------------------------------------------

describe('tasks.md content', () => {
  const content = readRoot('.kiro/specs/kiro-action-firewall/tasks.md');

  it('contains T-ID task entries', () => {
    assert.match(content, /T-\d{2}-\d{2}/, 'No T-ID entries found');
  });

  it('contains test-to-requirement mapping', () => {
    assert.ok(
      content.includes('Test-to-requirement') || content.includes('test mapping') || content.includes('R-IDs covered'),
      'Test mapping table missing'
    );
  });
});

// ---------------------------------------------------------------------------
// CI workflow exists
// ---------------------------------------------------------------------------

describe('CI workflow', () => {
  it('.github/workflows/ci.yml exists', () => {
    assert.ok(
      existsSync(path.join(root, '.github/workflows/ci.yml')),
      '.github/workflows/ci.yml does not exist'
    );
  });
});

// ---------------------------------------------------------------------------
// KIRO_LOG.md exists
// ---------------------------------------------------------------------------

describe('docs/KIRO_LOG.md', () => {
  it('exists and contains bootstrap run entry', () => {
    const p = path.join(root, 'docs/KIRO_LOG.md');
    assert.ok(existsSync(p), 'docs/KIRO_LOG.md does not exist');
    const content = readFileSync(p, 'utf8');
    assert.ok(content.includes('2026-11-16'), 'Bootstrap run date not found in KIRO_LOG.md');
  });
});
