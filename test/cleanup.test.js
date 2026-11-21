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
import { EventEmitter } from 'node:events'
import { cleanupRehearsalCopies, installSignalGuard, sweepUntilQuiet } from '../src/judge/env.js'

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

describe('judge cleanup status (T49)', () => {
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false })
  const fast = { sleep: async () => {} }

  it('reports clean only after two quiet sweeps', async () => {
    const calls = []
    const docker = async (_cmd, args) => {
      calls.push(args[0])
      return ok()
    }
    const st = await cleanupRehearsalCopies('jrm-reh-x-', {}, { docker, ...fast })
    assert.deepEqual(st, { ok: true, status: 'clean', leftovers: [], errors: [] })
    assert.equal(calls.length, 6)
  })

  it('fails closed when the daemon is unreachable instead of reading silence as clean', async () => {
    let t = 0
    const docker = async () => ({ code: 1, stdout: '', stderr: 'Cannot connect', timedOut: false })
    const st = await cleanupRehearsalCopies('p-', {}, { docker, deadlineMs: 1000, intervalMs: 100, now: () => t, sleep: async (ms) => (t += ms) })
    assert.equal(st.ok, false)
    assert.equal(st.status, 'unverified')
    assert.deepEqual(st.errors, ['container_list_failed', 'volume_list_failed', 'network_list_failed'])
  })

  it('lists a container that cannot be removed as a leftover', async () => {
    let t = 0
    const docker = async (_cmd, args) => {
      if (args[0] === 'ps') return ok('abc123\n')
      if (args[0] === 'rm') return { code: 1, stdout: '', stderr: 'busy', timedOut: false }
      return ok()
    }
    const st = await cleanupRehearsalCopies('p-', {}, { docker, deadlineMs: 1000, intervalMs: 100, now: () => t, sleep: async (ms) => (t += ms) })
    assert.equal(st.ok, false)
    assert.equal(st.status, 'leftovers')
    assert.deepEqual(st.leftovers, [{ kind: 'container', id: 'abc123' }])
    assert.deepEqual(st.errors, ['container_remove_failed'])
  })

  it('a repeated signal does not exit early or start a second cleanup', async () => {
    const proc = new EventEmitter()
    proc.stderr = { write() {} }
    let release
    let cleanups = 0
    const exits = []
    installSignalGuard({
      cleanup: () => {
        cleanups++
        return new Promise((r) => (release = r))
      },
      proc,
      exit: (code) => exits.push(code),
    })
    proc.emit('SIGINT')
    proc.emit('SIGINT')
    proc.emit('SIGTERM')
    await new Promise((r) => setImmediate(r))
    assert.equal(cleanups, 1)
    assert.deepEqual(exits, [], 'no exit while cleanup runs')
    assert.equal(proc.listenerCount('SIGINT'), 1, 'the handler stays so a second Ctrl-C is absorbed')
    release({ ok: true })
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(exits, [130])
    assert.equal(proc.listenerCount('SIGINT'), 0)
  })

  it('still exits after a failed cleanup and tells the operator', async () => {
    const proc = new EventEmitter()
    const written = []
    proc.stderr = { write: (m) => written.push(m) }
    const exits = []
    const guard = installSignalGuard({ cleanup: async () => ({ ok: false }), proc, exit: (c) => exits.push(c) })
    proc.emit('SIGTERM')
    await guard.done()
    assert.deepEqual(exits, [143])
    assert.equal(written.length, 1)
  })
})

describe('judge cleanup status, more fault injection (T49)', () => {
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false })

  it('repeated cleanup is idempotent: a second call finds nothing and stays clean', async () => {
    const present = new Set(['v1'])
    const docker = async (_c, args) => {
      if (args[0] === 'volume' && args[1] === 'ls') return ok([...present].join('\n'))
      if (args[0] === 'volume' && args[1] === 'rm') {
        for (const id of args.slice(3)) present.delete(id)
        return ok()
      }
      return ok()
    }
    const fast = { docker, sleep: async () => {} }
    const first = await cleanupRehearsalCopies('p-', {}, fast)
    const second = await cleanupRehearsalCopies('p-', {}, fast)
    assert.equal(first.status, 'clean')
    assert.deepEqual(second, first)
  })

  it('a daemon that dies mid-cleanup is unverified, not clean', async () => {
    let t = 0
    let n = 0
    const docker = async () => (n++ < 3 ? ok() : { code: 1, stdout: '', stderr: 'gone', timedOut: true })
    const st = await cleanupRehearsalCopies('p-', {}, { docker, deadlineMs: 1000, intervalMs: 100, now: () => t, sleep: async (ms) => (t += ms) })
    assert.equal(st.ok, false)
    assert.equal(st.status, 'unverified')
  })

  it('an expired deadline before any sweep is unverified', async () => {
    const st = await cleanupRehearsalCopies('p-', {}, { docker: async () => ok(), deadlineMs: 0 })
    assert.equal(st.ok, false)
    assert.equal(st.status, 'unverified')
  })

  it('a signal during cleanup that leaves leftovers still exits once and reports incomplete', async () => {
    const proc = new EventEmitter()
    const written = []
    proc.stderr = { write: (m) => written.push(m) }
    const exits = []
    let release
    const guard = installSignalGuard({ cleanup: () => new Promise((r) => (release = r)), proc, exit: (c) => exits.push(c) })
    proc.emit('SIGTERM')
    proc.emit('SIGTERM')
    proc.emit('SIGINT')
    await new Promise((r) => setImmediate(r))
    assert.equal(guard.repeats(), 2)
    release({ ok: false, status: 'leftovers', leftovers: [{ kind: 'volume', id: 'v' }], errors: [] })
    await guard.done()
    assert.deepEqual(exits, [143])
    assert.equal(written.length, 1)
    assert.equal(proc.listenerCount('SIGTERM'), 0)
  })

  it('a cleanup that throws inside the signal handler still exits and does not reject unhandled', async () => {
    const proc = new EventEmitter()
    proc.stderr = { write() {} }
    const exits = []
    const guard = installSignalGuard({ cleanup: () => { throw new Error('x') }, proc, exit: (c) => exits.push(c) })
    proc.emit('SIGINT')
    await guard.done()
    assert.deepEqual(exits, [130])
  })
})
