/**
 * Hook runner: reads the event and workspace files, evaluates, reports (R10.5, R10.6).
 *
 * Fail closed: any exception, malformed stdin, unreadable contract or timeout
 * produces exit code 2. Only an explicit allow decision returns 0.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseContract } from '../contract/parser.js'
import { hashValue } from '../util/canonical.js'
import { redact } from '../privacy/redact.js'
import { keyHome, loadExistingKeys, loadPublicKey } from '../receipts/keys.js'
import { appendReceipt } from '../receipts/chain.js'
import { signatureProblem } from '../authorize/authorization.js'
import { sourceState } from '../fidelity/source.js'
import { evaluate } from './evaluate.js'

const MAX_STDIN = 1024 * 1024
export const CONTRACT_FILE = 'justrunme.mission.yaml'
export const AUTHORIZATION_FILE = path.join('.justrunme', 'authorization.json')
export const AUDIT_FILE = path.join('.justrunme', 'audit.jsonl')

/** @param {NodeJS.ReadableStream} stream */
async function readAll(stream) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_STDIN) throw new Error('event larger than 1 MiB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Signature, then source binding: the authorization must be signed by the
 * operator key, and git HEAD, tree and uncommitted changes must be exactly what
 * they were when it was issued. Database state is re-checked by the runner.
 */
function authorizationCheck(auth, home, cwd) {
  const problem = signatureProblem(auth, loadPublicKey(home))
  if (problem) return { category: 'AUTHORIZATION_INVALID', reason: problem }
  let current
  try {
    current = hashValue(sourceState(cwd))
  } catch {
    return { category: 'FIDELITY_MISMATCH', reason: 'source state cannot be measured (not a git working tree?)' }
  }
  if (current !== auth.source_state_hash) return { category: 'FIDELITY_MISMATCH', reason: 'workspace files changed since the authorization was issued' }
  return null
}

function loadContext(cwd, now, home) {
  const ctx = { cwd, now, keyHome: home, contract: null, contractHash: '', authorization: null }
  const contractPath = path.join(cwd, CONTRACT_FILE)
  if (!existsSync(contractPath)) {
    ctx.contractError = `no ${CONTRACT_FILE} in the workspace`
    return ctx
  }
  const parsed = parseContract(readFileSync(contractPath, 'utf8'))
  if (!parsed.ok) {
    ctx.contractError = 'contract is invalid: ' + parsed.errors.map((e) => `${e.field} ${e.message}`).join('; ')
    return ctx
  }
  ctx.contract = parsed.contract
  ctx.contractHash = parsed.hash
  const authPath = path.join(cwd, AUTHORIZATION_FILE)
  if (existsSync(authPath)) {
    let auth = null
    try {
      auth = JSON.parse(readFileSync(authPath, 'utf8'))
    } catch {
      ctx.authorizationError = 'authorization file is not valid JSON'
      return ctx
    }
    const check = authorizationCheck(auth, home, cwd)
    if (check) {
      ctx.authorizationError = check.reason
      ctx.authorizationCategory = check.category
    } else {
      ctx.authorization = auth
    }
  }
  return ctx
}

function audit(cwd, line) {
  try {
    mkdirSync(path.join(cwd, '.justrunme'), { recursive: true })
    appendFileSync(path.join(cwd, AUDIT_FILE), JSON.stringify(line) + '\n')
  } catch {
    // The decision stands even if the audit line cannot be written.
  }
}

/**
 * @param {{ stdin: NodeJS.ReadableStream, stderr: { write(s: string): unknown },
 *           cwd: string, now?: () => number }} io
 * @returns {Promise<0 | 2>}
 */
export async function runHook({ stdin, stderr, cwd, now = Date.now, home = keyHome() }) {
  let event = null
  let result
  let ctx = null
  try {
    const text = await readAll(stdin)
    event = JSON.parse(text)
    ctx = loadContext(cwd, now(), home)
    result = evaluate(event, ctx)
  } catch (err) {
    result = { decision: 'deny', category: 'MALFORMED_EVENT', reason: redact(`hook error: ${err?.message ?? err}`) }
  }

  const actionHash = hashValue({ tool: event?.tool_name ?? null, input: event?.tool_input ?? null })
  const tool = typeof event?.tool_name === 'string' ? event.tool_name : null

  // T16.1: with an active contract, every decision is a signed receipt in the mission
  // chain before it takes effect. If it cannot be recorded, the call is denied: an
  // allow that is not on record never happens.
  let receiptHashValue = null
  if (ctx?.contract) {
    const keys = loadExistingKeys(home)
    if (!keys) {
      result = { decision: 'deny', category: 'NO_OPERATOR_KEY', reason: 'no operator key is installed; decisions cannot be signed' }
    } else {
      try {
        receiptHashValue = appendReceipt({
          repoDir: cwd,
          keys,
          missionId: ctx.contract.id,
          kind: 'hook_decision',
          verdict: result.decision,
          subject: { tool, action_hash: actionHash, category: result.category, reason: result.reason },
          now: now(),
        }).hash
      } catch (err) {
        result = { decision: 'deny', category: 'RECEIPT_FAILED', reason: redact(`decision could not be recorded: ${err?.message ?? err}`) }
      }
    }
  }

  const denialId = result.decision === 'deny' ? 'den-' + actionHash.slice(7, 23) : null
  audit(cwd, {
    ts: new Date(now()).toISOString(),
    decision: result.decision,
    category: result.category,
    reason: redact(result.reason),
    tool,
    action_hash: actionHash,
    denial_id: denialId,
    receipt_hash: receiptHashValue, // null when there is no contract or the receipt failed
  })

  if (result.decision === 'allow') return 0
  stderr.write(JSON.stringify({ justrunme: 'deny', category: result.category, reason: redact(result.reason), denial_id: denialId, receipt_hash: receiptHashValue }) + '\n')
  return 2
}
