/**
 * Judge preflight: checks that run before the judge creates any directory, key,
 * container or signal handler. Each failure is one plain sentence that names what
 * is missing and how to fix it. The probe is injectable so tests need neither a
 * missing nor a broken Docker.
 */

export const MIN_NODE_MAJOR = 24
export const CLI_TIMEOUT_MS = 8000
// Shared with the docker context and version probes in env.js; a healthy slow CI daemon can exceed 8 s.
export const DAEMON_TIMEOUT_MS = 20000

export class PreflightError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Fails closed: an unparseable version is treated as too old. */
export function checkNode(version) {
  const major = /^\d+\.\d+\.\d+$/.test(String(version)) ? Number(String(version).split('.')[0]) : NaN
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new PreflightError('NODE_VERSION', `The judge demo needs Node.js ${MIN_NODE_MAJOR} or newer, but this is ${version}; install Node.js ${MIN_NODE_MAJOR}+ and run it again.`)
  }
}

/** The docker client must exist; this does not contact any daemon. */
export async function checkDockerCli(probe, env) {
  const r = await probe('docker', ['--version'], { timeoutMs: CLI_TIMEOUT_MS, env })
  if (r.code !== 0) {
    throw new PreflightError('DOCKER_MISSING', 'The judge demo needs the docker command, which was not found; install Docker (https://docs.docker.com/get-docker/) and run it again.')
  }
}

/** The daemon must answer within a finite time (DAEMON_TIMEOUT_MS). Call with an environment that already pins a local daemon. */
export async function checkDockerDaemon(probe, env) {
  const r = await probe('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: DAEMON_TIMEOUT_MS, env })
  if (r.code !== 0 || r.timedOut) {
    throw new PreflightError('DOCKER_DAEMON_UNREACHABLE', 'The Docker daemon is not reachable; start Docker Desktop or the docker service, check that `docker info` works, and run it again.')
  }
}
