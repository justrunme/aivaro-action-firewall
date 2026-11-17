/**
 * Docker Compose target access (R2.2, R2.5).
 *
 * A target is one Compose project: { project, composeFile, dbService, dbUser, dbName }.
 * All database access goes through `docker compose exec -T <db> psql`, so no host
 * port and no host Postgres client is needed. Rehearsal copies are started with an
 * override that removes published ports, so they never collide with the real stack.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, runOk } from '../util/exec.js'

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/

/** @typedef {{ project: string, composeFile: string, dbService: string, dbUser: string, dbName: string, overrideFile?: string }} Target */

export function assertTarget(t) {
  if (!PROJECT_RE.test(t.project)) throw new Error(`invalid compose project name: ${t.project}`)
  for (const k of ['dbService', 'dbUser', 'dbName']) {
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(t[k])) throw new Error(`invalid target field ${k}`)
  }
}

/** Override that drops every published port of the listed services (Compose `!reset`). */
export function writeNoPortsOverride(services) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jrm-override-'))
  const file = path.join(dir, 'no-ports.override.yml')
  writeFileSync(file, 'services:\n' + services.map((s) => `  ${s}:\n    ports: !reset []\n`).join(''))
  return file
}

function baseArgs(t) {
  assertTarget(t)
  const args = ['compose', '-p', t.project, '-f', t.composeFile]
  if (t.overrideFile) args.push('-f', t.overrideFile)
  return args
}

/** @param {Target} t */
export async function up(t, services) {
  await runOk('docker', [...baseArgs(t), 'up', '-d', '--wait', '--wait-timeout', '90', ...services], { timeoutMs: 180000 })
}

/** Remove containers, networks and volumes of the project; never throws. */
export async function down(t) {
  return run('docker', [...baseArgs(t), 'down', '-v', '--remove-orphans', '--timeout', '5'], { timeoutMs: 120000 })
}

/**
 * Run SQL in the target database. `input` is fed on stdin (used for files and dumps).
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function psql(t, { sql, input, singleTransaction = false }) {
  const args = [...baseArgs(t), 'exec', '-T', t.dbService, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', t.dbUser, '-d', t.dbName, '-At', '-F', '\t']
  if (singleTransaction) args.push('-1')
  if (sql !== undefined) args.push('-c', sql)
  return run('docker', args, { input, timeoutMs: 120000 })
}

/** Plain-SQL dump of the target database. */
export async function dump(t) {
  return runOk('docker', [...baseArgs(t), 'exec', '-T', t.dbService, 'pg_dump', '-U', t.dbUser, '-d', t.dbName, '--no-owner', '--no-privileges'], { timeoutMs: 120000 })
}

/** Same target, connected to another database of the same server (for CREATE / RENAME DATABASE). */
export const withDatabase = (t, dbName) => ({ ...t, dbName })

/**
 * HTTP status of a GET from inside a service container (no host port needed).
 * @returns {Promise<number>} 0 when the request could not be made
 */
export async function httpStatusInService(t, service, url) {
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(service)) throw new Error('invalid service name')
  if (!/^http:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9/_-]*$/.test(url)) throw new Error('invalid health url')
  const code = `fetch(${JSON.stringify(url)}).then(r=>console.log(r.status)).catch(()=>console.log(0))`
  const r = await run('docker', [...baseArgs(t), 'exec', '-T', service, 'node', '-e', code], { timeoutMs: 20000 })
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/** Image ID (content digest) per running service. */
export async function imageDigests(t) {
  const ids = (await runOk('docker', [...baseArgs(t), 'ps', '-q'])).split('\n').filter(Boolean)
  const images = {}
  for (const id of ids) {
    const out = (await runOk('docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}\t{{.Image}}', id])).trim()
    const [service, image] = out.split('\t')
    images[service] = image
  }
  return Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)))
}
