/**
 * ProofDebt: what the receipts of a mission prove, and what they do not.
 *
 * Built only from a verified receipt chain, the mission contract and the target
 * configuration. Every "verified" line names the receipt it rests on. Everything the
 * chain does not show is a "not verified" line with the reason, including what
 * JustRunMe never tracks (external effects). There is no score and no percentage:
 * a missing proof is listed, never weighed.
 */
import { receiptHash } from '../receipts/chain.js'

const ref = (r) => ({ seq: r.seq, hash: receiptHash(r) })
const last = (receipts, pred) => [...receipts].reverse().find(pred) ?? null
const byHash = (receipts) => new Map(receipts.map((r) => [receiptHash(r), r]))

const CHANNEL = { tty: 'typed at a terminal', stdin: 'given on stdin (the Console, or a pipe)' }

/** Lines about the latest run and how it came to be authorized. */
function runLines(receipts, out) {
  const index = byHash(receipts)
  const run = last(receipts, (r) => r.kind === 'run_result')
  const auth = run ? index.get(run.refs?.authorization) : last(receipts, (r) => r.kind === 'authorization_issued')
  if (!auth) {
    out.not_verified.push({ id: 'authorization', text: 'No plan has been authorized in this mission', why: 'NO_AUTHORIZATION' })
  } else {
    const source = auth.subject?.passphrase_source ?? null
    if (CHANNEL[source]) out.verified.push({ id: 'authorization', text: `Authorized with the approver key; passphrase ${CHANNEL[source]} (the channel, not who typed it)`, receipt: ref(auth) })
    else if (source === 'env') out.not_verified.push({ id: 'authorization', text: 'The approval was scripted: the passphrase came from the environment', why: 'SCRIPTED_APPROVAL', receipt: ref(auth) })
    else out.not_verified.push({ id: 'authorization', text: 'How the approver passphrase was given is not recorded (older receipt)', why: 'CHANNEL_NOT_RECORDED', receipt: ref(auth) })
    const reh = index.get(auth.refs?.rehearsal)
    if (reh?.verdict === 'SAFE') out.verified.push({ id: 'rehearsal', text: 'The authorized plan rehearsed SAFE on a disposable copy', receipt: ref(reh) })
    else out.not_verified.push({ id: 'rehearsal', text: 'The authorization does not point at a SAFE rehearsal in this chain', why: 'NO_SAFE_REHEARSAL', receipt: ref(auth) })
  }
  if (!run) {
    out.not_verified.push({ id: 'execution', text: 'Nothing has run on the real database in this mission', why: 'NO_RUN' })
    return null
  }
  if (run.verdict === 'completed' && run.subject?.matches_rehearsal === true) out.verified.push({ id: 'execution', text: 'The real run completed and its result equals the rehearsal', receipt: ref(run) })
  else out.not_verified.push({ id: 'execution', text: run.subject?.matches_rehearsal === null ? 'The run recorded no comparison with the rehearsal' : `The run ${run.verdict}; ${run.subject?.differences ?? '?'} difference(s) from the rehearsal`, why: 'RUN_NOT_AS_REHEARSED', receipt: ref(run) })
  return run
}

const COVER_TEXT = {
  file_sha256: (n, c) => `${n} file checksum(s); ${c.files} file(s) captured`,
  file_absent: (n) => `${n} file(s) present that the capture did not have`,
  schema_hash: (n, c) => `schema hash of ${n} database(s); ${c.databases} captured`,
  row_count: (n, c) => `row counts of ${n} table(s); ${c.tables} captured${n !== c.tables ? ' (counted over the captured and the restored tables)' : ''}`,
  table_checksum: (n, c) => `checksums of ${n} table(s); ${c.tables} captured${n !== c.tables ? ' (counted over the captured and the restored tables)' : ''}`,
  privileges: (n, c) => `grants and ownership of ${n} database(s); ${c.databases} captured`,
  container_image: (n, c) => `image of ${n} container(s); ${c.container_images} captured`,
  health: (n) => `${n} health endpoint check(s)`,
}

