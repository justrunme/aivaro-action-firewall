/**
 * Canonical JSON and hashing helpers.
 *
 * Approach: object keys are sorted and no whitespace is emitted, so two values
 * that are deeply equal always serialize to the same bytes. Every hash in
 * JustRunMe (contract, action, script, fingerprint) goes through this module.
 */

import { createHash } from 'node:crypto'

/**
 * @param {unknown} value JSON-compatible value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string' || type === 'boolean') return JSON.stringify(value)
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (type === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
  }
  throw new TypeError(`canonicalJson: unsupported type ${type}`)
}

/**
 * @param {string | Uint8Array} data
 * @returns {string} lowercase hex SHA-256
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * @param {unknown} value
 * @returns {string} `sha256:<hex>` of the canonical JSON of value
 */
export function hashValue(value) {
  return 'sha256:' + sha256Hex(canonicalJson(value))
}
