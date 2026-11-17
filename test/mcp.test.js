/**
 * T21: the JustRunMe MCP server over stdio, without Docker. A plain JSON-RPC
 * client (test/support/mcp-stdio.js) talks to the real server process.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { loadOrCreateKeys } from '../src/receipts/keys.js'
import { appendReceipt } from '../src/receipts/chain.js'
import { ATTEMPT_LIMIT } from '../src/explain/remediation.js'
import { AGENT_TOOLS } from '../src/mcp/names.js'
import { TOOLS } from '../src/mcp/tools.js'
import { plansDir } from '../src/mission/plans.js'
import { startServer } from './support/mcp-stdio.js'

const ENTRY = new URL('../src/mcp/server.js', import.meta.url).pathname
const MISSION = {
  id: 'mission-mcp-test',
  objective: 'Exercise the MCP server in a temporary workspace',
  allowed_paths: ['demo/migrations/'],
  protected_tables: ['orders'],
  time_limit_seconds: 300,
  irreversible_actions: [],
  plan: [{ id: 'placeholder', tool: 'sql_migration', args: ['demo/migrations/001_init.sql'], reversibility: true }],
  resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] },
}

describe('attempt limit (T22)', () => {
  it('stops rehearsing after too many attempts without an authorized run, and a run resets the count', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jrm-mcp-limit-'))
    const keyDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-mcp-limit-keys-'))
    const saved = process.env.JUSTRUNME_HOME
    process.env.JUSTRUNME_HOME = keyDir
    try {
      mkdirSync(path.join(dir, 'demo/migrations'), { recursive: true })
      writeFileSync(path.join(dir, 'demo/migrations/003_a.sql'), 'SELECT 2;\n')
      writeFileSync(path.join(dir, 'justrunme.mission.yaml'), stringify(MISSION))
      const keys = loadOrCreateKeys(keyDir)
      const rehearsal = (n) => appendReceipt({ repoDir: dir, keys, missionId: MISSION.id, kind: 'rehearsal', verdict: 'DATA LOSS', subject: { plan_id: `plan-${String(n).padStart(12, '0')}` } })
      const tool = TOOLS.find((t) => t.name === 'rehearse')
      for (let i = 0; i < ATTEMPT_LIMIT; i += 1) rehearsal(i)
      const r = await tool.run({ repoDir: dir }, { migrations: ['demo/migrations/003_a.sql'] })
      assert.deepEqual([r.status, r.reason, r.next_action], ['DENIED', 'ATTEMPT_LIMIT', 'ASK_OPERATOR'])
      assert.deepEqual(r.attempts, { used: ATTEMPT_LIMIT, limit: ATTEMPT_LIMIT })
      assert.ok(!existsSync(plansDir(dir, MISSION.id)), 'no plan is stored once the limit is reached')
      appendReceipt({ repoDir: dir, keys, missionId: MISSION.id, kind: 'run_result', verdict: 'completed', subject: {} })
      // After a run the count starts again: the limit no longer applies (the call proceeds to the target check, not to ATTEMPT_LIMIT).
      const after = await tool.run({ repoDir: dir }, { migrations: ['demo/migrations/003_a.sql'] })
      assert.notEqual(after.reason, 'ATTEMPT_LIMIT')
    } finally {
      if (saved === undefined) delete process.env.JUSTRUNME_HOME
      else process.env.JUSTRUNME_HOME = saved
      rmSync(dir, { recursive: true, force: true })
      rmSync(keyDir, { recursive: true, force: true })
    }
  })
})

describe('MCP server over stdio (T21)', () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-mcp-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'jrm-mcp-keys-'))
  let server

  before(async () => {
    mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
    writeFileSync(path.join(repoDir, 'demo/migrations/001_init.sql'), 'SELECT 1;\n')
    writeFileSync(path.join(repoDir, 'demo/migrations/003_a.sql'), 'SELECT 2;\n')
    writeFileSync(path.join(repoDir, 'justrunme.mission.yaml'), stringify(MISSION))
    loadOrCreateKeys(home)
    server = startServer({ cwd: repoDir, entry: ENTRY, env: { PATH: process.env.PATH, HOME: os.tmpdir(), JUSTRUNME_HOME: home } })
    await server.initialize()
  })

  after(() => {
    server.close()
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('announces itself as justrunme and offers tools that are agent tools, none that authorize or approve', async () => {
    const tools = await server.listTools()
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, TOOLS.map((t) => t.name).sort())
    assert.deepEqual(names, [...AGENT_TOOLS].sort(), 'the server and the hook allowlist must name the same tools')
    assert.ok(!names.some((n) => /authoriz|approve|key|sign/.test(n)))
  })

  it('takes no connection parameter, host, database, shell command or key: every input schema is closed and plain', async () => {
    for (const tool of await server.listTools()) {
      const schema = tool.inputSchema
      assert.equal(schema.type, 'object')
      assert.equal(schema.additionalProperties, false, `${tool.name} must reject unknown arguments`)
      for (const key of Object.keys(schema.properties ?? {})) {
        assert.doesNotMatch(key, /conn|dsn|host|url|database|db|command|shell|key|secret|password|token|step|tool/i, `${tool.name}.${key}`)
      }
    }
  })

  it('rejects an unknown argument such as a connection string', async () => {
    const r = await server.call('rehearse', { migrations: ['demo/migrations/003_a.sql'], connection_string: 'postgres://u:p@prod.example/db' })
    assert.equal(r.isError, true)
    assert.ok(!existsSync(plansDir(repoDir, MISSION.id)), 'nothing was stored for a rejected call')
  })

  it('refuses a migration outside the mission, with a structured error and no stored plan', async () => {
    for (const [migrations, code] of [[['../../etc/passwd'], 'MIGRATION_INVALID'], [['demo/migrations/missing.sql'], 'MIGRATION_NOT_FOUND'], [['README.md'], 'MIGRATION_INVALID']]) {
      const r = await server.call('rehearse', { migrations })
      assert.equal(r.isError, true)
      assert.deepEqual([r.payload.status, r.payload.error.code], ['REFUSED', code])
    }
    assert.ok(!existsSync(plansDir(repoDir, MISSION.id)))
  })

  it('has no tool for authorizing or approving, and says so for an unknown tool', async () => {
    for (const name of ['authorize', 'approve', 'keys_init', 'sign']) {
      const r = await server.call(name, {})
      assert.equal(r.isError, true, name)
    }
  })

  it('answers a read of an empty mission with a structured refusal, not a crash, and keeps paths private', async () => {
    const r = await server.call('get_receipt', {})
    assert.equal(r.isError, true)
    assert.equal(r.payload.status, 'REFUSED')
    const all = JSON.stringify(r.payload)
    assert.ok(!all.includes(repoDir) && !all.includes(home))
  })

  it('handles calls that arrive together one after the other', async () => {
    const results = await Promise.all([server.call('get_receipt', {}), server.call('replay_mission', {}), server.call('get_receipt', { seq: 0 })])
    assert.equal(results.length, 3)
    assert.ok(results.every((r) => r.payload?.status === 'REFUSED'))
  })

  it('writes only protocol messages to stdout and nothing alarming to stderr', () => {
    assert.ok(server.lines.length >= 5)
    assert.doesNotMatch(server.stderr.join(''), /Error|TypeError|stack/i)
  })
})
