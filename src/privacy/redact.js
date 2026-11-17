/**
 * Redaction for logs, audit lines and reports (R11.1, R11.2).
 *
 * Approach: replace the current home directory and any /Users/<name> or
 * /home/<name> prefix with $HOME, mask e-mail addresses, and mask the value of
 * credential-looking assignments. Applied before anything is written.
 */

import os from 'node:os'

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const HOME_PREFIX = /(?:\/Users|\/home)\/[^\s/"'\\:]+|[A-Za-z]:\\Users\\[^\s\\"']+/g
const CREDENTIAL = /([A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key|authorization))(\s*[=:]\s*)(\S+)/gi
// user:password@ in connection strings (postgres://u:p@host/db)
const URL_CREDENTIAL = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g
// psql / Postgres message lines that can quote table values or SQL text
const DATA_LINE = /^\s*(psql:[^:]*:\d+:\s*)?(DETAIL|CONTEXT|QUERY|HINT|LINE \d+|STATEMENT|WHERE):|^\s*\^\s*$/

/**
 * @param {string} text
 * @param {string} [home] home directory to mask; defaults to the current user's
 * @returns {string}
 */
export function redact(text, home = os.homedir()) {
  let out = String(text)
  if (home && home.length > 1) out = out.split(home).join('$HOME')
  out = out.replace(HOME_PREFIX, '$HOME')
  out = out.replace(EMAIL, '[email]')
  out = out.replace(CREDENTIAL, '$1$2[REDACTED]')
  out = out.replace(URL_CREDENTIAL, '$1[REDACTED]@')
  return out
}

/**
 * Short, redacted summary of a tool's stderr for reports and receipts: the last
 * lines that are not Postgres DETAIL/CONTEXT/QUERY/... lines (those can quote
 * row values such as "Failing row contains (...)").
 *
 * @param {string} stderr
 * @param {number} [lines]
 */
export function errorSummary(stderr, lines = 3) {
  const kept = String(stderr)
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0 && !DATA_LINE.test(l))
  return redact(kept.slice(-lines).join(' | ')).slice(0, 300)
}

/**
 * Redact every string inside a JSON-compatible value (returns a copy).
 *
 * @param {unknown} value
 * @param {string} [home]
 * @returns {unknown}
 */
export function redactDeep(value, home) {
  if (typeof value === 'string') return redact(value, home)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, home))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, home)]))
  }
  return value
}
