/**
 * Judge report (T19, R8.4): structured result of `justrunme judge`.
 *
 * Pure functions, no I/O. The status is PASS only when every step of the scenario
 * ran and matched what was expected, and, where the budget applies, the whole run
 * stayed inside it. A missing step is never a pass.
 */

export const BUDGET_MS = 60000
// The opt-in hidden-trigger run adds four rehearsals (about 67 s in total on the reference Mac), so it has its own budget.
export const HIDDEN_TRIGGER_BUDGET_MS = 90000

/**
 * @typedef {object} StepResult
 * @property {string} id
 * @property {string} title
 * @property {'passed'|'failed'|'skipped'} status
 * @property {number|null} expected_exit
 * @property {number|null} observed_exit
 * @property {string|null} code             error.code of the command, if any
 * @property {{ name: string, ok: boolean, actual?: unknown }[]} checks
 */

/**
 * @typedef {object} CleanupStatus
 * @property {boolean} ok
 * @property {'clean'|'leftovers'|'unverified'} status
 * @property {{ kind: string, id: string }[]} leftovers
 * @property {string[]} errors
 */

/**
 * Fail closed: a missing or malformed cleanup status counts as unverified, and
 * anything other than an explicit clean status with no leftovers is not a pass.
 * @param {unknown} c
 * @returns {CleanupStatus}
 */
export function normalizeCleanup(c) {
  if (c && typeof c === 'object' && c.ok === true && c.status === 'clean' && (!Array.isArray(c.leftovers) || c.leftovers.length === 0) && (!Array.isArray(c.errors) || c.errors.length === 0)) {
    return { ok: true, status: 'clean', leftovers: [], errors: [] }
  }
  const leftovers = Array.isArray(c?.leftovers) ? c.leftovers.map((l) => ({ kind: String(l?.kind), id: String(l?.id) })) : []
  const errors = Array.isArray(c?.errors) ? c.errors.map(String) : c ? [] : ['cleanup_status_missing']
  return { ok: false, status: leftovers.length > 0 ? 'leftovers' : 'unverified', leftovers, errors }
}

/**
 * @param {{ stepResults: StepResult[], elapsedMs: number, imagesCached: boolean, missionId: string, publicKey: string|null,
 *           receipts: { seq: number, kind: string, verdict: string|null, hash: string }[], offline: { receipts: number, chain_findings: number, policy_findings: number } | null,
 *           story: object, cleanup?: CleanupStatus, budgetMs?: number }} input
 */
export function buildReport({ stepResults, elapsedMs, imagesCached, missionId, publicKey, receipts, offline, story, cleanup, budgetMs = BUDGET_MS }) {
  const failed = stepResults.filter((s) => s.status === 'failed')
  const skipped = stepResults.filter((s) => s.status === 'skipped')
  // The 60 s promise holds with the images on the machine. A first run that has to
  // download them is timed but not judged, and the report says so.
  const budgetEnforced = imagesCached
  const withinBudget = elapsedMs < budgetMs
  const findings = []
  for (const s of failed) findings.push({ code: 'STEP_FAILED', step: s.id, detail: s.checks.filter((c) => !c.ok).map((c) => c.name) })
  for (const s of skipped) findings.push({ code: 'STEP_SKIPPED', step: s.id })
  if (story?.error) findings.push({ code: 'BACKEND_ERROR', during: story.error.during })
  if (budgetEnforced && !withinBudget) findings.push({ code: 'OVER_BUDGET', elapsed_ms: elapsedMs, budget_ms: budgetMs })
  const cleanupStatus = normalizeCleanup(cleanup)
  if (!cleanupStatus.ok) findings.push({ code: 'CLEANUP_INCOMPLETE', status: cleanupStatus.status, leftovers: cleanupStatus.leftovers, errors: cleanupStatus.errors })
  const ok = findings.length === 0
  return {
    judge: {
      status: ok ? 'PASS' : 'FAIL',
      mission_id: missionId,
      elapsed_ms: Math.round(elapsedMs),
      budget_ms: budgetMs,
      within_budget: withinBudget,
      budget_enforced: budgetEnforced,
      budget_note: budgetEnforced ? 'images were on the machine' : 'images had to be downloaded first; the time is reported but not judged',
    },
    counts: {
      steps: stepResults.length,
      passed: stepResults.length - failed.length - skipped.length,
      failed: failed.length,
      skipped: skipped.length,
      receipts_verified: offline?.receipts ?? 0,
      mismatches: offline?.chain_findings ?? null,
      policy_violations: offline?.policy_findings ?? null,
    },
    cleanup: cleanupStatus,
    findings,
    story,
    steps: stepResults,
    receipts,
    operator_public_key: publicKey,
    limits: [
      'The demo runs against a throwaway Postgres 16 container with demo-only credentials. Database and cloud credentials in your environment are not passed to it; HOME and the DOCKER_* client settings are, because the Docker client needs them. The Docker daemon must be a local socket (DOCKER_HOST, DOCKER_CONTEXT and the configured context are checked); a socket forwarded to another machine cannot be detected.',
      'Undo covers the resource types named in the contract (here: the Postgres database and tracked files). Network calls and other external effects are not undoable.',
      'The authorization step of this demo is given automatically with a throwaway approver key. In real use a person decrypts the approver key with a passphrase typed at a terminal.',
      'JustRunMe is not a sandbox: plan steps run as the operating-system user.',
    ],
  }
}

/** A step outcome from a command: pass only when the exit code and every check match. */
export function stepResult({ id, title, expectedExit, observed, checks }) {
  const exitOk = observed.exit === expectedExit
  const all = [{ name: `exit code is ${expectedExit}`, ok: exitOk, actual: observed.exit }, ...checks]
  return { id, title, status: all.every((c) => c.ok) ? 'passed' : 'failed', expected_exit: expectedExit, observed_exit: observed.exit, code: observed.code ?? null, checks: all }
}

export const skippedStep = (id, title) => ({ id, title, status: 'skipped', expected_exit: null, observed_exit: null, code: null, checks: [] })
