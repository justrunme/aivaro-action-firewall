/**
 * Plans proposed by an agent (T21).
 *
 * The operator owns the mission: its id, objective, allowed_paths, protected
 * tables, thresholds, resources (justrunme.mission.yaml, protected from the agent
 * by the hook). The agent owns only the plan, and only in one form: an ordered
 * list of SQL files for the sql_migration step, each inside allowed_paths. It can
 * name no shell step, no other tool, no irreversible action and no database.
 *
 * Why not shell: a rehearsal executes its steps on this machine. A shell step the
 * agent chose would be arbitrary code execution that needs no approval at all.
 * A SQL file is applied inside a disposable database copy whose network has no
 * route out (src/rehearsal/compose.js, isolate); it reaches the real database only
 * after a rehearsal, a measured verdict and a signed approval. Inside that
 * container the SQL runs as the database superuser, so it can run programs there;
 * the container cannot reach anything else.
 *
 * The mission must not let an agent write the Compose file the rehearsal starts
 * (assertMissionNarrow).
 *
 * The effective contract (operator base + agent plan) is stored under
 * .justrunme/missions/<mission>/plans/<plan_id>.yaml. Every later operation
 * loads it by plan id and re-checks it against the current operator mission.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stringify } from 'yaml'
import { parseContract } from '../contract/parser.js'
import { CONTRACT_FILE } from '../hook/run.js'
import { loadTarget } from '../cli/target.js'
import { STATE_DIR } from '../fidelity/source.js'
import { planId } from '../rehearsal/engine.js'
import { hashValue } from '../util/canonical.js'

export const MAX_STEPS = 5
export const MAX_SQL_BYTES = 256 * 1024
export const PLAN_ID_RE = /^plan-[0-9a-f]{12}$/

export class PlanRefused extends Error {
  /** @param {string} code @param {string} message @param {unknown} [detail] */
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep)

export const plansDir = (repoDir, missionId) => path.join(repoDir, STATE_DIR, 'missions', missionId, 'plans')

/** @returns {{ contract: any, hash: string, text: string }} the operator's mission */
export function loadBase(repoDir) {
  const file = path.join(repoDir, CONTRACT_FILE)
  if (!existsSync(file)) throw new PlanRefused('NO_CONTRACT', `${CONTRACT_FILE} not found in the workspace`)
  const text = readFileSync(file, 'utf8')
  const parsed = parseContract(text)
  if (!parsed.ok) throw new PlanRefused('CONTRACT_INVALID', 'the operator mission does not validate', parsed.errors)
  return { contract: parsed.contract, hash: parsed.hash, text }
}

/**
 * One migration file: relative, .sql, a regular file, no symbolic link anywhere in
 * the path, inside allowed_paths, not larger than MAX_SQL_BYTES.
 * @returns {string} normalized relative path with forward slashes
 */
export function checkMigration(repoDir, allowedPaths, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 200 || rel.includes('\0')) throw new PlanRefused('MIGRATION_INVALID', 'a migration must be a relative file path')
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new PlanRefused('MIGRATION_INVALID', `migration path must stay inside the workspace: ${rel}`)
  const clean = path.normalize(rel)
  if (!clean.toLowerCase().endsWith('.sql')) throw new PlanRefused('MIGRATION_INVALID', `only .sql files can be migrations: ${rel}`)
  const root = realpathSync(repoDir)
  const expected = path.join(root, clean)
  let real
  try {
    real = realpathSync(expected)
  } catch {
    throw new PlanRefused('MIGRATION_NOT_FOUND', `migration file does not exist: ${rel}`)
  }
  if (real !== expected || lstatSync(expected).isSymbolicLink()) throw new PlanRefused('MIGRATION_INVALID', `a symbolic link is not accepted as a migration: ${rel}`)
  if (!statSync(real).isFile()) throw new PlanRefused('MIGRATION_INVALID', `not a regular file: ${rel}`)
  if (!allowedPaths.some((a) => inside(real, path.resolve(root, a)))) throw new PlanRefused('MIGRATION_OUTSIDE_ALLOWED_PATHS', `${rel} is not under the mission's allowed_paths`, { allowed_paths: allowedPaths })
  if (statSync(real).size > MAX_SQL_BYTES) throw new PlanRefused('MIGRATION_TOO_LARGE', `${rel} is larger than ${MAX_SQL_BYTES} bytes`)
  return clean.split(path.sep).join('/')
}

// Files and directories an agent-written file must never be able to replace: the
// operator's mission and target, the rehearsal's own Compose file, the gate, the
// state directory, git metadata, this program. A rehearsal runs the Compose file
// from the working tree, so an agent that could write it could add mounts or
// privileges to the copy.
const NEVER_AGENT_WRITABLE = ['justrunme.mission.yaml', 'justrunme.target.json', '.kiro', '.justrunme', '.git', 'src', 'node_modules', 'package.json', 'package-lock.json']

