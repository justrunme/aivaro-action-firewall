/**
 * T19 against real Docker and Postgres: `justrunme judge` end to end.
 * Runs on Linux (CI) or when JRM_DOCKER_TESTS=1 is set locally.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { EXIT } from '../src/cli/codes.js'
import { BUDGET_MS } from '../src/judge/report.js'

const enabled = process.platform === 'linux' || process.env.JRM_DOCKER_TESTS === '1'
const CLI = new URL('../src/cli/index.js', import.meta.url).pathname

describe('Demo judge: one command, a real Postgres, under 60 s', { skip: !enabled && 'needs Linux or JRM_DOCKER_TESTS=1' }, () => {
  it('shows DATA LOSS, DENY, the safe plan, ALLOW, run, undo and a chain that survives offline verification', () => {
    const callerKeys = mkdtempSync(path.join(os.tmpdir(), 'jrm-judge-caller-'))
    const started = Date.now()
    const r = spawnSync(process.execPath, [CLI, 'judge'], {
      encoding: 'utf8',
      env: { ...process.env, JUSTRUNME_HOME: callerKeys, AWS_SECRET_ACCESS_KEY: 'canary-not-a-real-secret', PGPASSWORD: 'canary-not-a-real-password' },
      timeout: 5 * BUDGET_MS,
    })
    const wall = Date.now() - started
    try {
      assert.equal(r.status, EXIT.OK, r.stdout + r.stderr)
      const out = JSON.parse(r.stdout)
      const rep = out.result
      assert.equal(rep.judge.status, 'PASS', JSON.stringify(rep.findings))
      assert.equal(rep.counts.failed + rep.counts.skipped, 0)
      assert.equal(rep.counts.steps, rep.steps.length)
      assert.deepEqual(rep.steps.map((s) => s.status), rep.steps.map(() => 'passed'))

      // The story the demo exists to tell.
      assert.equal(rep.story.dangerous.verdict, 'DATA LOSS')
      assert.ok(rep.story.dangerous.rows_lost.orders > 0)
      assert.equal(rep.story.denied.error, 'DATA_LOSS')
      assert.equal(rep.story.safe.verdict, 'SAFE')
      assert.equal(rep.story.selection.decided_by, 'R15.4.1')
      assert.equal(rep.story.allowed.selection_mode, 'selected')
      assert.equal(rep.story.run.status_column_added, true)
      assert.deepEqual([rep.story.undo.status, rep.story.undo.evidence_status], ['RECOVERED', 'recorded'])

      // R8.4: counts and status. Receipts are signed and listed with their hashes.
      assert.deepEqual([rep.counts.mismatches, rep.counts.policy_violations], [0, 0])
      assert.ok(rep.counts.receipts_verified >= 8)
      assert.match(rep.operator_public_key, /^[0-9a-f]{64}$/)
      assert.ok(rep.receipts.every((x) => /^sha256:[0-9a-f]{64}$/.test(x.hash)))

      // R8.2: inside 60 s whenever the images were already local (CI pre-pulls them).
      if (rep.judge.budget_enforced) {
        assert.ok(rep.judge.elapsed_ms < BUDGET_MS, `judge took ${rep.judge.elapsed_ms} ms`)
        assert.ok(wall < BUDGET_MS + 3000, `process took ${wall} ms`)
      }

      // Isolation: nothing of the caller's was used, nothing is left behind.
      assert.deepEqual(readdirSync(callerKeys), [], 'the judge never wrote to the caller key directory')
      assert.ok(!r.stdout.includes('canary-not-a-real'), 'caller credentials are not in the output')
      assert.ok(!r.stdout.includes(os.homedir()), 'no home directory path in the output')
      const left = spawnSync('docker', ['ps', '-a', '--filter', `name=jrm-${rep.judge.mission_id}`, '--format', '{{.Names}}'], { encoding: 'utf8' })
      assert.equal(left.stdout.trim(), '', 'no judge container is left')
      const volumes = spawnSync('docker', ['volume', 'ls', '-q', '--filter', `name=jrm-${rep.judge.mission_id}`], { encoding: 'utf8' })
      assert.equal(volumes.stdout.trim(), '', 'no judge volume is left')
    } finally {
      rmSync(callerKeys, { recursive: true, force: true })
    }
  })
})
