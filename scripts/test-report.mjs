// Runs the whole test suite and writes a test report that the Console Home screen shows:
//
//   npm run test:report            writes docs/test-report.json
//   node scripts/test-report.mjs --out <file>
//
// The report holds the counts the runner measured, the commit the tests ran on, whether
// the working tree had uncommitted changes, the finish time and, in GitHub Actions, the
// run URL. Nothing is typed in by hand. The script exits with the test run's exit code,
// and a failing run still writes its report (failed > 0), so a failure is never hidden.
//
// Written fresh for this repository.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { out: { type: 'string', default: path.join(root, 'docs', 'test-report.json') } } })

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
const commit = git('rev-parse', 'HEAD').stdout.trim()
const outRel = path.relative(root, path.resolve(values.out))
// The report file itself does not count as an uncommitted change.
const inside = !outRel.startsWith('..') && !path.isAbsolute(outRel)
const dirty = git('status', '--porcelain', '--', '.', ...(inside ? [`:(exclude)${outRel}`] : [])).stdout.trim().length > 0

const tmp = mkdtempSync(path.join(os.tmpdir(), 'jrm-report-'))
const counts = path.join(tmp, 'counts.json')
const run = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${path.join(root, 'scripts', 'test-reporter.mjs')}`, `--test-reporter-destination=${counts}`, 'test/**/*.test.js'],
  { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
)
let result
try {
  result = JSON.parse(readFileSync(counts, 'utf8').trim().split('\n').at(-1))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const e = process.env
const ci = e.GITHUB_ACTIONS === 'true'
const report = {
  schema: 1,
  ...result,
  commit: ci && /^[0-9a-f]{40}$/.test(e.GITHUB_SHA ?? '') ? e.GITHUB_SHA : commit,
  dirty: ci ? false : dirty,
  finished_at: new Date().toISOString(),
  node: process.version,
  exit_code: run.status ?? 1,
  ci: ci ? { provider: 'github-actions', run_url: `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}` } : null,
}
writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(`test report: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped, written to ${outRel}\n`)
process.exitCode = run.status ?? 1
