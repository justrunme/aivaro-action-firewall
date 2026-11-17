/**
 * A minimal MCP client over stdio for tests: newline-delimited JSON-RPC 2.0, just
 * enough to initialize, list tools and call them. It is independent of the SDK the
 * server uses, so a test also shows that a plain MCP client can talk to the server.
 */

import { spawn } from 'node:child_process'

export function startServer({ cwd, env, entry }) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const lines = []
  const stderr = []
  let buffer = ''
  let nextId = 1
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      if (line.trim() === '') continue
      lines.push(line)
      const msg = JSON.parse(line) // a line that is not JSON fails the test: stdout is protocol only
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  child.stderr.on('data', (d) => stderr.push(String(d)))
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 300000)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      send({ jsonrpc: '2.0', id, method, params })
    })
  return {
    lines,
    stderr,
    async initialize() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jrm-test', version: '0' } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      return r
    },
    listTools: async () => (await request('tools/list', {})).result.tools,
    /** @returns {Promise<{ isError: boolean, payload: any, raw: any }>} */
    async call(name, args = {}) {
      const msg = await request('tools/call', { name, arguments: args })
      if (msg.error) return { isError: true, payload: null, raw: msg }
      const text = msg.result.content?.[0]?.text
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { text }
      }
      return { isError: msg.result.isError === true, payload, raw: msg }
    },
    close() {
      child.stdin.end()
      child.kill('SIGTERM')
    },
  }
}
