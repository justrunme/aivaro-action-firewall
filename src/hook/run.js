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

function loadContext(cwd, now) {
  const ctx = { cwd, now, contract: null, contractHash: '', authorization: null }
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
    try {
      ctx.authorization = JSON.parse(readFileSync(authPath, 'utf8'))
    } catch {
      ctx.authorizationError = 'authorization file is not valid JSON'
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
export async function runHook({ stdin, stderr, cwd, now = Date.now }) {
  let event = null
  let result
  try {
    const text = await readAll(stdin)
    event = JSON.parse(text)
    result = evaluate(event, loadContext(cwd, now()))
  } catch (err) {
    result = { decision: 'deny', category: 'MALFORMED_EVENT', reason: redact(`hook error: ${err?.message ?? err}`) }
  }

  const actionHash = hashValue({ tool: event?.tool_name ?? null, input: event?.tool_input ?? null })
  const denialId = result.decision === 'deny' ? 'den-' + actionHash.slice(7, 23) : null
  audit(cwd, {
    ts: new Date(now()).toISOString(),
    decision: result.decision,
    category: result.category,
    reason: redact(result.reason),
    tool: typeof event?.tool_name === 'string' ? event.tool_name : null,
    action_hash: actionHash,
    denial_id: denialId, // unsigned until receipts exist (T16)
  })

  if (result.decision === 'allow') return 0
  stderr.write(JSON.stringify({ justrunme: 'deny', category: result.category, reason: redact(result.reason), denial_id: denialId }) + '\n')
  return 2
}
