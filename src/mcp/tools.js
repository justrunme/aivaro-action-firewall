/**
 * The tools of the JustRunMe MCP server (T21, T22).
 *
 * Where the CLI has a command (rehearse, compare, receipt, verify, replay) the tool
 * calls that command function, so the fidelity gate, the selection gate, the signed
 * receipts and the exit-code semantics are the CLI's, not a second copy. Around it
 * the tool adds what only an agent needs: proposing a plan from SQL files
 * (src/mission/plans.js), the attempt limit, reading a signed report, and an answer
 * that is structured, redacted and, for a rehearsal that did not come out SAFE, a
 * machine-readable explanation (src/explain/remediation.js).
 *
 * What a tool can never take as input: a connection string, a host, a database
 * name, a path outside allowed_paths, a shell command, a key (closed input
 * schemas, a test checks them). The real target comes only from
 * justrunme.target.json; the agent cannot write it while the gate is on
 * (JUSTRUNME_GATE=on and the hook's protected paths).
 */

import { readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as z from 'zod/v4'
import * as cmd from '../cli/commands.js'
import { ATTEMPT_LIMIT, explainReport } from '../explain/remediation.js'
import { AGENT_TOOLS } from './names.js'
import { PLAN_ID_RE, PlanRefused, loadBase, loadStoredPlan, proposePlan } from '../mission/plans.js'
import { redactDeep } from '../privacy/redact.js'
import { loadReport, reportSignatureProblem } from '../rehearsal/engine.js'
import { keyHome, loadExistingKeys, loadPublicKey } from '../receipts/keys.js'
import { findLast, verifyChain } from '../receipts/chain.js'
import { plansOnBase } from '../compare/gate.js'
import { createRequest, listRequests, loadRequest, sha256File } from '../approval/requests.js'
import { loadManifest } from '../capture/capture.js'
import { verifyRecovery } from '../undo/verify.js'
import { loadTarget } from '../cli/target.js'
import { hashValue } from '../util/canonical.js'
import { sourceState } from '../fidelity/source.js'

const planIdSchema = z.string().regex(PLAN_ID_RE)
const RESET_KINDS = new Set(['run_result', 'authorization_issued', 'undo'])

const tryReal = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Paths of this machine never leave the server. */
export function sanitize(value, repoDir) {
  // Rehearsal copies live in the system temporary directory; their paths can appear in error text.
  const pairs = [[repoDir, '$REPO'], [keyHome(), '$JUSTRUNME_HOME'], [os.tmpdir(), '$TMP'], [tryReal(os.tmpdir()), '$TMP']].filter(([p]) => p && p.length > 1).sort((a, b) => b[0].length - a[0].length)
  const walk = (v) => {
    if (typeof v === 'string') return pairs.reduce((s, [p, label]) => s.split(p).join(label), v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return redactDeep(walk(value))
}

const refusal = (code, message, extra = {}) => ({ status: 'REFUSED', error: { code, message }, ...extra })

/** Run a CLI command function; its refusals become structured results, other errors stay errors. */
async function viaCli(fn, args) {
  try {
    const r = await fn(args)
    return { ok: true, exit: r.exit, result: r.result }
  } catch (err) {
    if (err instanceof cmd.CliError) return { ok: false, refusal: refusal(err.code, err.message, { exit: err.exit, ...(err.detail !== undefined ? { detail: err.detail } : {}) }) }
    throw err
  }
}

/** Rehearsals since the last run, authorization or undo: the agent's attempts at this task. */
function attemptsUsed(repoDir, missionId) {
  const keys = loadPublicKey(keyHome())
  const chain = verifyChain({ repoDir, home: keyHome(), publicKey: keys, missionId })
  let used = 0
  for (const r of [...chain.receipts].reverse()) {
    if (RESET_KINDS.has(r.kind)) break
    if (r.kind === 'rehearsal') used += 1
  }
  return used
}

/** The signed report, accepted only if it carries the operator signature and a rehearsal receipt records it. */
function verifiedReport(repoDir, missionId, id) {
  const publicKey = loadPublicKey(keyHome())
  let report
  try {
    report = loadReport(repoDir, missionId, id)
  } catch {
    throw new PlanRefused('NO_REPORT', `no rehearsal report for ${id}`)
  }
  const problem = reportSignatureProblem(report, publicKey)
  if (problem) throw new PlanRefused('REPORT_INVALID', problem)
  const chain = verifyChain({ repoDir, home: keyHome(), publicKey, missionId })
  if (!chain.ok || !chain.receipts.some((r) => r.kind === 'rehearsal' && r.subject?.report_hash === hashValue(report))) {
    throw new PlanRefused('REPORT_NOT_RECORDED', 'no verified rehearsal receipt records this report')
  }
  return report
}

/** The text of the plan's SQL files as they are now; empty if they cannot be read (then no new object name is shown). */
function sqlTextOf(repoDir, id) {
  try {
    return loadStoredPlan(repoDir, id).contract.plan.map((s) => readFileSync(path.join(repoDir, s.args[0]), 'utf8')).join('\n')
  } catch {
    return ''
  }
}

/** The next step is named only if the agent can take it: until request_approval exists the agent hands over to the operator. */
const nextActionFor = (payload) => (payload.next_action === 'REQUEST_APPROVAL' && !AGENT_TOOLS.includes('request_approval') ? { ...payload, next_action: 'ASK_OPERATOR' } : payload)
// (kept as a guard: if a tool is ever removed from the allowlist, the agent is not pointed at it)

const pendingPayload = (request, already) => ({
  status: 'PENDING_APPROVAL',
  request_id: request.request_id,
  plan_id: request.plan_id,
  expires_at: request.expires_at,
  already_requested: already,
  files: request.files.map((f) => f.path),
  next_action: 'WAIT_FOR_OPERATOR',
  operator_steps: [`justrunme approvals ${request.request_id}`, `justrunme approve ${request.request_id} --confirm ${request.plan_id}`],
  note: 'Nothing is authorized yet and you cannot authorize it. Tell the user the request is waiting; call run_mission after the operator has answered.',
})

const guard = (fn) => async (ctx, args) => {
  try {
    return await fn(ctx, args)
  } catch (err) {
    if (err instanceof PlanRefused) return refusal(err.code, err.message, err.detail !== undefined ? { detail: err.detail } : {})
    throw err
  }
}

export const TOOLS = [
  {
    name: 'rehearse',
    title: 'Rehearse a migration plan',
    description:
      'Rehearse an ordered list of SQL migration files (inside the mission\'s allowed_paths) on a disposable, network-isolated copy of the database and measure the effect. The real database is only read to make the copy; it is not changed. Returns SAFE, or DENIED with the measured evidence, the constraints a revised plan must meet, and the next action. Revise the SQL files and call rehearse again after a denial.',
    inputSchema: z.strictObject({ migrations: z.array(z.string().min(1).max(200)).min(1).max(5).describe('Relative paths of .sql files, applied in this order') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: guard(async ({ repoDir }, { migrations }) => {
      const base = loadBase(repoDir)
      const before = attemptsUsed(repoDir, base.contract.id)
      if (before >= ATTEMPT_LIMIT) {
        return { status: 'DENIED', reason: 'ATTEMPT_LIMIT', next_action: 'ASK_OPERATOR', attempts: { used: before, limit: ATTEMPT_LIMIT }, error: { code: 'ATTEMPT_LIMIT', message: 'too many rehearsals without an authorized run; ask the operator before trying again' } }
      }
      const plan = proposePlan({ repoDir, migrations })
      const r = await viaCli(cmd.rehearseCmd, { repoDir, opts: { plan: plan.plan_id } })
      // T25 v2 Step 3: the mission itself cannot be met; no plan can fix that, so stop.
      if (!r.ok && r.refusal.error?.code === 'CONFLICT') {
        return { status: 'CONFLICT', message: r.refusal.error.message, conflicts: r.refusal.detail?.conflicts ?? [], plan_id: plan.plan_id, next_action: 'REPORT_TO_USER', note: 'Nothing was rehearsed or run. The requirements of the mission contradict each other on existing rows; only the operator can change the mission.' }
      }
      if (!r.ok) return { ...r.refusal, plan_id: plan.plan_id }
      const report = verifiedReport(repoDir, base.contract.id, plan.plan_id)
      return { ...nextActionFor(explainReport(report, { used: before + 1 }, { sqlText: sqlTextOf(repoDir, plan.plan_id) })), files: plan.files, rehearsal_exit: r.exit, cleanup_clean: report.cleanup?.clean ?? null }
    }),
  },
  {
    name: 'get_impact_report',
    title: 'Impact of a rehearsed plan',
    description: 'The measured impact of a plan that was rehearsed: verdict, rows lost per protected table, schema delta, and for a denied plan the constraints a revision must meet. Read-only; built from the signed report.',
    inputSchema: z.strictObject({ plan_id: planIdSchema }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: guard(async ({ repoDir }, { plan_id }) => {
      const base = loadBase(repoDir)
      const report = verifiedReport(repoDir, base.contract.id, plan_id)
      return { ...nextActionFor(explainReport(report, { used: attemptsUsed(repoDir, base.contract.id) }, { sqlText: sqlTextOf(repoDir, plan_id) })), rehearsed_at: report.rehearsed_at, duration_ms: report.duration_ms, report_hash: hashValue(report) }
    }),
  },
  {
    name: 'compare',
    title: 'Compare rehearsed plans',
    description: 'Compare the plans rehearsed on the current state by a fixed rule (data loss removes a plan, then the fastest wins) and record the choice as a signed receipt. Without plan_ids: every plan rehearsed on the latest state.',
    inputSchema: z.strictObject({ plan_ids: z.array(planIdSchema).max(10).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: guard(async ({ repoDir }, { plan_ids }) => {
      const r = await viaCli(cmd.compareCmd, { repoDir, opts: {}, planIds: plan_ids ?? [] })
      if (!r.ok) return r.refusal
      return { status: r.result.recommended ? 'RECOMMENDED' : 'NONE_SURVIVED', ...r.result }
    }),
  },
  {
    name: 'get_receipt',
    title: 'Read a signed receipt',
    description: 'A signed receipt of this mission by sequence number (default: the latest), with its hash and whether the whole chain verifies.',
    inputSchema: z.strictObject({ seq: z.int().min(0).optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: guard(async ({ repoDir }, { seq }) => {
      const r = await viaCli(cmd.receiptCmd, { repoDir, opts: seq === undefined ? {} : { seq: String(seq) } })
      return r.ok ? { status: r.exit === 0 ? 'OK' : 'CHAIN_INVALID', ...r.result } : r.refusal
    }),
  },
  {
    name: 'replay_mission',
    title: 'Re-verify the mission',
    description: 'Re-verify the signed receipt chain, the ordering policy and every recorded plan selection of this mission, offline. With a receipt hash: replay that one selection.',
    inputSchema: z.strictObject({ receipt: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: guard(async ({ repoDir }, { receipt }) => {
      const r = receipt === undefined ? await viaCli(cmd.verifyCmd, { repoDir, opts: {} }) : await viaCli(cmd.replayCmd, { repoDir, opts: { receipt } })
      return r.ok ? { status: r.exit === 0 ? 'PASS' : 'FAIL', ...r.result } : r.refusal
    }),
  },
  {
    name: 'request_approval',
    title: 'Ask the operator to approve a SAFE plan',
    description:
      'Ask the human operator to approve running one plan that was rehearsed with verdict SAFE. This only creates a request; it authorizes nothing. The operator reviews the exact SQL and the measured impact and approves or denies in a separate step you cannot take. After this, wait: call run_mission once the operator has answered.',
    inputSchema: z.strictObject({ plan_id: planIdSchema, note: z.string().max(300).optional().describe('One or two sentences for the operator: what this change is for. Shown to the operator as your words.') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: guard(async ({ repoDir }, { plan_id, note }) => {
      const base = loadBase(repoDir)
      const stored = loadStoredPlan(repoDir, plan_id)
      const report = verifiedReport(repoDir, base.contract.id, plan_id)
      if (report.verdict !== 'SAFE') {
        return { ...nextActionFor(explainReport(report, { used: attemptsUsed(repoDir, base.contract.id) }, { sqlText: sqlTextOf(repoDir, plan_id) })), error: { code: 'NOT_SAFE', message: 'approval can be requested only for a plan whose rehearsal verdict is SAFE' } }
      }
      const publicKey = loadPublicKey(keyHome())
      const chain = verifyChain({ repoDir, home: keyHome(), publicKey, missionId: base.contract.id })
      if (!chain.ok) return refusal('CHAIN_INVALID', 'the receipt chain does not verify; nothing was requested')
      const reportHash = hashValue(report)
      const rehearsal = findLast(chain.receipts, (r) => r.kind === 'rehearsal' && r.subject?.report_hash === reportHash)
      const latest = chain.receipts.filter((r) => r.kind === 'rehearsal').at(-1)
      if (!rehearsal || latest.subject?.base_hash !== report.base_hash) return refusal('PLAN_NOT_CURRENT', 'another state was rehearsed after this plan; rehearse this plan again before asking', { next_action: 'REHEARSE_AGAIN' })
      // The workspace must still be what was rehearsed; otherwise the operator would get a request that approve refuses.
      const rehearsedSource = report.fingerprint?.plan?.source
      if (!rehearsedSource || hashValue(sourceState(repoDir)) !== hashValue(rehearsedSource)) return refusal('PLAN_NOT_CURRENT', 'the workspace changed after this plan was rehearsed; rehearse it again before asking', { next_action: 'REHEARSE_AGAIN' })
      // Several plans rehearsed on this state: the fixed rule picks one; only that one can be asked about.
      if (plansOnBase(chain.receipts, report.base_hash).size > 1) {
        const c = await viaCli(cmd.compareCmd, { repoDir, opts: {}, planIds: [] })
        if (!c.ok) return c.refusal
        if (c.result.recommended !== plan_id) return refusal('NOT_RECOMMENDED', `the comparison recommends ${c.result.recommended ?? 'no plan'} (decided by ${c.result.decided_by}), not ${plan_id}`, { recommended: c.result.recommended, next_action: 'REQUEST_THE_RECOMMENDED_PLAN' })
      }
      const files = stored.contract.plan.map((s) => ({ path: s.args[0], sha256: sha256File(path.join(repoDir, s.args[0])) }))
      // Asking twice about the same rehearsed files returns the request that is already waiting.
      for (const existing of listRequests({ repoDir, missionId: base.contract.id, publicKey, home: keyHome() }).filter((x) => x.state === 'pending' && x.plan_id === plan_id)) {
        const { request } = loadRequest({ repoDir, missionId: base.contract.id, id: existing.request_id, publicKey, receipts: chain.receipts })
        if (request.report_hash === reportHash && JSON.stringify(request.files) === JSON.stringify(files)) return pendingPayload(request, true)
      }
      const keys = loadExistingKeys(keyHome())
      if (!keys) return refusal('NO_OPERATOR_KEY', 'no operator key is installed')
      const made = createRequest({ repoDir, keys, contract: stored.contract, contractHash: stored.hash, report, rehearsalReceipt: rehearsal.hash, files, note })
      return pendingPayload(made.request, false)
    }),
  },
  {
    name: 'run_mission',
    title: 'Run a plan the operator approved',
    description:
      'Run one plan on the real database. It runs only if the operator has approved it (a signed, single-use authorization exists for exactly this plan and the database and files are still as rehearsed); otherwise it is refused and nothing runs. Before the run the engine captures the state for undo. The answer compares the real result with what the rehearsal predicted and names the capture to use with undo_mission.',
    inputSchema: z.strictObject({ plan_id: planIdSchema }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: guard(async ({ repoDir }, { plan_id }) => {
      const base = loadBase(repoDir)
      loadStoredPlan(repoDir, plan_id)
      const r = await viaCli(cmd.runCmd, { repoDir, opts: { plan: plan_id } })
      if (!r.ok) {
        const waiting = listRequests({ repoDir, missionId: base.contract.id, publicKey: loadPublicKey(keyHome()), home: keyHome() }).filter((x) => x.plan_id === plan_id).slice(0, 3)
        const noAuth = r.refusal.error.code === 'NO_AUTHORIZATION'
        return { ...r.refusal, plan_id, approval_requests: waiting.map((x) => ({ request_id: x.request_id, state: x.state, expires_at: x.expires_at })), next_action: noAuth ? (waiting.some((x) => x.state === 'pending') ? 'WAIT_FOR_OPERATOR' : 'REQUEST_APPROVAL') : 'ASK_OPERATOR' }
      }
      const res = r.result
      const steps = res.steps.map((s) => ({ id: s.id, status: s.status, detail: String(s.detail ?? '').split('\n')[0].slice(0, 160) }))
      if (!res.ok) return { status: 'FAILED', plan_id, capture_id: res.capture_id, steps, receipt_hash: res.receipt_hash, next_action: 'UNDO_MISSION', undo: { tool: 'undo_mission', capture_id: res.capture_id } }
      // Measured by the run itself and recorded in its signed run_result (T27.1).
      const check = res.outcome ?? { matches: null, differences: [{ what: 'the run did not report a comparison' }] }
      return {
        status: check.matches === true ? 'COMPLETED' : check.matches === false ? 'COMPLETED_WITH_DIVERGENCE' : 'COMPLETED_UNCHECKED',
        plan_id,
        capture_id: res.capture_id,
        steps,
        receipt_hash: res.receipt_hash,
        matches_rehearsal: check.matches,
        differences: check.differences,
        next_action: check.matches === true ? 'REPORT_TO_USER' : 'ASK_OPERATOR',
        undo: { tool: 'undo_mission', capture_id: res.capture_id },
      }
    }),
  },
  {
    name: 'undo_mission',
    title: 'Restore the state captured before a run',
    description: 'Restore the files and the Postgres database captured before a run, then verify the recovery (row counts, checksums, schema, files). Covers only the resource types listed in the mission contract. Use it when run_mission failed or the result is not what the operator wants.',
    inputSchema: z.strictObject({ capture_id: z.string().regex(/^cap-\d{14}-[0-9a-f]{6}$/) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: guard(async ({ repoDir }, { capture_id }) => {
      const r = await viaCli(cmd.undoCmd, { repoDir, opts: {}, captureId: capture_id })
      if (!r.ok) return r.refusal
      return { status: r.result.status, capture_id, verification: r.result.verification, resources: r.result.resources.map((x) => ({ resource: x.resource, status: x.status })), evidence_status: r.result.evidence_status, receipts: r.result.receipts, next_action: r.result.status === 'RECOVERED' ? 'REPORT_TO_USER' : 'ASK_OPERATOR' }
    }),
  },
  {
    name: 'verify_recovery',
    title: 'Check the current state against a capture',
    description: 'Read-only: compare the current files and database with the state captured before a run (row counts, checksums, schema hash, files, images). Changes nothing and writes no receipt.',
    inputSchema: z.strictObject({ capture_id: z.string().regex(/^cap-\d{14}-[0-9a-f]{6}$/) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: guard(async ({ repoDir }, { capture_id }) => {
      const base = loadBase(repoDir)
      const { manifest, problem } = loadManifest(repoDir, base.contract.id, capture_id, loadPublicKey(keyHome()))
      if (problem) return refusal('CAPTURE_INVALID', problem)
      const { target, health } = loadTarget(repoDir)
      const v = await verifyRecovery({ repoDir, manifest, target: { ...target, composeFile: path.resolve(repoDir, target.composeFile) }, health })
      return { status: v.status, capture_id, checks: v.checks.length, failed: v.failed.map((c) => ({ check: c.check, resource: c.resource })) }
    }),
  },
]
