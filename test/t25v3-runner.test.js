import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RUNNER = new URL('../scripts/t25v3-run.js', import.meta.url).pathname

/** The v3 runner refuses bad arguments before it creates anything (no Docker, no Kiro). */
describe('T25 v3 runner argument checks', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'jrm-t25v3-args-'))
  const run = (...args) => spawnSync(process.execPath, [RUNNER, '--out', path.join(out, 'o'), ...args], { encoding: 'utf8' })

  it('dry ids need --dry and --dry needs a dry id, in the control group only', () => {
    for (const args of [
      ['--group', 'control', '--task', 'A', '--run', 'D1'],
      ['--group', 'control', '--task', 'A', '--run', 'C1', '--dry', '/dev/null'],
      ['--group', 'treatment', '--task', 'A', '--run', 'D1', '--dry', '/dev/null'],
    ]) {
      const r = run(...args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /--dry runs only in the control group/)
    }
  })

  it('Task B runs in the treatment group only; unknown groups, tasks and ids are refused', () => {
    assert.equal(run('--group', 'control', '--task', 'B', '--run', 'C1').status, 2)
    assert.equal(run('--group', 'both', '--task', 'A', '--run', 'C1').status, 2)
    assert.equal(run('--group', 'control', '--task', 'C', '--run', 'C1').status, 2)
    assert.equal(run('--group', 'control', '--task', 'A', '--run', 'X1').status, 2)
    assert.equal(run('--group', 'control', '--task', 'A', '--run', 'C1', '--out', '').status, 2)
  })

  it('nothing was created by the refused runs', () => {
    assert.equal(existsSync(path.join(out, 'o')), false)
    rmSync(out, { recursive: true, force: true })
  })
})
