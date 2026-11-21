/**
 * Judge preflight: Node version, docker CLI and daemon are checked before the judge
 * creates anything. The probe is injected, so no real Docker (or lack of it) is needed.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JudgeEnvironmentError, createBackend } from '../src/judge/env.js'
import { PreflightError, checkDockerCli, checkDockerDaemon, checkNode } from '../src/judge/preflight.js'

const ok = { code: 0, stdout: '', stderr: '', timedOut: false }

/** A probe that records its calls and answers from a table keyed by the first docker argument. */
function fakeProbe(answers) {
  const calls = []
  const probe = async (cmd, args) => {
    calls.push([cmd, ...args])
    return answers[args[0]] ?? ok
  }
  return { probe, calls }
}

const rejectsWith = (p, code) => assert.rejects(p, (err) => err instanceof JudgeEnvironmentError && err.code === code && !err.message.includes('\n'))

describe('Judge preflight', () => {
  it('accepts Node 24 and newer, refuses older or unparseable versions', () => {
    for (const v of ['24.0.0', '24.22.3', '25.1.0']) assert.doesNotThrow(() => checkNode(v))
    for (const v of ['23.9.0', '20.11.1', '', 'x', undefined]) assert.throws(() => checkNode(v), (e) => e instanceof PreflightError && e.code === 'NODE_VERSION')
  })

  it('docker missing: one sentence, code DOCKER_MISSING, nothing else probed', async () => {
    const { probe, calls } = fakeProbe({ '--version': { code: 1, stdout: '', stderr: 'spawn docker ENOENT', timedOut: false } })
    await rejectsWith(createBackend({ env: { PATH: '/bin' }, probe }), 'DOCKER_MISSING')
    assert.deepEqual(calls, [['docker', '--version']])
  })

  it('daemon unreachable: code DOCKER_DAEMON_UNREACHABLE, no container or directory step reached', async () => {
    const { probe, calls } = fakeProbe({
      context: { code: 0, stdout: 'true\tunix:///var/run/docker.sock\n', stderr: '', timedOut: false },
      info: { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', timedOut: false },
    })
    await rejectsWith(createBackend({ env: { PATH: '/bin' }, probe }), 'DOCKER_DAEMON_UNREACHABLE')
    assert.deepEqual(calls.map((c) => c[1]), ['--version', 'context', 'info'])
  })

  it('daemon timeout counts as unreachable even with exit code 0', async () => {
    const { probe } = fakeProbe({ info: { code: 0, stdout: '', stderr: '', timedOut: true } })
    await assert.rejects(checkDockerDaemon(probe, {}), (e) => e.code === 'DOCKER_DAEMON_UNREACHABLE')
  })

  it('old Node: refused before docker is probed', async () => {
    const { probe, calls } = fakeProbe({})
    await rejectsWith(createBackend({ env: { PATH: '/bin' }, probe, nodeVersion: '22.1.0' }), 'NODE_VERSION')
    assert.equal(calls.length, 0)
  })

  it('remote DOCKER_HOST is still refused before docker is probed', async () => {
    const { probe, calls } = fakeProbe({})
    await rejectsWith(createBackend({ env: { PATH: '/bin', DOCKER_HOST: 'tcp://10.0.0.1:2375' }, probe }), 'REMOTE_DOCKER')
    assert.equal(calls.length, 0)
  })

  it('happy path: passing probes raise nothing, and the daemon probe has a short timeout', async () => {
    const seen = []
    const probe = async (cmd, args, opts) => {
      seen.push(opts.timeoutMs)
      return ok
    }
    await checkDockerCli(probe, {})
    await checkDockerDaemon(probe, {})
    assert.ok(seen.every((t) => t <= 10000))
  })
})
