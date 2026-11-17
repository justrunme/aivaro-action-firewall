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
import { keyHome, loadPublicKey } from '../receipts/keys.js'
import { verifyChain } from '../receipts/chain.js'
import { hashValue } from '../util/canonical.js'

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
]
