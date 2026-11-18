/**
 * T24: the justrunme-operator agent is a Kiro CLI v3 agent (no V2-only fields, so
 * the v3 engine loads it; Run 20 found that `allowedTools` without `permissions`
 * makes `kiro-cli chat --v3 --agent` stop with exit 4), it reaches only the
 * JustRunMe MCP server, has no shell, and may write only migration files.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_TOOLS, SERVER_NAME } from '../src/mcp/names.js'

const agent = JSON.parse(readFileSync(new URL('../.kiro/agents/justrunme-operator.json', import.meta.url), 'utf8'))
const steering = readFileSync(new URL('../.kiro/steering/operator-loop.md', import.meta.url), 'utf8')
const V2_ONLY = ['allowedTools', 'toolsSettings', 'toolAliases', 'keyboardShortcut', 'kiroUpgrade']

describe('justrunme-operator agent (T24)', () => {
  it('uses only v3 fields and declares permissions', () => {
    for (const k of V2_ONLY) assert.equal(k in agent, false, `${k} is a V2-only field`)
    assert.ok(Array.isArray(agent.permissions?.rules) && agent.permissions.rules.length > 0)
  })

  it('reaches exactly the JustRunMe server, from its own config, with no shell', () => {
    assert.deepEqual(Object.keys(agent.mcpServers), [SERVER_NAME])
    assert.deepEqual(agent.mcpServers[SERVER_NAME], { command: 'node', args: ['src/mcp/server.js'] })
    assert.equal(agent.includeMcpJson, false)
    assert.equal(agent.includePowers, false)
    assert.deepEqual(agent.tools.sort(), ['@justrunme', 'read', 'write'])
    assert.ok(agent.excludedTools.includes('shell'))
    const rule = (cap) => agent.permissions.rules.filter((r) => r.capability === cap)
    assert.deepEqual(rule('shell').map((r) => r.effect), ['deny'])
    assert.deepEqual(rule('mcp'), [{ capability: 'mcp', match: [`${SERVER_NAME}/*`], effect: 'allow' }])
    assert.deepEqual(rule('fs_write'), [{ capability: 'fs_write', match: ['demo/migrations/**'], effect: 'allow' }])
  })

  it('the steering names only tools the server has, and tells the agent it cannot approve', () => {
    const named = [...steering.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => /^(rehearse|get_impact_report|compare|request_approval|run_mission|get_receipt|undo_mission|verify_recovery|replay_mission|approve)$/.test(n))
    for (const n of named) assert.ok(AGENT_TOOLS.includes(n), `steering names ${n}`)
    assert.match(steering, /cannot approve/)
    assert.match(agent.prompt, /cannot approve/)
  })
})
