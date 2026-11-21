/**
 * Ownership and environment rules of scripts/live-run.mjs, kept apart so that they can be tested
 * without Docker or Kiro.
 *
 * The state file names directories that `down` removes and a Compose project that it stops. They
 * are used only when they look like what setup made: directly under the system temp directory with
 * this scenario's prefixes, real directories (not symbolic links) owned by the current user, each
 * holding the owner marker with the nonce recorded in the state file, and, once setup has started
 * the Compose project, a workspace target file that names that project. The marker guards against mistakes and against a swapped or
 * hand-edited state file; it is not a cryptographic proof, and a process running as the same OS
 * user can still forge it.
 */
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MARKER = '.jrm-live-owner'
export const NONCE_RE = /^[0-9a-f]{32}$/
export const PREFIXES = ['live', 'live2']

/** Variables Kiro, Docker and the JustRunMe CLI need; everything else in the caller's environment stays out. */
export const ENV_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'TZ', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
]

/** A copy of the allowed variables of `src`, then `extra` on top. */
export function allowEnv(src, extra = {}) {
  const env = {}
  for (const k of ENV_ALLOW) if (typeof src[k] === 'string') env[k] = src[k]
  return { ...env, ...extra }
}

// Kiro executes this command through a shell. Quote the absolute path as one
// argument rather than rejecting valid temporary directories containing spaces.
// Reject control characters and traversal before quoting; no shell expansion is possible.
export function hookCommand(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.split('/').includes('..') || /[\x00-\x1f\x7f]/.test(file)) {
    throw new Error('the hook path must be an absolute path without traversal or control characters')
  }
  return `node '${file.replaceAll("'", "'\\''")}'`
}

export function writeMarker(dir, nonce) {
  writeFileSync(path.join(dir, MARKER), nonce + '\n', { mode: 0o600, flag: 'wx' })
}

function exists(p) {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function realOwnDir(p, uid) {
  let st
  try {
    st = lstatSync(p)
  } catch {
    return 'does not exist'
  }
  if (st.isSymbolicLink()) return 'is a symbolic link'
  if (!st.isDirectory()) return 'is not a directory'
  if (uid !== null && st.uid !== uid) return 'belongs to another user'
  return null
}

function markerProblem(dir, nonce) {
  const file = path.join(dir, MARKER)
  try {
    const st = lstatSync(file)
    if (!st.isFile()) return 'has no owner marker file'
    return readFileSync(file, 'utf8').trim() === nonce ? null : 'has another owner marker'
  } catch {
    return 'has no owner marker'
  }
}

/**
 * @param {any} s parsed state file
 * @param {{ tmp: string, prefix: string, uid?: number | null }} opts tmp is the real path of the system temp directory
 * @returns {string[]} problems; empty when every resource is one setup made
 */
export function ownedState(s, { tmp, prefix, uid = typeof process.getuid === 'function' ? process.getuid() : null }) {
  if (!PREFIXES.includes(prefix)) return [`unknown prefix ${prefix}`]
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['the state file is not an object']
  const under = (p, start) => typeof p === 'string' && path.isAbsolute(p) && path.dirname(p) === tmp && path.basename(p).startsWith(start) && path.basename(p).length > start.length
  const problems = []
  if (typeof s.nonce !== 'string' || !NONCE_RE.test(s.nonce)) problems.push('the state file has no owner nonce')
  if (!under(s.ws, `jrm-${prefix}-ws-`)) problems.push('the workspace is not one this script made')
  if (!under(s.install, `jrm-${prefix}-install-`)) problems.push('the install directory is not one this script made')
  if (typeof s.ws !== 'string' || s.home !== `${s.ws}-keys`) problems.push('the key directory is not next to the workspace')
  if (typeof s.project !== 'string' || !new RegExp(`^jrm-${prefix}-[0-9a-f]{6}$`).test(s.project)) problems.push('the Compose project name is not one this script made')
  if (problems.length) return problems
  for (const [label, dir] of [['workspace', s.ws], ['key directory', s.home], ['install directory', s.install]]) {
    // An interrupted `down` (state `removing`) may already have removed some directories.
    if (s.removing === true && !exists(dir)) continue
    const p = realOwnDir(dir, uid) ?? markerProblem(dir, s.nonce)
    if (p) problems.push(`the ${label} ${p}`)
  }
  if (problems.length) return problems
  // The Compose project is stopped only after setup started it; then the workspace must name it.
  if (s.compose_started !== true) return problems
  try {
    if (JSON.parse(readFileSync(path.join(s.ws, 'justrunme.target.json'), 'utf8')).project !== s.project) problems.push('the workspace names another Compose project')
  } catch {
    problems.push('the workspace has no readable target file')
  }
  return problems
}
