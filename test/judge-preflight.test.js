/**
 * Judge preflight: Node version, docker CLI and daemon are checked before the judge
 * creates anything. The probe is injected, so no real Docker (or lack of it) is needed.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JudgeEnvironmentError, createBackend } from '../src/judge/env.js'
import { CLI_TIMEOUT_MS, PreflightError, checkDockerCli, checkDockerDaemon, checkNode } from '../src/judge/preflight.js'

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

  describe('DOCKER_DEFAULT_PLATFORM', () => {
    const info = (stdout, extra = {}) => ({ code: 0, stdout, stderr: '', timedOut: false, ...extra })
    const daemon = (stdout, extra) => fakeProbe({ info: info(stdout, extra) })
    const envErr = (e) => e instanceof PreflightError && e.code === 'DOCKER_PLATFORM_ENV' && e.message.includes('ENV') && e.message.includes('unset DOCKER_DEFAULT_PLATFORM') && !e.message.includes('\n')
    const ctx = { code: 0, stdout: 'true\tunix:///var/run/docker.sock\n', stderr: '', timedOut: false }
    // After the preflight createBackend runs `docker version` through the real runner, not the probe. A PATH with
    // no docker makes that spawn fail, so a run that reaches it (DOCKER_UNAVAILABLE) has passed the whole preflight
    // and nothing is created.
    const NO_DOCKER_PATH = '/nonexistent-justrunme-path'
    const backendProbe = (infoAnswer) => fakeProbe({ context: ctx, info: infoAnswer })

    it('unset or empty: keeps the plain server-version probe', async () => {
      for (const env of [{}, { DOCKER_DEFAULT_PLATFORM: '' }]) {
        const { probe, calls } = daemon('26.1.0')
        await checkDockerDaemon(probe, env)
        assert.deepEqual(calls, [['docker', 'info', '--format', '{{.ServerVersion}}']])
      }
    })

    it('set: one probe returns version plus OS/arch', async () => {
      const { probe, calls } = daemon('26.1.0 linux/aarch64')
      await checkDockerDaemon(probe, { DOCKER_DEFAULT_PLATFORM: 'linux/arm64' })
      assert.deepEqual(calls, [['docker', 'info', '--format', '{{.ServerVersion}} {{.OSType}}/{{.Architecture}}']])
    })

    it('matching: passes, including arch aliases and variants', async () => {
      for (const [plat, out] of [['linux/arm64', 'linux/aarch64'], ['linux/amd64', 'linux/x86_64'], ['linux/arm64/v8', 'linux/arm64'], ['linux', 'linux/x86_64']]) {
        await checkDockerDaemon(daemon(`26.1.0 ${out}\n`).probe, { DOCKER_DEFAULT_PLATFORM: plat })
      }
    })

    it('mismatching: fails closed with an ENV error and the unset hint', async () => {
      for (const [plat, out] of [['linux/amd64', 'linux/aarch64'], ['linux/arm64', 'linux/x86_64'], ['windows/amd64', 'linux/x86_64']]) {
        await assert.rejects(checkDockerDaemon(daemon(`26.1.0 ${out}`).probe, { DOCKER_DEFAULT_PLATFORM: plat }), envErr)
      }
    })

    it('unparseable: bad variable and bad daemon output fail closed; failed or timed-out probe is unreachable', async () => {
      await assert.rejects(checkDockerDaemon(daemon('26.1.0 linux/arm64').probe, { DOCKER_DEFAULT_PLATFORM: 'not a platform' }), envErr)
      for (const out of ['garbage', '', 'linux/arm64']) {
        await assert.rejects(checkDockerDaemon(daemon(out).probe, { DOCKER_DEFAULT_PLATFORM: 'linux/arm64' }), envErr)
      }
      for (const extra of [{ code: 1 }, { timedOut: true }]) {
        await assert.rejects(checkDockerDaemon(daemon('26.1.0 linux/arm64', extra).probe, { DOCKER_DEFAULT_PLATFORM: 'linux/arm64' }), (e) => e.code === 'DOCKER_DAEMON_UNREACHABLE')
      }
    })

    it('createBackend: mismatched env is rejected as DOCKER_PLATFORM_ENV before any resource step', async () => {
      const { probe, calls } = backendProbe(info('26.1.0 linux/aarch64'))
      await rejectsWith(createBackend({ env: { PATH: '/bin', DOCKER_DEFAULT_PLATFORM: 'linux/amd64' }, probe }), 'DOCKER_PLATFORM_ENV')
      assert.deepEqual(calls.map((c) => c[1]), ['--version', 'context', 'info'])
    })

    it('createBackend: matching and unset pass the platform check and reach the step after the preflight', async () => {
      for (const [env, out] of [[{ DOCKER_DEFAULT_PLATFORM: 'linux/arm64' }, '26.1.0 linux/aarch64'], [{}, '26.1.0']]) {
        const { probe, calls } = backendProbe(info(out))
        await rejectsWith(createBackend({ env: { PATH: NO_DOCKER_PATH, ...env }, probe }), 'DOCKER_UNAVAILABLE')
        assert.deepEqual(calls.map((c) => c[1]), ['--version', 'context', 'info'])
      }
    })
  })

  it('happy path: passing probes raise nothing, and the daemon probe uses the shared 20000 ms timeout', async () => {
    const seen = []
    const probe = async (cmd, args, opts) => {
      seen.push({ args, timeoutMs: opts.timeoutMs })
      return ok
    }
    await checkDockerCli(probe, {})
    await checkDockerDaemon(probe, {})
    assert.equal(seen.find((s) => s.args[0] === 'info').timeoutMs, 20000)
    assert.equal(seen.find((s) => s.args[0] === '--version').timeoutMs, CLI_TIMEOUT_MS)
    assert.ok(seen.every((s) => Number.isFinite(s.timeoutMs)))
  })
})
