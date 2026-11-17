/**
 * routes/patches.js — GET /patches
 *
 * Returns all pumpkin patches as a JSON array.
 */

import { query } from '../db.js'

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handlePatches(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method Not Allowed' }))
    return
  }

  try {
    const { rows } = await query(
      'SELECT id, name, location, available_count FROM patches ORDER BY id'
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(rows))
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal Server Error' }))
  }
}
