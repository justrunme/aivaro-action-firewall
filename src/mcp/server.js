#!/usr/bin/env node
/**
 * JustRunMe MCP server (stdio). Started by Kiro from the workspace root with the
 * operator's .kiro/settings/mcp.json:
 *
 *   { "mcpServers": { "justrunme": { "command": "node", "args": ["src/mcp/server.js"] } } }
 *
 * The protocol is the official MCP SDK's; the behaviour is src/mcp/tools.js.
 * stdout carries the protocol, so nothing else may write to it. Tool calls are
 * handled one at a time: they all write to the same signed receipt chain.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { SERVER_NAME } from './names.js'
import { TOOLS, sanitize } from './tools.js'

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

/** @param {{ repoDir?: string }} [options] */
export function createServer({ repoDir = realpathSync(process.cwd()) } = {}) {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION })
  let queue = Promise.resolve()
  const text = (payload, isError) => ({ content: [{ type: 'text', text: JSON.stringify(sanitize(payload, repoDir)) }], isError })

  for (const tool of TOOLS) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }, (args) => {
      const turn = queue.then(async () => {
        try {
          const payload = await tool.run({ repoDir }, args)
          return text(payload, payload.status === 'REFUSED')
        } catch (err) {
          return text({ status: 'ERROR', error: { code: 'INTERNAL', message: String(err?.message ?? err).split('\n')[0] } }, true)
        }
      })
      queue = turn.then(() => undefined, () => undefined)
      return turn
    })
  }
  return server
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntry) await createServer().connect(new StdioServerTransport())
