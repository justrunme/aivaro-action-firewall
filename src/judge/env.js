/**
 * Real backend of the judge scenario (T19): a throwaway workspace, a throwaway
 * operator key and a Postgres container of the demo stack, all created for this one
 * run and removed at its end.
 *
 * What the judge never touches: the operator's key directory, the current
 * workspace, any existing Compose project. The child processes get an allowlisted
 * environment (PATH, HOME and the DOCKER_* client settings), so cloud or database
 * credentials in the caller's environment are not passed on.
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
import { run } from '../util/exec.js'

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
  const out = { JUSTRUNME_HOME: home }
  for (const k of PASS_THROUGH) if (env[k] !== undefined) out[k] = env[k]
  return out
}

/** @returns {Promise<{ backend: object, missionId: string, imagesCached: boolean, cleanup: () => Promise<void> }>} */
export async function createBackend({ env = process.env } = {}) {
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20000, env: childEnv(env, os.tmpdir()) })
  if (version.code !== 0) throw new JudgeEnvironmentError('DOCKER_UNAVAILABLE', 'Docker is not available; the judge demo needs a running Docker daemon (the rest of JustRunMe does not)')

  const suffix = randomBytes(4).toString('hex')
  const missionId = `judge-${suffix}`
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'jrm-judge-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'jrm-judge-keys-'))
  const project = `jrm-judge-${suffix}`
  const overrideFile = writeNoPortsOverride(['db', 'app'])
  const real = { project, composeFile: path.join(repoDir, 'demo/docker-compose.yml'), dbService: 'db', dbUser: 'demo_user', dbName: 'pumpkin_patch', overrideFile }
  let stopped = false
  const cleanup = async () => {
    if (!stopped) await down(real)
    stopped = true
    for (const d of [repoDir, home, path.dirname(overrideFile)]) rmSync(d, { recursive: true, force: true })
  }

  try {
    mkdirSync(path.join(repoDir, 'demo/migrations'), { recursive: true })
    copyFileSync(path.join(DEMO_DIR, 'docker-compose.yml'), path.join(repoDir, 'demo/docker-compose.yml'))
    for (const f of ['001_init.sql', '002_seed_data.sql']) copyFileSync(path.join(DEMO_DIR, 'migrations', f), path.join(repoDir, 'demo/migrations', f))
    writeFileSync(path.join(repoDir, '.gitignore'), '.justrunme/\n')
    writeFileSync(path.join(repoDir, 'justrunme.target.json'), JSON.stringify({ project, compose_file: 'demo/docker-compose.yml', db_service: 'db', db_user: 'demo_user', db_name: 'pumpkin_patch' }))
    const git = (...args) => execFileSync('git', ['-c', 'user.name=judge', '-c', 'user.email=judge@judge.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repoDir, stdio: 'pipe' })
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'judge base')

    const image = parse(readFileSync(path.join(repoDir, 'demo/docker-compose.yml'), 'utf8')).services.db.image
    const imagesCached = (await run('docker', ['image', 'inspect', image], { timeoutMs: 20000, env: childEnv(env, home) })).code === 0

    await up(real, ['db'])
    for (const f of ['001_init.sql', '002_seed_data.sql']) {
      const r = await psql(real, { input: readFileSync(path.join(repoDir, 'demo/migrations', f)) })
      if (r.code !== 0) throw new JudgeEnvironmentError('SEED_FAILED', `seeding the demo database failed: ${r.stderr.trim().split('\n').slice(-1)[0]}`)
    }

    const cli = async (args, environment) => {
      const r = await run(process.execPath, [CLI_FILE, ...args, '--repo', repoDir], { env: environment, timeoutMs: 120000 })
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
      cli: (args) => cli(args, childEnv(env, home)),
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
        await down(real)
        stopped = true
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
    return { backend, missionId, imagesCached, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}
