/**
 * Operator-side commands after rehearsal: authorize and run (R2.7, R3.2 to R3.7, R7.1).
 *
 * authorizeMission: re-measures the real target, checks it against the stored
 * rehearsal report, and writes a signed authorization.
 * runMission: verifies the signature, re-measures again right before executing,
 * executes exactly the contract's plan against the real target, and consumes the
 * authorization so it cannot be replayed.
 * Every outcome, refusals included, is written to the mission's receipt chain.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hashValue } from '../util/canonical.js'
import { computeFingerprint } from '../fidelity/fingerprint.js'
import { baseHash, compareFingerprints } from '../fidelity/gate.js'
import { STATE_DIR } from '../fidelity/source.js'
import { selectionGate } from '../compare/gate.js'
import { verifySelection } from '../compare/select.js'
import { AuthorizationRefused, issueAuthorization, signatureProblem } from '../authorize/authorization.js'
import { executeSteps } from '../rehearsal/steps.js'
import { captureState } from '../capture/capture.js'
import { loadReport, planId, reportSignatureProblem } from '../rehearsal/engine.js'
import { appendReceipt, findLast, readChain, verifyChain } from '../receipts/chain.js'

export const authorizationPath = (repoDir) => path.join(repoDir, STATE_DIR, 'authorization.json')

const realTargetOf = (repoDir, target) => ({ ...target, composeFile: path.resolve(repoDir, target.composeFile) })

/** Write a refusal receipt, then rethrow the refusal unchanged. */
async function recordingRefusals({ repoDir, keys, missionId, kind, plan_id }, fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AuthorizationRefused) {
      appendReceipt({ repoDir, keys, missionId, kind, verdict: 'deny', subject: { plan_id, code: err.code, reason: err.message } })
    }
    throw err
  }
}

export async function authorizeMission({ repoDir, contract, contractHash, target, keys, now = Date.now(), ttlSeconds }) {
  const plan_id = planId(contract)
  return recordingRefusals({ repoDir, keys, missionId: contract.id, kind: 'authorization_refused', plan_id }, async () => {
    let report
    try {
      report = loadReport(repoDir, contract.id, plan_id)
    } catch {
      throw new AuthorizationRefused('NO_REHEARSAL', 'this plan has not been rehearsed')
    }
    const problem = reportSignatureProblem(report, keys.publicKey)
    if (problem) throw new AuthorizationRefused('REPORT_INVALID', problem)
    if (report.plan_id !== plan_id) throw new AuthorizationRefused('REPORT_INVALID', 'report is for a different plan')
    // Decisions below read the chain, so it must verify first.
    const chain = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId: contract.id })
    if (!chain.ok) throw new AuthorizationRefused('CHAIN_INVALID', `receipt chain does not verify: ${chain.findings[0].problem}`)
    const reportHash = hashValue(report)
    const rehearsal = findLast(chain.receipts, (r) => r.kind === 'rehearsal' && r.subject?.report_hash === reportHash)
    if (!rehearsal) throw new AuthorizationRefused('REPORT_INVALID', 'no rehearsal receipt matches this report')
    const currentFingerprint = await computeFingerprint({ repoDir, target: realTargetOf(repoDir, target), contract, contractHash })
    // Verdict and fidelity first (issueAuthorization is pure); then the selection gate on the current base.
    issueAuthorization({ cwd: repoDir, contract, contractHash, report, currentFingerprint, keys, now, ttlSeconds })
    const selection = selectionGate({
      receipts: chain.receipts,
      planId: plan_id,
      reportHash,
      baseHash: baseHash(currentFingerprint),
      replay: (receiptHash) => verifySelection({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId: contract.id, receiptHash }),
    })
    const auth = issueAuthorization({ cwd: repoDir, contract, contractHash, report, currentFingerprint, keys, now, ttlSeconds, selection: { mode: selection.mode, receipt: selection.receipt } })
    mkdirSync(path.join(repoDir, STATE_DIR), { recursive: true })
    writeFileSync(authorizationPath(repoDir), JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
    appendReceipt({
      repoDir,
      keys,
      missionId: contract.id,
      kind: 'authorization_issued',
      verdict: 'allow',
      subject: {
        plan_id,
        authorization_hash: hashValue(auth),
        fingerprint_hash: auth.fingerprint_hash,
        base_hash: baseHash(currentFingerprint),
        expires_at: auth.expires_at,
        selection_mode: selection.mode,
        stale_selection_ignored: selection.stale_selection_ignored,
      },
      refs: { rehearsal: rehearsal.hash, ...(selection.receipt ? { selection: selection.receipt } : {}) },
      now,
    })
    return auth
  })
}

