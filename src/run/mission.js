/**
 * Operator-side commands after rehearsal: authorize and run (R2.7, R3.2 to R3.7).
 *
 * authorizeMission: re-measures the real target, checks it against the stored
 * rehearsal report, and writes a signed authorization.
 * runMission: verifies the signature, re-measures again right before executing,
 * executes exactly the contract's plan against the real target, and consumes the
 * authorization so it cannot be replayed.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hashValue } from '../util/canonical.js'
import { computeFingerprint } from '../fidelity/fingerprint.js'
import { compareFingerprints } from '../fidelity/gate.js'
import { STATE_DIR } from '../fidelity/source.js'
import { AuthorizationRefused, issueAuthorization, signatureProblem } from '../authorize/authorization.js'
import { executeSteps } from '../rehearsal/steps.js'
import { loadReport, planId } from '../rehearsal/engine.js'

export const authorizationPath = (repoDir) => path.join(repoDir, STATE_DIR, 'authorization.json')

const realTargetOf = (repoDir, target) => ({ ...target, composeFile: path.resolve(repoDir, target.composeFile) })

export async function authorizeMission({ repoDir, contract, contractHash, target, keys, now = Date.now(), ttlSeconds }) {
  let report
  try {
    report = loadReport(repoDir, contract.id, planId(contract))
  } catch {
    throw new AuthorizationRefused('NO_REHEARSAL', 'this plan has not been rehearsed')
  }
  const currentFingerprint = await computeFingerprint({ repoDir, target: realTargetOf(repoDir, target), contract, contractHash })
  const auth = issueAuthorization({ cwd: repoDir, contract, contractHash, report, currentFingerprint, keys, now, ttlSeconds })
  mkdirSync(path.join(repoDir, STATE_DIR), { recursive: true })
  writeFileSync(authorizationPath(repoDir), JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
  return auth
}

export async function runMission({ repoDir, contract, contractHash, target, publicKey, now = Date.now() }) {
  const file = authorizationPath(repoDir)
  if (!existsSync(file)) throw new AuthorizationRefused('NO_AUTHORIZATION', 'no authorization for a real run')
  const auth = JSON.parse(readFileSync(file, 'utf8'))
  const problem = signatureProblem(auth, publicKey)
  if (problem) throw new AuthorizationRefused('AUTHORIZATION_INVALID', problem)
  if (auth.mission_id !== contract.id || auth.contract_hash !== contractHash || auth.plan_id !== planId(contract)) {
    throw new AuthorizationRefused('AUTHORIZATION_INVALID', 'authorization is for a different mission, contract or plan')
  }
  if (now < Date.parse(auth.issued_at) || now > Date.parse(auth.expires_at)) throw new AuthorizationRefused('EXPIRED', 'authorization expired')

  const realTarget = realTargetOf(repoDir, target)
  const current = await computeFingerprint({ repoDir, target: realTarget, contract, contractHash })
  if (hashValue(current) !== auth.fingerprint_hash) {
    const report = loadReport(repoDir, contract.id, auth.plan_id)
    throw new AuthorizationRefused('FIDELITY_MISMATCH', 'real target changed since authorization', compareFingerprints(report.fingerprint, current).diffs)
  }

  // Consume before executing: a crash mid-run must not leave a reusable authorization.
  renameSync(file, path.join(repoDir, STATE_DIR, `authorization.used-${auth.signature.slice(0, 16)}.json`))
  const steps = await executeSteps({ plan: contract.plan, cwd: repoDir, target: realTarget, mode: 'real' })
  return { mission_id: contract.id, plan_id: auth.plan_id, steps, ok: steps.every((s) => s.status === 'ok' || s.status === 'skipped_needs_approval') }
}