/**
 * allowed_paths of an operator mission is safe for agent plans only if no entry
 * covers one of the files above or the target's Compose file.
 */
export function assertMissionNarrow(repoDir, allowedPaths) {
  const root = realpathSync(repoDir)
  const protectedPaths = [...NEVER_AGENT_WRITABLE]
  try {
    protectedPaths.push(loadTarget(repoDir).target.composeFile)
  } catch {
    // No target file yet: the fixed list still applies; rehearse refuses later with NO_TARGET.
  }
  for (const a of allowedPaths) {
    const allowed = path.resolve(root, a)
    for (const p of protectedPaths) {
      const guarded = path.resolve(root, p)
      // Covers it from above (allowed_paths: demo/ over demo/docker-compose.yml) or sits inside it (.kiro/hooks/ inside .kiro).
      if (inside(guarded, allowed) || inside(allowed, guarded)) {
        throw new PlanRefused('MISSION_TOO_BROAD', `allowed_paths entry ${a} covers ${p}, which an agent must never be able to write; narrow the mission before an agent proposes plans`)
      }
    }
  }
}

/** The agent's whole contribution to a contract: sql_migration steps, all reversible. */
export const stepsFor = (files) => files.map((file, i) => ({ id: `m${i + 1}`, tool: 'sql_migration', args: [file], reversibility: true }))

/** Everything in a contract except what the agent may choose. */
const missionPart = (contract) => hashValue({ ...contract, plan: null, irreversible_actions: null })

/**
 * Build, validate and store the effective contract for a list of migration files.
 * @param {{ repoDir: string, migrations: unknown }} a
 * @returns {{ contract: any, hash: string, plan_id: string, files: string[], file: string }}
 */
export function proposePlan({ repoDir, migrations }) {
  const base = loadBase(repoDir)
  assertMissionNarrow(repoDir, base.contract.allowed_paths)
  if (!Array.isArray(migrations) || migrations.length === 0 || migrations.length > MAX_STEPS) {
    throw new PlanRefused('PLAN_INVALID', `a plan is 1 to ${MAX_STEPS} migration files`)
  }
  const files = migrations.map((m) => checkMigration(repoDir, base.contract.allowed_paths, m))
  if (new Set(files).size !== files.length) throw new PlanRefused('PLAN_INVALID', 'the same migration is listed twice')
  const effective = { ...base.contract, plan: stepsFor(files), irreversible_actions: [] }
  const parsed = parseContract(stringify(effective))
  if (!parsed.ok) throw new PlanRefused('PLAN_INVALID', 'the plan does not validate against the mission', parsed.errors)
  const id = planId(parsed.contract)
  const dir = plansDir(repoDir, parsed.contract.id)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.yaml`)
  writeFileSync(file, stringify(parsed.contract))
  return { contract: parsed.contract, hash: parsed.hash, plan_id: id, files, file }
}

/**
 * Load a stored plan and prove that it is still what proposePlan would build
 * today: the same operator mission around it, the same plan id, only
 * sql_migration steps, every file still acceptable.
 */
export function loadStoredPlan(repoDir, id) {
  if (typeof id !== 'string' || !PLAN_ID_RE.test(id)) throw new PlanRefused('PLAN_INVALID', 'plan id must look like plan-<12 hex>')
  const base = loadBase(repoDir)
  assertMissionNarrow(repoDir, base.contract.allowed_paths)
  const file = path.join(plansDir(repoDir, base.contract.id), `${id}.yaml`)
  if (!existsSync(file)) throw new PlanRefused('PLAN_UNKNOWN', `no stored plan ${id} for this mission`)
  const parsed = parseContract(readFileSync(file, 'utf8'))
  if (!parsed.ok) throw new PlanRefused('PLAN_INVALID', 'the stored plan does not validate', parsed.errors)
  if (planId(parsed.contract) !== id) throw new PlanRefused('PLAN_INVALID', 'the stored plan does not match its id')
  if (missionPart(parsed.contract) !== missionPart(base.contract)) throw new PlanRefused('PLAN_STALE', 'the operator mission changed after this plan was proposed; propose it again')
  if (parsed.contract.irreversible_actions.length !== 0 || parsed.contract.plan.some((s) => s.tool !== 'sql_migration' || s.reversibility !== true || s.args.length !== 1)) {
    throw new PlanRefused('PLAN_INVALID', 'a stored agent plan may contain only reversible sql_migration steps')
  }
  for (const s of parsed.contract.plan) checkMigration(repoDir, base.contract.allowed_paths, s.args[0])
  return { ok: true, contract: parsed.contract, hash: parsed.hash }
}
