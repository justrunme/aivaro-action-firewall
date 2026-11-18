/**
 * PR 14 CI failure: an interrupted judge left a rehearsal copy's volume behind. The
 * child CLI was killed but its `docker compose up` was not, and one sweep ran before
 * the daemon had created the volume. These tests cover the two parts of the fix
 * without Docker: process groups are killed whole, and the sweep repeats until quiet.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { groupAlive, killGroup, run } from '../src/util/exec.js'
import { sweepUntilQuiet } from '../src/judge/env.js'

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return fn()
}

describe('judge cleanup after an interruption (PR 14 CI)', { skip: process.platform === 'win32' && 'process groups are POSIX' }, () => {
  it('killGroup stops the child and the grandchild it started', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jrm-group-'))
    const pidFile = path.join(dir, 'grandchild.pid')
    // The child starts a long-running grandchild (as the CLI starts docker compose) and waits.
    const script = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setInterval(() => {}, 1000)`
    let child
    const done = run(process.execPath, ['-e', script], { group: true, timeoutMs: 20000, onSpawn: (c) => (child = c) })
    assert.ok(await waitFor(() => {
      try {
        return Number(readFileSync(pidFile, 'utf8')) > 0
      } catch {
        return false
      }
    }), 'the grandchild started')
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    assert.equal(alive(grandchild), true)
    killGroup(child)
    await done
    assert.ok(await waitFor(() => !alive(grandchild)), 'the grandchild was killed with the group')
    assert.ok(await waitFor(() => !groupAlive(child.pid)), 'nothing of the group is left')
    rmSync(dir, { recursive: true, force: true })
  })

  it('sweeps again when an object appears after a clean sweep, and stops after two clean sweeps in a row', async () => {
    // What CI saw: the first sweep finds nothing, then the daemon finishes creating a volume.
    const found = [0, 1, 0, 0, 5]
    let calls = 0
    const quiet = await sweepUntilQuiet(async () => found[calls++], { sleep: async () => {} })
    assert.equal(quiet, true)
    assert.equal(calls, 4, 'one sweep is not trusted; the late volume is removed and two clean sweeps follow')
  })

  it('gives up at the deadline and says so instead of looping forever', async () => {
    let t = 0
    let calls = 0
    const quiet = await sweepUntilQuiet(async () => {
      calls++
      return 1
    }, { deadlineMs: 1000, intervalMs: 100, now: () => t, sleep: async (ms) => (t += ms) })
    assert.equal(quiet, false)
    assert.equal(calls, 10)
  })
})