/** Lines about the undo of the latest run and its verification receipt. */
function recoveryLines(receipts, run, out) {
  const undo = run ? last(receipts, (r) => r.kind === 'undo' && r.refs?.run === receiptHash(run)) : null
  if (!undo) return null
  const v = last(receipts, (r) => r.kind === 'verification' && r.refs?.undo === receiptHash(undo))
  if (!v) {
    out.not_verified.push({ id: 'recovery', text: 'The run was undone, but no recovery verification is recorded', why: 'NO_VERIFICATION', receipt: ref(undo) })
    return { verification: null, undo }
  }
  const s = v.subject ?? {}
  if (v.verdict !== 'PASS') {
    out.not_verified.push({ id: 'recovery', text: `Recovery verification ${v.verdict}`, why: v.verdict === 'UNVERIFIABLE' ? 'RECOVERY_UNVERIFIABLE' : 'RECOVERY_FAILED', receipt: ref(v) })
  } else if (!Array.isArray(s.checked)) {
    out.not_verified.push({ id: 'recovery', text: 'Recovery verification PASS, but this older receipt does not record which checks ran', why: 'CHECKS_NOT_RECORDED', receipt: ref(v) })
  } else {
    const cov = s.coverage
    for (const check of s.checked) {
      const n = cov?.by_check?.[check]
      const text = n !== undefined && COVER_TEXT[check] ? COVER_TEXT[check](n, cov.captured ?? {}) : check
      out.verified.push({ id: `recovery.${check}`, text: `Recovery checked: ${text}`, receipt: ref(v) })
    }
    if (!cov) out.not_verified.push({ id: 'recovery.coverage', text: 'How many resources each recovery check covered is not recorded (receipt before coverage)', why: 'COVERAGE_NOT_RECORDED', receipt: ref(v) })
  }
  for (const c of s.not_checked ?? []) out.not_verified.push({ id: `recovery.${c.check}`, text: `Recovery not checked: ${c.check} (${c.resource})`, why: 'NOT_CHECKED', receipt: ref(v) })
  if (s.coverage?.health === 'not configured' || (Array.isArray(s.checked) && !s.coverage && !s.checked.includes('health'))) {
    out.not_verified.push({ id: 'recovery.health', text: s.coverage ? 'Application health after recovery not checked (no health target configured)' : 'Application health after recovery not checked', why: 'HEALTH_NOT_CONFIGURED', receipt: ref(v) })
  }
  if (s.integration_tests !== undefined && s.integration_tests !== 'passed') out.not_verified.push({ id: 'recovery.integration_tests', text: `Integration tests after recovery: ${s.integration_tests ?? 'not run'}`, why: 'INTEGRATION_TESTS_NOT_RUN', receipt: ref(v) })
  if ((s.checked ?? []).includes('container_image')) out.not_verified.push({ id: 'recovery.containers', text: 'Containers are compared by image only; they are not rebuilt or restarted by undo', why: 'CONTAINERS_COMPARED_ONLY', receipt: ref(v) })
  return { verification: v, undo }
}

/**
 * @param {{ receipts: any[], contract?: any, legacyVersions?: number, gate?: any }} a
 *   receipts of a verified chain; contract parsed from the mission file, if present;
 *   legacyVersions from verifyHistory; gate from gateHealth
 */
export function proofDebt({ receipts, contract = null, legacyVersions = 0, gate = null }) {
  const out = { verified: [], not_verified: [] }

  if (gate?.status === 'ACTIVE') {
    const r = gate.observed?.hook_receipt ?? gate.recorded
    out.verified.push({ id: 'gate', text: `A PreToolUse hook in this workspace denied the gate probe command at ${r?.at ?? '?'} (the receipt names the workspace, not a session)`, receipt: r ? { seq: r.seq, hash: r.hash } : null })
  } else if (gate?.status === 'INACTIVE') {
    out.not_verified.push({ id: 'gate', text: 'The gate probe command ran unblocked: the session that ran it is not gated', why: 'GATE_INACTIVE', receipt: gate.recorded ? { seq: gate.recorded.seq, hash: gate.recorded.hash } : null })
  } else {
    out.not_verified.push({ id: 'gate', text: gate?.why === 'STALE' ? 'The last gate probe is older than 15 minutes' : gate?.why === 'WAITING_FOR_PROBE' ? 'Waiting for the agent to run the gate probe command' : 'No gate probe has shown that the current session is gated', why: gate?.why ?? 'NEVER_PROBED' })
  }

  const run = runLines(receipts, out)
  if (legacyVersions > 0) out.not_verified.push({ id: 'history', text: `${legacyVersions} rehearsal(s) older than the plan archive: their SQL cannot be checked against the receipt`, why: 'LEGACY_REHEARSALS' })
  const recovery = recoveryLines(receipts, run, out)

  for (const step of contract?.irreversible_actions ?? []) out.not_verified.push({ id: `irreversible.${step}`, text: `Plan step ${step} is irreversible: undo cannot restore it`, why: 'IRREVERSIBLE_STEP' })
  out.not_verified.push({ id: 'external', text: 'External side effects (network calls, e-mail, payments, remote storage) are not tracked by JustRunMe', why: 'OUT_OF_SCOPE' })

  const lastPass = last(receipts, (r) => r.kind === 'verification' && r.verdict === 'PASS' && Array.isArray(r.subject?.checked))
  const readiness = {
    last_verified_recovery: lastPass ? { ...ref(lastPass), at: lastPass.timestamp } : null,
    latest_run_recovery: !recovery ? (run ? 'NOT_UNDONE' : null) : !recovery.verification ? 'UNDONE · NOT VERIFIED' : recovery.verification.verdict === 'PASS' && !Array.isArray(recovery.verification.subject?.checked) ? 'PASS · CHECKS UNKNOWN' : recovery.verification.verdict,
    latest_run_recovery_receipt: recovery ? ref(recovery.verification ?? recovery.undo) : null,
    recovery_rehearsed: null,
    recovery_rehearsal_note: 'Recovery is not rehearsed in advance: JustRunMe does not implement recovery rehearsal (Chaos Twin) yet',
  }
  return { ...out, recovery_readiness: readiness }
}
