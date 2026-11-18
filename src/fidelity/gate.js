/**
 * Fidelity gate: compare two fingerprints component by component (R3.2, R3.3).
 *
 * Fingerprint shape (built by fingerprint.js):
 *   { base: { git_head, tree_hash, images, postgres: { <db>: { schema_hash, tables: { <t>: { rows, checksum } },
 *             logic: { triggers, functions, rules: { <name>: <definition hash> } } } } },
 *     plan: { source: { git_head, tree_hash, uncommitted_hash }, contract_hash, plan_hash } }
 * "base" is the state a plan starts from; two rehearsals are comparable only if
 * their base hashes are equal (R15.2). "plan" adds the plan's own files.
 */

import { canonicalJson, hashValue } from '../util/canonical.js'

/** Flatten nested objects to dotted paths with leaf values. */
function flatten(value, prefix = '', out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? `${prefix}.${key}` : key, out)
  } else {
    out[prefix] = value
  }
  return out
}

/**
 * @returns {{ ok: boolean, diffs: { component: string, before: unknown, after: unknown }[] }}
 */
export function compareFingerprints(before, after) {
  if (!before || !after) return { ok: false, diffs: [{ component: '(fingerprint)', before: before ?? null, after: after ?? null }] }
  const a = flatten(before)
  const b = flatten(after)
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  const diffs = []
  for (const k of keys) {
    if (canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null)) diffs.push({ component: k, before: a[k] ?? null, after: b[k] ?? null })
  }
  return { ok: diffs.length === 0, diffs }
}

/** Hash of the part of a fingerprint that a plan starts from. */
export function baseHash(fingerprint) {
  return hashValue(fingerprint.base)
}
