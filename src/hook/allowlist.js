/**
 * Run authorization and allowlist matching (R3.6, R3.7, R10.7).
 *
 * An authorization is the rehearsed-action allowlist for one mission:
 *   { version: 1, mission_id, contract_hash, fingerprint_hash, issued_at, expires_at,
 *     entries: [{ action, script_hashes, environment_verified?, irreversible_approved? }] }
 *
 * A call is allowed only if every bound value matches now: mission, contract
 * hash, time window, the canonical action, and the current content hash of
 * every script file the action executes. Comparing fingerprint_hash with the
 * live fingerprint needs the fidelity module (T14.9); until then it is carried
 * but not compared here.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256Hex } from '../util/canonical.js'

/**
 * Content hash of a script file, or null if it is missing, not a regular file,
 * or resolves (after symlinks) outside the workspace.
 *
 * @param {string} scriptPath path as written in the command
 * @param {string} cwd workspace root
 * @returns {string | null}
 */
export function hashScript(scriptPath, cwd) {
  try {
    const root = realpathSync(cwd)
    const real = realpathSync(path.resolve(root, scriptPath))
    if (real !== root && !real.startsWith(root + path.sep)) return null
    if (!statSync(real).isFile()) return null
    return 'sha256:' + sha256Hex(readFileSync(real))
  } catch {
    return null
  }
}

/** @returns {string | null} an error message when the authorization is unusable */
export function authorizationProblem(auth, contract, contractHash) {
  if (!auth || typeof auth !== 'object' || auth.version !== 1 || !Array.isArray(auth.entries)) {
    return 'authorization file is malformed'
  }
  if (auth.mission_id !== contract.id) return 'authorization belongs to a different mission'
  if (auth.contract_hash !== contractHash) return 'contract changed after the authorization was issued'
  return null
}

/**
 * The window in which the run may execute: from issued_at, ending at the
 * earlier of expires_at and issued_at + time_limit_seconds (R1.6).
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkWindow(auth, contract, now) {
  const issued = Date.parse(auth.issued_at)
  const expires = Date.parse(auth.expires_at)
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return { ok: false, reason: 'authorization has no valid time window' }
  const end = Math.min(expires, issued + contract.time_limit_seconds * 1000)
  if (now < issued) return { ok: false, reason: 'authorization is not valid yet' }
  if (now > end) return { ok: false, reason: 'authorization expired or time limit exceeded' }
  return { ok: true }
}

/**
 * @param {object} args
 * @param {any} args.auth validated against the contract by the caller
 * @param {{ tool: string, argv?: string[], raw?: string, input?: unknown }} args.action
 * @param {string[]} args.scripts script paths the action executes
 * @param {string} args.cwd
 * @returns {{ ok: true, entry: any } | { ok: false, category: string, reason: string }}
 */
export function matchEntry({ auth, action, scripts, cwd }) {
  const key = canonicalJson(action)
  const entry = auth.entries.find((e) => e && typeof e === 'object' && e.action && canonicalJson(e.action) === key)
  if (!entry) return { ok: false, category: 'NOT_REHEARSED', reason: 'action is not on the rehearsed allowlist' }

  if (action.raw !== undefined && entry.environment_verified !== true) {
    return { ok: false, category: 'NOT_REHEARSED', reason: 'complex command was not verified in a matching rehearsal environment' }
  }
  const bound = entry.script_hashes && typeof entry.script_hashes === 'object' ? entry.script_hashes : {}
  for (const script of scripts) {
    const current = hashScript(script, cwd)
    if (current === null) return { ok: false, category: 'UNDECLARED_SCRIPT', reason: `script ${script} is missing or outside the workspace` }
    if (bound[script] === undefined) return { ok: false, category: 'UNDECLARED_SCRIPT', reason: `script ${script} has no recorded hash` }
    if (bound[script] !== current) return { ok: false, category: 'SCRIPT_CHANGED', reason: `script ${script} changed since rehearsal` }
  }
  return { ok: true, entry }
}
