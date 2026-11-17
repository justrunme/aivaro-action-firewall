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

/**
 * `env`, when present, is the whole environment of every docker process started for
 * this target (the judge pins one local daemon this way); absent means the caller's.
 * @typedef {{ project: string, composeFile: string, dbService: string, dbUser: string, dbName: string, overrideFile?: string, env?: NodeJS.ProcessEnv }} Target
 */

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

/**
 * `docker compose exec` costs about 0.25 s more than `docker exec` on the same
 * container, and one mission runs it dozens of times. The container id of a
 * service is looked up once per process and forgotten whenever this process
 * brings the project up or down. If the container was replaced behind our back,
 * `docker exec` fails on the stale id; nothing runs against another container.
 */
const containerIds = new Map()
const containerKey = (t, service) => `${t.project}\u0000${t.composeFile}\u0000${service}`

async function containerOf(t, service) {
  const key = containerKey(t, service)
  const known = containerIds.get(key)
  if (known) return known
  const id = (await runOk('docker', [...baseArgs(t), 'ps', '-q', service], { env: t.env })).trim().split('\n')[0]
  if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error(`service ${service} of project ${t.project} is not running`)
  containerIds.set(key, id)
  return id
}

const forget = (t) => {
  for (const key of [...containerIds.keys()]) if (key.startsWith(t.project + '\u0000')) containerIds.delete(key)
}

/** @param {Target} t */
export async function up(t, services) {
  forget(t)
  await runOk('docker', [...baseArgs(t), 'up', '-d', '--wait', '--wait-timeout', '90', ...services], { timeoutMs: 180000, env: t.env })
}

/** Remove containers, networks and volumes of the project; never throws. */
export async function down(t) {
  forget(t)
  return run('docker', [...baseArgs(t), 'down', '-v', '--remove-orphans', '--timeout', '5'], { timeoutMs: 120000, env: t.env })
}

/**
 * Run SQL in the target database. `input` is fed on stdin (used for files and dumps).
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function psql(t, { sql, input, singleTransaction = false }) {
  assertTarget(t)
  let container
  try {
    container = await containerOf(t, t.dbService)
  } catch (err) {
    // Same contract as before: psql resolves with a non-zero code instead of throwing.
    return { code: 1, stdout: '', stderr: String(err.message), timedOut: false }
  }
  const args = ['exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', t.dbUser, '-d', t.dbName, '-At', '-F', '\t']
  if (singleTransaction) args.push('-1')
  if (sql !== undefined) args.push('-c', sql)
  return run('docker', args, { input, timeoutMs: 120000, env: t.env })
}

/** Plain-SQL dump of the target database. */
export async function dump(t) {
  assertTarget(t)
  return runOk('docker', ['exec', '-i', await containerOf(t, t.dbService), 'pg_dump', '-U', t.dbUser, '-d', t.dbName, '--no-owner', '--no-privileges'], { timeoutMs: 120000, env: t.env })
}

/** Same target, connected to another database of the same server (for CREATE / RENAME DATABASE). */
export const withDatabase = (t, dbName) => ({ ...t, dbName })

/**
 * HTTP status of a GET from inside a service container (no host port needed).
 * @returns {Promise<number>} 0 when the request could not be made
 */
export const HEALTH_SERVICE_RE = /^[A-Za-z0-9_-]{1,63}$/
export const HEALTH_URL_RE = /^http:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9/_-]*$/

export async function httpStatusInService(t, service, url) {
  if (!HEALTH_SERVICE_RE.test(service)) throw new Error('invalid service name')
  if (!HEALTH_URL_RE.test(url)) throw new Error('invalid health url')
  const code = `fetch(${JSON.stringify(url)}).then(r=>console.log(r.status)).catch(()=>console.log(0))`
  const r = await run('docker', [...baseArgs(t), 'exec', '-T', service, 'node', '-e', code], { timeoutMs: 20000, env: t.env })
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/** Image ID (content digest) per running service. */
export async function imageDigests(t) {
  const ids = (await runOk('docker', [...baseArgs(t), 'ps', '-q'], { env: t.env })).split('\n').filter(Boolean)
  const images = {}
  for (const id of ids) {
    const out = (await runOk('docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}\t{{.Image}}', id], { env: t.env })).trim()
    const [service, image] = out.split('\t')
    images[service] = image
  }
  return Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)))
}
