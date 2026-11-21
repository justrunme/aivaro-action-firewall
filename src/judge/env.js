/**
 * Real backend of the judge scenario (T19): a throwaway workspace, a throwaway
 * operator key and a Postgres container of the demo stack, all created for this one
 * run and removed at its end, on failure, and on Ctrl-C or SIGTERM.
 *
 * What the judge never touches: the operator's key directory, the current
 * workspace, any existing Compose project. Every child process (the CLI, git,
 * docker) gets an allowlisted environment: PATH, HOME, TMPDIR, LANG and the
 * DOCKER_* client settings, plus a throwaway JUSTRUNME_HOME and git settings that
 * ignore the caller's git configuration. Database and cloud credentials in the
 * caller's environment are not passed on. HOME and DOCKER_CONFIG are, because the
 * Docker client needs them; a remote DOCKER_HOST is refused.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { down, psql, up, writeNoPortsOverride } from '../rehearsal/compose.js'
import { measureDatabase } from '../rehearsal/measure.js'
import { chainPath, receiptHash, verifyChain } from '../receipts/chain.js'
import { loadPublicKey, publicKeyHex } from '../receipts/keys.js'
import { groupAlive, killGroup, run } from '../util/exec.js'
import { PreflightError, checkDockerCli, checkDockerDaemon, checkNode } from './preflight.js'

const DEMO_DIR = fileURLToPath(new URL('../../demo/', import.meta.url))
const CLI_FILE = fileURLToPath(new URL('../cli/index.js', import.meta.url))

// Fresh SQL written for this demo. The dangerous plan "consolidates" orders but keeps
// only the rows with quantity >= 10; the safe plan only adds a column.
export const DANGEROUS_SQL = 'CREATE TABLE orders_v2 AS SELECT id, patch_id, quantity FROM orders WHERE quantity >= 10;\nDROP TABLE orders;\nALTER TABLE orders_v2 RENAME TO orders;\n'
export const SAFE_SQL = "ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'new';\n"
const MIGRATIONS = { dangerous: 'demo/migrations/003_consolidate_orders.sql', safe: 'demo/migrations/003_add_order_status.sql' }
const SQL = { dangerous: DANGEROUS_SQL, safe: SAFE_SQL }

export class JudgeEnvironmentError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const PASS_THROUGH = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_DEFAULT_PLATFORM', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']

/** @param {NodeJS.ProcessEnv} env */
export function childEnv(env, home) {
  // GIT_CONFIG_*: the caller's git configuration (hooks path, signing, aliases) plays no part.
  const out = { JUSTRUNME_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of PASS_THROUGH) if (env[k] !== undefined) out[k] = env[k]
  return out
}

/** A socket on this machine (a forwarded socket cannot be told apart; the README says so). */
export const isLocalEndpoint = (host) => typeof host === 'string' && /^(unix|npipe):\/\/\/\S+$/.test(host)

/**
 * The endpoint of the context the Docker CLI would use, from
 * `docker context ls --format '{{.Current}}\t{{.DockerEndpoint}}'`. The CLI has
 * already applied DOCKER_HOST, DOCKER_CONTEXT and the configured current context.
 */
export function currentEndpoint(listing) {
  const current = String(listing)
    .split('\n')
    .map((l) => l.trim().split('\t'))
    .filter(([flag, endpoint]) => flag === 'true' && endpoint)
  return current.length === 1 ? current[0][1] : null
}

/**
 * Resolve the daemon once, refuse anything but a local socket, and return the
 * environment that pins it: every docker process of the judge gets this
 * DOCKER_HOST and no DOCKER_CONTEXT, so none of them can reach another daemon.
 */
async function pinLocalDocker(env, probe = run) {
  const base = childEnv(env, os.tmpdir())
  const r = await probe('docker', ['context', 'ls', '--format', '{{.Current}}\t{{.DockerEndpoint}}'], { timeoutMs: 20000, env: base })
  if (r.code !== 0) throw new JudgeEnvironmentError('DOCKER_UNAVAILABLE', 'Docker is not available; the judge demo needs a running Docker daemon (the rest of JustRunMe does not)')
  const endpoint = currentEndpoint(r.stdout)
  if (!isLocalEndpoint(endpoint)) throw new JudgeEnvironmentError('REMOTE_DOCKER', 'the active Docker context does not point at a local socket; the judge demo runs only against a local Docker')
  const { DOCKER_CONTEXT: _context, ...rest } = base
  return { ...rest, DOCKER_HOST: endpoint }
}

