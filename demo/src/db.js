/**
 * db.js — Postgres connection pool for the Pumpkin Patch Orders demo.
 *
 * Uses the `pg` npm package (pinned to 8.12.0 in demo/package.json).
 * Connection details come from environment variables.
 * Applies SQL migrations in filename order on first connect.
 *
 * Required env vars (see demo/.env.example):
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 */

import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { Pool } = pg

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

// Single shared pool; created once and reused across requests.
let _pool = null

function pool() {
  if (!_pool) {
    _pool = new Pool({
      host:     process.env.PGHOST     || 'localhost',
      port:     parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || 'pumpkin_patch',
      user:     process.env.PGUSER     || 'demo_user',
      password: process.env.PGPASSWORD || 'demo_password',
    })
    // An idle client whose backend is terminated (for example while a database is
    // restored) emits 'error' on the pool. Without a listener Node exits the process.
    // The pool drops that client and opens a new connection for the next query.
    _pool.on('error', (err) => {
      process.stderr.write(`db pool: idle client error: ${err.code ?? 'unknown'}\n`)
    })
  }
  return _pool
}

/**
 * Run a parameterised query and return the pg Result object.
 *
 * @param {string} text  SQL text; use $1, $2 … for parameters.
 * @param {any[]}  [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params) {
  return pool().query(text, params)
}

/**
 * Run a SQL file against the demo database.
 * @param {string} filePath absolute path to the SQL file
 */
export async function runFile(filePath) {
  const sql = await readFile(filePath, 'utf8')
  await pool().query(sql)
}

/**
 * Apply all migration files in demo/migrations/ in filename order.
 * Uses an applied_migrations table to track what has already run.
 */
export async function applyMigrations() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const { rows } = await pool().query(
      'SELECT 1 FROM applied_migrations WHERE filename = $1',
      [file]
    )
    if (rows.length > 0) continue

    await runFile(join(MIGRATIONS_DIR, file))
    await pool().query(
      'INSERT INTO applied_migrations (filename) VALUES ($1)',
      [file]
    )
  }
}

/**
 * Verify the database connection is alive.
 * @returns {Promise<boolean>}
 */
export async function ping() {
  try {
    await pool().query('SELECT 1')
    return true
  } catch {
    return false
  }
}
