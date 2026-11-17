/**
 * Mission contract parser (R1.1, R1.2, R1.3).
 *
 * YAML text in, either a validated contract plus its hash or a structured list
 * of errors out. Fails closed: any syntax problem, warning, alias, duplicate
 * key or schema error means no contract.
 */

import { parseDocument } from 'yaml'
import { hashValue } from '../util/canonical.js'
import { validateContract } from './schema.js'

const MAX_BYTES = 256 * 1024

/**
 * @typedef {import('./schema.js').ContractError} ContractError
 * @typedef {{ ok: true, contract: any, hash: string }
 *   | { ok: false, errors: ContractError[] }} ParseResult
 */

/**
 * @param {string} text YAML source of justrunme.mission.yaml
 * @returns {ParseResult}
 */
export function parseContract(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, errors: [{ field: '(document)', message: 'contract text is empty' }] }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    return { ok: false, errors: [{ field: '(document)', message: 'contract is larger than 256 KiB' }] }
  }

  let doc
  try {
    // core schema: no timestamps or binary tags; uniqueKeys rejects duplicate keys;
    // maxAliasCount 0 rejects YAML aliases, so a field cannot be injected by reference.
    doc = parseDocument(text, { schema: 'core', uniqueKeys: true, maxAliasCount: 0, merge: false })
  } catch (err) {
    return { ok: false, errors: [{ field: '(yaml)', message: String(err?.message ?? err) }] }
  }

  const problems = [...doc.errors, ...doc.warnings]
  if (problems.length > 0) {
    return {
      ok: false,
      errors: problems.map((p) => ({
        field: p.linePos?.[0] ? `(yaml line ${p.linePos[0].line}, column ${p.linePos[0].col})` : '(yaml)',
        message: String(p.message).split('\n')[0],
      })),
    }
  }

  let value
  try {
    value = doc.toJS({ maxAliasCount: 0 })
  } catch (err) {
    return { ok: false, errors: [{ field: '(yaml)', message: String(err?.message ?? err).split('\n')[0] }] }
  }

  const errors = validateContract(value)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, contract: value, hash: hashValue(value) }
}
