/**
 * Real target of a mission: the operator's Compose project (T18).
 *
 * The contract names databases and services; which Compose project, file and
 * database user they live in is environment, kept in justrunme.target.json at the
 * workspace root. The hook protects this file like the contract, so the agent
 * cannot point a rehearsal at another environment. The fingerprint binds the
 * target identity anyway: a changed target fails the fidelity gate.
 *
 *   { "project": "pumpkin", "compose_file": "demo/docker-compose.yml",
 *     "db_service": "db", "db_user": "demo_user", "db_name": "pumpkin_patch",
 *     "health": { "service": "app", "url": "http://localhost:3000/health" } }   (health optional)
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { assertTarget } from '../rehearsal/compose.js'

export const TARGET_FILE = 'justrunme.target.json'
const KEYS = ['project', 'compose_file', 'db_service', 'db_user', 'db_name', 'health']

export class ConfigError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const safeRelative = (p) => typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..')

/** @returns {{ target: import('../rehearsal/compose.js').Target, health: { service: string, url: string } | null }} */
export function loadTarget(repoDir) {
  const file = path.join(repoDir, TARGET_FILE)
  if (!existsSync(file)) throw new ConfigError('NO_TARGET', `${TARGET_FILE} not found in the workspace`)
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new ConfigError('TARGET_INVALID', `${TARGET_FILE} is not valid JSON`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ConfigError('TARGET_INVALID', `${TARGET_FILE} must be an object`)
  const unknown = Object.keys(doc).filter((k) => !KEYS.includes(k))
  if (unknown.length > 0) throw new ConfigError('TARGET_INVALID', `unknown field(s) in ${TARGET_FILE}: ${unknown.join(', ')}`)
  if (!safeRelative(doc.compose_file)) throw new ConfigError('TARGET_INVALID', 'compose_file must be a relative path inside the workspace')
  if (!existsSync(path.join(repoDir, doc.compose_file))) throw new ConfigError('TARGET_INVALID', `compose_file ${doc.compose_file} does not exist`)
  const target = { project: doc.project, composeFile: doc.compose_file, dbService: doc.db_service, dbUser: doc.db_user, dbName: doc.db_name }
  try {
    assertTarget(target)
  } catch (err) {
    throw new ConfigError('TARGET_INVALID', err.message)
  }
  let health = null
  if (doc.health !== undefined) {
    const h = doc.health
    if (!h || typeof h.service !== 'string' || typeof h.url !== 'string' || Object.keys(h).some((k) => k !== 'service' && k !== 'url')) {
      throw new ConfigError('TARGET_INVALID', 'health must be { "service": string, "url": string }')
    }
    health = { service: h.service, url: h.url }
  }
  return { target, health }
}