/** Names that identify what this judge run created, for removal when it ends early. */
export const projectNames = (suffix) => ({ stack: `jrm-judge-${suffix}`, rehearsalPrefix: `jrm-reh-judge${suffix}-` })

/**
 * Containers, volumes and networks of the rehearsal copies the child CLI started.
 * @returns {Promise<number>} how many objects were found (and removal was attempted for)
 */
async function sweepRehearsalCopies(prefix, env) {
  let found = 0
  for (const [list, rm] of [
    [['ps', '-a', '-q', '--filter', `name=${prefix}`], ['rm', '-f', '-v']],
    [['volume', 'ls', '-q', '--filter', `name=${prefix}`], ['volume', 'rm', '-f']],
    [['network', 'ls', '-q', '--filter', `name=${prefix}`], ['network', 'rm']],
  ]) {
    const ids = (await run('docker', list, { env, timeoutMs: 30000 })).stdout.split('\n').filter(Boolean)
    found += ids.length
    if (ids.length > 0) await run('docker', [...rm, ...ids], { env, timeoutMs: 60000 })
  }
  return found
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Sweep until the daemon is quiet. A `docker compose up` that was killed may have
 * requests in flight that the daemon still completes (a volume can appear after a
 * single sweep; CI saw exactly that). Stop after two clean sweeps in a row, or at
 * the deadline (then whatever is left is reported by the caller's own check).
 */
export async function sweepUntilQuiet(sweep, { deadlineMs = 30000, intervalMs = 500, now = Date.now, sleep = pause } = {}) {
  const end = now() + deadlineMs
  let clean = 0
  while (clean < 2 && now() < end) {
    clean = (await sweep()) === 0 ? clean + 1 : 0
    if (clean < 2) await sleep(intervalMs)
  }
  return clean >= 2
}

/** @returns {Promise<{ backend: object, missionId: string, imagesCached: boolean, cleanup: () => Promise<void> }>} */
export async function createBackend({ env = process.env, probe = run, nodeVersion = process.versions.node } = {}) {
  // Preflight: nothing below this block runs, and nothing is created, unless it passes.
  let cleanEnv
  try {
    checkNode(nodeVersion)
    if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith('unix://')) {
      throw new JudgeEnvironmentError('REMOTE_DOCKER', 'DOCKER_HOST points at a remote daemon; the judge demo runs only against a local Docker')
    }
    await checkDockerCli(probe, childEnv(env, os.tmpdir()))
    cleanEnv = await pinLocalDocker(env, probe)
    await checkDockerDaemon(probe, cleanEnv)
  } catch (err) {
    if (err instanceof PreflightError) throw new JudgeEnvironmentError(err.code, err.message)
    throw err
  }
  const suffix = randomBytes(4).toString('hex')
  const missionId = `judge-${suffix}`
  const names = projectNames(suffix)
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20000, env: cleanEnv })
  if (version.code !== 0) throw new JudgeEnvironmentError('DOCKER_UNAVAILABLE', 'Docker is not available; the judge demo needs a running Docker daemon (the rest of JustRunMe does not)')

  let repoDir = null
  let home = null
  let overrideFile = null
  let real = null
  let stackDown = false
  let finished = false
  const children = new Set()
  const track = (child) => {
    children.add(child)
    child.on('close', () => children.delete(child))
  }
  const cleanup = async () => {
    // The CLI children lead their own process groups: this stops them and the docker
    // processes they started, then waits (bounded) until those groups are gone.
    const groups = [...children].map((c) => c.pid).filter(Boolean)
    for (const c of children) killGroup(c)
    for (let i = 0; i < 50 && groups.some(groupAlive); i++) await pause(100)
    if (real && real.env && !stackDown) stackDown = (await down(real)).code === 0
    await sweepUntilQuiet(() => sweepRehearsalCopies(names.rehearsalPrefix, cleanEnv))
    for (const d of [repoDir, home, overrideFile && path.dirname(overrideFile)]) if (d) rmSync(d, { recursive: true, force: true })
  }
  // Installed before anything is created: Ctrl-C during the first `up` removes it too.
  const onSignal = (sig) => () => {
    cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143))
  }
  const handlers = [['SIGINT', onSignal('SIGINT')], ['SIGTERM', onSignal('SIGTERM')]]
  for (const [s, h] of handlers) process.once(s, h)
  const finish = async () => {
    if (finished) return
    finished = true
    for (const [s, h] of handlers) process.removeListener(s, h)
    await cleanup()
  }

  try {
    repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-judge-'))
    home = mkdtempSync(path.join(os.tmpdir(), 'jrm-judge-keys-'))
    overrideFile = writeNoPortsOverride(['db', 'app'])
    real = { project: names.stack, composeFile: path.join(repoDir, 'demo/docker-compose.yml'), dbService: 'db', dbUser: 'demo_user', dbName: 'pumpkin_patch', overrideFile }
    // The demo approves by itself: a throwaway passphrase for a throwaway approver key, used only inside this run.
    const runEnv = { ...cleanEnv, JUSTRUNME_HOME: home, JUSTRUNME_APPROVER_PASSPHRASE: randomBytes(16).toString('hex') }
    real.env = runEnv

    mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
    copyFileSync(path.join(DEMO_DIR, 'docker-compose.yml'), path.join(repoDir, 'demo/docker-compose.yml'))
    for (const f of ['001_init.sql', '002_seed_data.sql']) copyFileSync(path.join(DEMO_DIR, 'migrations', f), path.join(repoDir, 'demo/migrations', f))
    writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\n')
    writeFileSync(path.join(repoDir, 'justrunme.target.json'), JSON.stringify({ project: names.stack, compose_file: 'demo/docker-compose.yml', db_service: 'db', db_user: 'demo_user', db_name: 'pumpkin_patch' }))
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=judge', '-c', 'user.email=judge@judge.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repoDir, stdio: 'pipe', env: runEnv })
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'judge base')

    const image = parse(readFileSync(path.join(repoDir, 'demo/docker-compose.yml'), 'utf8')).services.db.image
    const imagesCached = (await run('docker', ['image', 'inspect', image], { timeoutMs: 20000, env: runEnv })).code === 0

    await up(real, ['db'])
    for (const f of ['001_init.sql', '002_seed_data.sql']) {
      const r = await psql(real, { input: readFileSync(path.join(repoDir, 'demo/migrations', f)) })
      if (r.code !== 0) throw new JudgeEnvironmentError('SEED_FAILED', `seeding the demo database failed: ${r.stderr.trim().split('\n').slice(-1)[0]}`)
    }

    const cli = async (args, environment) => {
      const r = await run(process.execPath, [CLI_FILE, ...args, '--repo', repoDir], { env: environment, timeoutMs: 120000, group: true, onSpawn: track })
      let out = null
      try {
        out = JSON.parse(r.stdout)
      } catch {
        // an unparseable stdout is a failed step, not a crash
      }
      return { exit: r.code, out }
    }
    const chain = chainPath(repoDir, missionId)
    let original = null

    const backend = {
      cli: (args) => cli(args, runEnv),
      // No PATH at all: the verifier must not need Docker, git or anything else.
      offlineCli: (args) => cli(args, { JUSTRUNME_HOME: home, PATH: '' }),
      measure: () => measureDatabase((sql) => psql(real, { sql })),
      async useMigration(kind) {
        for (const [k, rel] of Object.entries(MIGRATIONS)) if (k !== kind) rmSync(path.join(repoDir, rel), { force: true })
        writeFileSync(path.join(repoDir, MIGRATIONS[kind]), SQL[kind])
        writeFileSync(
          path.join(repoDir, 'justrunme.mission.yaml'),
          stringify({
            id: missionId,
            objective: 'Add order status tracking to the demo service',
            allowed_paths: ['demo/migrations/'],
            protected_tables: ['orders', 'patches'],
            time_limit_seconds: 300,
            irreversible_actions: [],
            plan: [{ id: 'migrate', tool: 'sql_migration', args: [MIGRATIONS[kind]], reversibility: true }],
            resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] },
          })
        )
      },
      async stopStack() {
        // Only counts as stopped when docker says so; otherwise cleanup tries again.
        stackDown = (await down(real)).code === 0
      },
      corruptChain() {
        original = readFileSync(chain)
        const bad = Buffer.from(original)
        bad[30] = bad[30] ^ 1
        writeFileSync(chain, bad)
      },
      restoreChain() {
        if (original) writeFileSync(chain, original)
        original = null
      },
      readReceipts() {
        const publicKey = loadPublicKey(home)
        const v = verifyChain({ repoDir, home, publicKey, missionId })
        return { publicKey: publicKey ? publicKeyHex(publicKey) : null, receipts: v.receipts.map((r) => ({ seq: r.seq, kind: r.kind, verdict: r.verdict ?? null, hash: receiptHash(r) })) }
      },
    }
    return { backend, missionId, imagesCached, cleanup: finish }
  } catch (err) {
    await finish()
    throw err
  }
}
