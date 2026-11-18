/**
 * Approval requests (T23): how an agent asks and how the operator answers.
 *
 * The agent can only ask. A request names one rehearsed plan, binds the signed
 * report, the base state, the exact SQL files (by SHA-256) and an expiry, is
 * signed with the operator key by the MCP server, and is recorded as an
 * approval_requested receipt. The answer is a run authorization signed by the
 * approver key, which only `justrunme approve` can produce. A request is
 * answered once: the chain itself shows whether an authorization already
 * answered it (receipt policy rule 7), not only a file next to it.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { STATE_DIR } from '../fidelity/source.js'
import { redact } from '../privacy/redact.js'
import { appendReceipt, receiptHash, verifyChain } from '../receipts/chain.js'
import { publicKeyHex, signValue, verifyValue } from '../receipts/keys.js'
import { hashValue } from '../util/canonical.js'

export const REQUEST_TTL_SECONDS = 3600
export const REQUEST_ID_RE = /^apr-[0-9a-f]{16}$/
const NOTE_MAX = 300

export class ApprovalError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [detail] */
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export const approvalsDir = (repoDir, missionId) => path.join(repoDir, STATE_DIR, 'missions', missionId, 'approvals')
const requestFile = (repoDir, missionId, id) => path.join(approvalsDir(repoDir, missionId), `${id}.json`)

export const sha256File = (file) => 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * @param {object} a
 * @param {{ privateKey: any, publicKey: any, home: string }} a.keys operator keys (the MCP server has them)
 * @param {{ id: string, time_limit_seconds: number }} a.contract effective contract of the plan
 * @param {string} a.contractHash
 * @param {any} a.report verified, signed rehearsal report with verdict SAFE
 * @param {string} a.rehearsalReceipt hash of the rehearsal receipt that recorded the report
 * @param {{ path: string, sha256: string }[]} a.files the SQL files, as hashed now
 * @param {string} [a.note] written by the agent; shown to the operator as the agent's words
 */
export function createRequest({ repoDir, keys, contract, contractHash, report, rehearsalReceipt, files, note = '', now = Date.now() }) {
  const ttl = Math.min(REQUEST_TTL_SECONDS, contract.time_limit_seconds)
  const body = {
    version: 1,
    request_id: 'apr-' + randomBytes(8).toString('hex'),
    mission_id: contract.id,
    plan_id: report.plan_id,
    contract_hash: contractHash,
    report_hash: hashValue(report),
    base_hash: report.base_hash,
    files,
    impact: { verdict: report.verdict, rows_deleted: report.rows_deleted ?? 0, schema_delta: report.schema_delta ?? null, duration_ms: report.duration_ms ?? null },
    agent_note: redact(String(note ?? '')).slice(0, NOTE_MAX),
    requested_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * 1000).toISOString(),
    operator_pubkey: publicKeyHex(keys.publicKey),
  }
  const request = { ...body, signature: signValue(keys.privateKey, body) }
  const request_hash = hashValue(request)
  // Receipt first, file second: a request without its receipt never exists.
  const receipt = appendReceipt({
    repoDir,
    keys,
    missionId: contract.id,
    kind: 'approval_requested',
    verdict: 'pending',
    subject: { request_id: body.request_id, request_hash, plan_id: body.plan_id, report_hash: body.report_hash, base_hash: body.base_hash, files_hash: hashValue(files), expires_at: body.expires_at },
    refs: { rehearsal: rehearsalReceipt },
    now,
  })
  mkdirSync(approvalsDir(repoDir, contract.id), { recursive: true })
  writeFileSync(requestFile(repoDir, contract.id, body.request_id), JSON.stringify(request, null, 2) + '\n')
  return { request, request_hash, receipt: receipt.hash }
}

/**
 * A request is accepted only if it carries the operator signature and an
 * approval_requested receipt records exactly this request.
 * @returns {{ request: any, request_hash: string, receipt: any }}
 */
export function loadRequest({ repoDir, missionId, id, publicKey, receipts }) {
  if (typeof id !== 'string' || !REQUEST_ID_RE.test(id)) throw new ApprovalError('REQUEST_INVALID', 'request id must look like apr-<16 hex>')
  const file = requestFile(repoDir, missionId, id)
  if (!existsSync(file)) throw new ApprovalError('REQUEST_UNKNOWN', `no approval request ${id}`)
  let request
  try {
    request = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new ApprovalError('REQUEST_INVALID', 'the request file is not valid JSON')
  }
  const { signature, ...body } = request
  if (!publicKey || body.operator_pubkey !== publicKeyHex(publicKey) || !verifyValue(publicKey, body, signature)) throw new ApprovalError('REQUEST_INVALID', 'the request is not signed by the operator key')
  if (body.request_id !== id || body.mission_id !== missionId) throw new ApprovalError('REQUEST_INVALID', 'the request is for another mission or id')
  const request_hash = hashValue(request)
  const receipt = receipts.find((r) => r.kind === 'approval_requested' && r.subject?.request_id === id && r.subject?.request_hash === request_hash)
  if (!receipt) throw new ApprovalError('REQUEST_NOT_RECORDED', 'no approval_requested receipt records this request')
  return { request, request_hash, receipt }
}

/**
 * State from the signed chain: answered by an authorization, denied, expired or pending.
 * @returns {'approved' | 'denied' | 'expired' | 'pending'}
 */
export function requestState(request, receipt, receipts, now = Date.now()) {
  const ref = receiptHash(receipt)
  if (receipts.some((r) => r.kind === 'authorization_issued' && r.refs?.approval === ref)) return 'approved'
  if (receipts.some((r) => r.kind === 'approval_denied' && r.refs?.approval === ref)) return 'denied'
  return now > Date.parse(request.expires_at) ? 'expired' : 'pending'
}

/** Every request of a mission with its state, newest first. Unreadable or unrecorded files are listed as invalid. */
export function listRequests({ repoDir, missionId, publicKey, home, now = Date.now() }) {
  const dir = approvalsDir(repoDir, missionId)
  if (!existsSync(dir)) return []
  const chain = verifyChain({ repoDir, home, publicKey, missionId })
  const out = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const id = name.slice(0, -5)
    try {
      const { request, request_hash, receipt } = loadRequest({ repoDir, missionId, id, publicKey, receipts: chain.receipts })
      out.push({ request_id: id, plan_id: request.plan_id, state: requestState(request, receipt, chain.receipts, now), requested_at: request.requested_at, expires_at: request.expires_at, request_hash })
    } catch (err) {
      out.push({ request_id: id, state: 'invalid', problem: err.message })
    }
  }
  return out.sort((a, b) => String(b.requested_at ?? '').localeCompare(String(a.requested_at ?? '')))
}