export async function runMission({ repoDir, contract, contractHash, target, keys, now = Date.now() }) {
  const plan_id = planId(contract)
  return recordingRefusals({ repoDir, keys, missionId: contract.id, kind: 'run_refused', plan_id }, async () => {
    const publicKey = keys?.publicKey
    const file = authorizationPath(repoDir)
    if (!existsSync(file)) throw new AuthorizationRefused('NO_AUTHORIZATION', 'no authorization for a real run')
    const auth = JSON.parse(readFileSync(file, 'utf8'))
    const problem = signatureProblem(auth, publicKey)
    if (problem) throw new AuthorizationRefused('AUTHORIZATION_INVALID', problem)
    if (auth.mission_id !== contract.id || auth.contract_hash !== contractHash || auth.plan_id !== plan_id) {
      throw new AuthorizationRefused('AUTHORIZATION_INVALID', 'authorization is for a different mission, contract or plan')
    }
    if (now < Date.parse(auth.issued_at) || now > Date.parse(auth.expires_at)) throw new AuthorizationRefused('EXPIRED', 'authorization expired')
    const issued = findLast(readChain(repoDir, contract.id), (r) => r.kind === 'authorization_issued' && r.subject?.authorization_hash === hashValue(auth))
    if (!issued) throw new AuthorizationRefused('AUTHORIZATION_INVALID', 'no authorization_issued receipt matches this authorization')

    const realTarget = realTargetOf(repoDir, target)
    const current = await computeFingerprint({ repoDir, target: realTarget, contract, contractHash })
    if (hashValue(current) !== auth.fingerprint_hash) {
      const report = loadReport(repoDir, contract.id, auth.plan_id)
      throw new AuthorizationRefused('FIDELITY_MISMATCH', 'real target changed since authorization', compareFingerprints(report.fingerprint, current).diffs)
    }

    // R4.1, R4.2: capture before anything executes. If capture fails, nothing ran and
    // the authorization is left unconsumed so the operator can fix the cause and retry.
    let manifest
    try {
      manifest = await captureState({ repoDir, contract, target: realTarget, keys, now })
    } catch (err) {
      throw new AuthorizationRefused('CAPTURE_FAILED', `pre-run capture failed, nothing was executed: ${err.message}`)
    }

    // Consume before executing: a crash mid-run must not leave a reusable authorization.
    renameSync(file, path.join(repoDir, STATE_DIR, `authorization.used-${auth.signature.slice(0, 16)}.json`))
    const steps = await executeSteps({ plan: contract.plan, cwd: repoDir, target: realTarget, mode: 'real' })
    const ok = steps.every((s) => s.status === 'ok' || s.status === 'skipped_needs_approval')
    const { hash } = appendReceipt({
      repoDir,
      keys,
      missionId: contract.id,
      kind: 'run_result',
      verdict: ok ? 'completed' : 'failed',
      subject: { plan_id, capture_id: manifest.capture_id, manifest_hash: hashValue(manifest), steps: steps.map((s) => ({ id: s.id, status: s.status, detail: s.detail })) },
      refs: { authorization: issued.hash },
    })
    return { mission_id: contract.id, plan_id: auth.plan_id, capture_id: manifest.capture_id, steps, ok, receipt_hash: hash }
  })
}
