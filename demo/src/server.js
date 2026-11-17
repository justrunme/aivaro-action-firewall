/**
 * server.js — Pumpkin Patch Orders HTTP server
 *
 * Routes:
 *   GET  /health   — liveness + DB check (R12.1)
 *   GET  /patches  — list all pumpkin patches
 *   GET  /orders   — list all orders
 *   POST /orders   — create an order
 *
 * Start: node demo/src/server.js
 * Port:  PORT env var (default 3000)
 */

import { createServer } from 'node:http'
import { applyMigrations } from './db.js'
import { handleHealth }  from './routes/health.js'
import { handlePatches } from './routes/patches.js'
import { handleOrders }  from './routes/orders.js'

const PORT = parseInt(process.env.PORT || '3000', 10)

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  try {
    if (url.pathname === '/health') {
      return await handleHealth(req, res)
    }
    if (url.pathname === '/patches') {
      return await handlePatches(req, res)
    }
    if (url.pathname === '/orders') {
      return await handleOrders(req, res)
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not Found' }))
  } catch (err) {
    // Last-resort error handler — do not expose internal details
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal Server Error' }))
  }
})

async function main() {
  try {
    await applyMigrations()
  } catch (err) {
    // Log to stderr without exposing credential material
    process.stderr.write(`Migration error: ${err.message}\n`)
    process.exit(1)
  }

  server.listen(PORT, () => {
    process.stdout.write(`Pumpkin Patch Orders listening on port ${PORT}\n`)
  })
}

main()

export { server }
