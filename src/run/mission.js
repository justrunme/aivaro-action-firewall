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
import { appendReceipt, findLast, verifyChain } from '../receipts/chain.js'

export const authorizationPath = (repoDir) => path.join(repoDir, STATE_DIR, 'authorization.json')

const realTargetOf = (repoDir, target) => ({ ...target, composeFile: path.resolve(repoDir, target.composeFile) })

/**
 * Write a refusal receipt, then rethrow the refusal. If the receipt cannot be
 * written (chain does not verify, lock held), the refusal still stands with its
 * own code; `recorded: false` says it is not in the chain.
 */
async function recordingRefusals({ repoDir, keys, missionId, kind, plan_id }, fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AuthorizationRefused) {
      try {
        appendReceipt({ repoDir, keys, missionId, kind, verdict: 'deny', subject: { plan_id, code: err.code, reason: err.message } })
        err.recorded = true
      } catch (recordErr) {
        err.recorded = false
        err.record_error = recordErr.code === 'CHAIN_LOCKED' ? 'CHAIN_LOCKED' : 'CHAIN_INVALID'
      }
    }
    throw err
  }
}

function verifiedReceipts(repoDir, keys, missionId) {
  const chain = verifyChain({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId })
  if (!chain.ok) throw new AuthorizationRefused('CHAIN_INVALID', `receipt chain does not verify: ${chain.findings[0].problem}`)
  return chain.receipts
}

function selectionFor({ repoDir, keys, missionId, receipts, planId: id, reportHash, currentFingerprint }) {
  return selectionGate({
    receipts,
    planId: id,
    reportHash,
    baseHash: baseHash(currentFingerprint),
    replay: (receiptHash) => verifySelection({ repoDir, home: keys.home, publicKey: keys.publicKey, missionId, receiptHash }),
  })
}

/**
 * @param {object} a
 * @param {{ privateKey: any, publicKey: any, home: string }} a.keys operator keys: reports, receipts
 * @param {{ privateKey: any, publicKey: any }} a.approver the decrypted approver key: signs the authorization
 * @param {{ request_id: string, request_hash: string, receipt: string } | null} [a.approval] the approval request being answered
 */
export async function authorizeMission({ repoDir, contract, contractHash, target, keys, approver, approval = null, now = Date.now(), ttlSeconds }) {
  const plan_id = planId(contract)
  return recordingRefusals({ repoDir, keys, missionId: contract.id, kind: 'authorization_refused', plan_id }, async () => {
    if (!approver?.privateKey) throw new AuthorizationRefused('NO_APPROVER_KEY', 'an authorization is signed by the approver key; none was given')
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
    const receipts = verifiedReceipts(repoDir, keys, contract.id)
    const reportHash = hashValue(report)
    const rehearsal = findLast(receipts, (r) => r.kind === 'rehearsal' && r.subject?.report_hash === reportHash)
    if (!rehearsal) throw new AuthorizationRefused('REPORT_INVALID', 'no rehearsal receipt matches this report')
    const currentFingerprint = await computeFingerprint({ repoDir, target: realTargetOf(repoDir, target), contract, contractHash })
    // Verdict and fidelity first (issueAuthorization is pure); then the selection gate on the current base.
    issueAuthorization({ cwd: repoDir, contract, contractHash, report, currentFingerprint, approver, now, ttlSeconds })
    const selection = selectionFor({ repoDir, keys, missionId: contract.id, receipts, planId: plan_id, reportHash, currentFingerprint })
    const auth = issueAuthorization({
      cwd: repoDir,
      contract,
      contractHash,
      report,
      currentFingerprint,
      approver,
      now,
      ttlSeconds,
      selection: { mode: selection.mode, receipt: selection.receipt },
      approval: approval ? { request_id: approval.request_id, request_hash: approval.request_hash } : null,
    })
    // Receipt first, file second: a file without its receipt never exists, so a
    // failed append cannot leave a live authorization behind.
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
      refs: { rehearsal: rehearsal.hash, ...(selection.receipt ? { selection: selection.receipt } : {}), ...(approval ? { approval: approval.receipt } : {}) },
      now,
    })
    mkdirSync(path.join(repoDir, STATE_DIR), { recursive: true })
    writeFileSync(authorizationPath(repoDir), JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
    return auth
  })
}

