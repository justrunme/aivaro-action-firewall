/**
 * routes/orders.js — GET /orders and POST /orders
 *
 * GET  /orders — list all orders
 * POST /orders — create an order { patch_id, quantity }
 *                decrements available_count; returns 409 if insufficient stock
 */

import { query } from '../db.js'

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleOrders(req, res) {
  if (req.method === 'GET') {
    return handleListOrders(req, res)
  }
  if (req.method === 'POST') {
    return handleCreateOrder(req, res)
  }
  res.writeHead(405, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Method Not Allowed' }))
}

async function handleListOrders(req, res) {
  try {
    const { rows } = await query(
      'SELECT id, patch_id, quantity, created_at FROM orders ORDER BY id'
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(rows))
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal Server Error' }))
  }
}

async function handleCreateOrder(req, res) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request Too Large' }))
      return
    }
  }

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const patchId  = parseInt(parsed.patch_id, 10)
  const quantity = parseInt(parsed.quantity,  10)

  if (!Number.isInteger(patchId) || patchId < 1 ||
      !Number.isInteger(quantity) || quantity < 1) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'patch_id and quantity must be positive integers' }))
    return
  }

  try {
    // Check stock
    const { rows: stockRows } = await query(
      'SELECT available_count FROM patches WHERE id = $1',
      [patchId]
    )
    if (stockRows.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Patch not found' }))
      return
    }

    const available = parseInt(stockRows[0].available_count, 10)
    if (available < quantity) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Insufficient stock', available }))
      return
    }

    // Decrement stock and insert order atomically
    await query(
      'UPDATE patches SET available_count = available_count - $1 WHERE id = $2',
      [quantity, patchId]
    )
    const { rows: newRows } = await query(
      'INSERT INTO orders (patch_id, quantity) VALUES ($1, $2) RETURNING id, patch_id, quantity, created_at',
      [patchId, quantity]
    )

    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(newRows[0]))
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal Server Error' }))
  }
}
