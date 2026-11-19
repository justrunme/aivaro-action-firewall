/**
 * The verified test report that the Home screen shows. It is read from a file that
 * `npm run test:report` writes (scripts/test-report.mjs). Nothing here invents a number:
 * a file that is missing, unreadable, internally inconsistent or too old is reported as
 * "No verified test report", and the numbers are not passed on.
 *
 * Written fresh for this repository.
 */

import { readFileSync } from 'node:fs'

export const REPORT_MAX_AGE_DAYS = 30
const SHA_RE = /^[0-9a-f]{40}$/

/**
 * @param {string} file
 * @param {number} [now]
 * @returns {{ state: 'ok' | 'missing' | 'invalid' | 'stale', reason?: string, report?: object }}
 */
export function readTestReport(file, now = Date.now()) {
  let r
  try {
    r = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return err?.code === 'ENOENT' ? { state: 'missing', reason: 'no test report file' } : { state: 'invalid', reason: 'the test report cannot be read' }
  }
  const whole = (n) => Number.isInteger(n) && n >= 0
  if (r?.schema !== 1 || !whole(r.passed) || !whole(r.failed) || !whole(r.total) || r.passed + r.failed + (r.skipped ?? 0) !== r.total || r.total === 0) {
    return { state: 'invalid', reason: 'the counts of the test report do not add up' }
  }
  if (!SHA_RE.test(r.commit ?? '') || Number.isNaN(Date.parse(r.finished_at))) return { state: 'invalid', reason: 'the test report has no commit or time' }
  if (Date.parse(r.finished_at) > now + 5 * 60_000) return { state: 'invalid', reason: 'the test report is dated in the future' }
  const age = (now - Date.parse(r.finished_at)) / 86_400_000
  if (age > REPORT_MAX_AGE_DAYS) return { state: 'stale', reason: `the test report is ${Math.floor(age)} days old` }
  return {
    state: 'ok',
    report: {
      passed: r.passed,
      failed: r.failed,
      skipped: r.skipped ?? 0,
      total: r.total,
      commit: r.commit,
      finished_at: r.finished_at,
      // Where the numbers came from: a CI run is stronger evidence than a laptop.
      source: r.ci?.provider === 'github-actions' ? 'ci' : 'local',
      run_url: typeof r.ci?.run_url === 'string' && /^https:\/\/github\.com\//.test(r.ci.run_url) ? r.ci.run_url : null,
      dirty: r.dirty === true,
    },
  }
}
