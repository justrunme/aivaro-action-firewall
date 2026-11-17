/**
 * demo/integration.test.js
 *
 * Integration test for the Pumpkin Patch Orders demo stack.
 * Satisfies R12.1, R12.2, R12.3.
 *
 * Requirements:
 *   - Docker and docker compose (v2 plugin) must be available.
 *   - Runs only on Linux; skipped automatically on macOS and Windows.
 *
 * Run: node --test demo/integration.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DEMO_DIR = __dirname

// Unique project name prevents port collisions when tests run in parallel
const PROJECT = `jrm-demo-test-${Date.now()}`
const BASE_URL = 'http://localhost:3000'

// ---------------------------------------------------------------------------
// Skip on non-Linux platforms (engineering.md: Docker tests Linux-only)
// ---------------------------------------------------------------------------

const isLinux = process.platform === 'linux'

if (!isLinux) {
  // Emit a single skipped test so the runner reports something useful
  describe('demo integration (skipped — Linux only)', () => {
    it('skipped on non-Linux platform', { skip: 'Docker integration tests run on Linux only' }, () => {})
  })
} else {
  describe('demo integration', () => {
    before(async () => {
      // Bring up the stack with the unique project name
      await execFileAsync('docker', [
        'compose',
        '--project-name', PROJECT,
        '--file', join(DEMO_DIR, 'docker-compose.yml'),
        'up', '--detach', '--wait',
      ], { timeout: 120_000 })

      // Poll /health with exponential back-off until 200 or 30 s
      await waitForHealth(BASE_URL + '/health', 30_000)
    })

    after(async () => {
      // Tear down and remove volumes — leave nothing behind (R12.3)
      await execFileAsync('docker', [
        'compose',
        '--project-name', PROJECT,
        '--file', join(DEMO_DIR, 'docker-compose.yml'),
        'down', '--volumes', '--remove-orphans',
      ], { timeout: 60_000 }).catch(() => {
        // Best-effort cleanup; do not mask test failures
      })
    })

    it('GET /health returns 200 with { status: "ok", db: "ok" }', async () => {
      const res = await fetchJson(BASE_URL + '/health')
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { status: 'ok', db: 'ok' })
    })

    it('GET /patches returns exactly 5 seed rows (R12.2)', async () => {
      const res = await fetchJson(BASE_URL + '/patches')
      assert.equal(res.status, 200)
      assert.equal(res.body.length, 5, 'Expected exactly 5 patches from seed data')
    })

    it('GET /orders returns exactly 3 seed rows (R12.2)', async () => {
      const res = await fetchJson(BASE_URL + '/orders')
      assert.equal(res.status, 200)
      assert.equal(res.body.length, 3, 'Expected exactly 3 orders from seed data')
    })

    it('POST /orders creates an order and decrements stock', async () => {
      // Patch 3 starts with 60 units; order 5 of them
      const before = await fetchJson(BASE_URL + '/patches')
      const patch3Before = before.body.find(p => p.id === '3' || p.id === 3)
      const stockBefore = parseInt(patch3Before.available_count, 10)

      const res = await fetchJson(BASE_URL + '/orders', {
        method: 'POST',
        body: JSON.stringify({ patch_id: 3, quantity: 5 }),
        headers: { 'Content-Type': 'application/json' },
      })
      assert.equal(res.status, 201, `Expected 201, got ${res.status}`)
      assert.equal(String(res.body.patch_id), '3')
      assert.equal(String(res.body.quantity), '5')

      const after = await fetchJson(BASE_URL + '/patches')
      const patch3After = after.body.find(p => p.id === '3' || p.id === 3)
      const stockAfter = parseInt(patch3After.available_count, 10)
      assert.equal(stockAfter, stockBefore - 5, 'available_count should have decreased by 5')
    })

    it('POST /orders returns 409 when stock is insufficient', async () => {
      // Order more than the total available stock of patch 5 (45 units)
      const res = await fetchJson(BASE_URL + '/orders', {
        method: 'POST',
        body: JSON.stringify({ patch_id: 5, quantity: 999 }),
        headers: { 'Content-Type': 'application/json' },
      })
      assert.equal(res.status, 409)
    })
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll a URL until it returns HTTP 200 or the timeout expires.
 * Uses exponential back-off starting at 200 ms, capped at 3 s.
 *
 * @param {string} url
 * @param {number} timeoutMs
 */
async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let delay = 200
  while (Date.now() < deadline) {
    try {
      const res = await fetchRaw(url)
      if (res.status === 200) return
    } catch {
      // Not up yet
    }
    await sleep(Math.min(delay, 3000))
    delay *= 2
  }
  throw new Error(`Health check timed out after ${timeoutMs} ms: ${url}`)
}

/**
 * Fetch a URL and parse the JSON body.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function fetchJson(url, options = {}) {
  const res = await fetchRaw(url, options)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

/**
 * Thin fetch wrapper using the Node.js built-in fetch (Node 24+).
 * @param {string} url
 * @param {RequestInit} [options]
 */
async function fetchRaw(url, options = {}) {
  // Node 24 ships fetch as a global
  return fetch(url, options)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
