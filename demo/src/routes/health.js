/**
 * routes/health.js — GET /health
 *
 * Returns 200 { status: "ok", db: "ok" } when the DB is reachable,
 * or 503 { status: "degraded", db: "unreachable" } when it is not.
 * Satisfies R12.1.
 */

import { ping } from '../db.js'

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleHealth(req, res) {
  const dbOk = await ping()
  const status = dbOk ? 200 : 503
  const body = JSON.stringify({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'unreachable',
  })
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}