/**
 * @param {object} a
 * @param {{ privateKey: any, publicKey: any, home: string }} a.keys operator keys: receipts and the capture
 * @param {any} a.approverPublicKey only the public half: a run verifies an authorization, it never signs one
 */
export async function runMission({ repoDir, contract, contractHash, target, keys, approverPublicKey, now = Date.now() }) {
  const plan_id = planId(contract)
  return recordingRefusals({ repoDir, keys, missionId: contract.id, kind: 'run_refused', plan_id }, async () => {
    const publicKey = approverPublicKey
    const file = authorizationPath(repoDir)
    if (!existsSync(file)) throw new AuthorizationRefused('NO_AUTHORIZATION', 'no authorization for a real run')
    const auth = JSON.parse(readFileSync(file, 'utf8'))
    const problem = signatureProblem(auth, publicKey)
    if (problem) throw new AuthorizationRefused('AUTHORIZATION_INVALID', problem)
    if (auth.mission_id !== contract.id || auth.contract_hash !== contractHash || auth.plan_id !== plan_id) {
      throw new AuthorizationRefused('AUTHORIZATION_INVALID', 'authorization is for a different mission, contract or plan')
    }
    if (now < Date.parse(auth.issued_at) || now > Date.parse(auth.expires_at)) throw new AuthorizationRefused('EXPIRED', 'authorization expired')
    // Nothing runs on a chain that could not record the result.
    const receipts = verifiedReceipts(repoDir, keys, contract.id)
    const issued = findLast(receipts, (r) => r.kind === 'authorization_issued' && r.subject?.authorization_hash === hashValue(auth))
    if (!issued) throw new AuthorizationRefused('AUTHORIZATION_INVALID', 'no authorization_issued receipt matches this authorization')

    const realTarget = realTargetOf(repoDir, target)
    const current = await computeFingerprint({ repoDir, target: realTarget, contract, contractHash })
    const report = loadReport(repoDir, contract.id, auth.plan_id)
    if (hashValue(current) !== auth.fingerprint_hash) {
      throw new AuthorizationRefused('FIDELITY_MISMATCH', 'real target changed since authorization', compareFingerprints(report.fingerprint, current).diffs)
    }
    // The selection is checked again: a plan rehearsed or compared after the
    // authorization was issued must be taken into account before anything runs.
    selectionFor({ repoDir, keys, missionId: contract.id, receipts, planId: plan_id, reportHash: hashValue(report), currentFingerprint: current })

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
    const skipped = steps.filter((s) => s.status === 'skipped_needs_approval').map((s) => s.id)
    const result = { mission_id: contract.id, plan_id: auth.plan_id, capture_id: manifest.capture_id, steps, ok, skipped_needs_approval: skipped, receipt_hash: null }
    // The run has happened: if its receipt cannot be written (lock held after the
    // check above), report that instead of losing the result and the capture id.
    try {
      result.receipt_hash = appendReceipt({
        repoDir,
        keys,
        missionId: contract.id,
        kind: 'run_result',
        verdict: ok ? 'completed' : 'failed',
        subject: { plan_id, capture_id: manifest.capture_id, manifest_hash: hashValue(manifest), steps: steps.map((s) => ({ id: s.id, status: s.status, detail: s.detail })) },
        refs: { authorization: issued.hash },
      }).hash
    } catch (err) {
      result.receipt_error = err.code === 'CHAIN_LOCKED' ? 'CHAIN_LOCKED' : 'CHAIN_INVALID'
    }
    return result
  })
}
