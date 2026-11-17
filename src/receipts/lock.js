/**
 * Exclusive lock around a receipt chain (T16.1).
 *
 * Several PreToolUse hook processes can run at the same time, and each one appends
 * a receipt. The lock file contains an owner token "<pid> <host> <nonce>".
 *
 * Creation never leaves an empty lock: the token is written to a private temp
 * file first, and the temp file is then hard-linked to the lock name. link()
 * fails if the name exists, so it is the atomic create-if-absent, and the lock
 * has its full content from the moment it exists. A crash can at worst leave a
 * stray temp file, which is not a lock.
 *
 * A lock is never taken away because of its age. A waiter removes it only if the
 * owner is provably gone: the token parses, the host is this host, and the pid no
 * longer exists. Removal is race-checked (rename to a tombstone, compare tokens,
 * put back with link() if a live lock was caught). The holder re-checks its own
 * token before each write and releases only its own lock.
 *
 * A lock whose owner cannot be determined (other host, unparseable content, pid
 * reused by a live process) is never removed automatically. inspectLock() and
 * recoverLock() are the explicit operator procedure for that case.
 */

import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { sha256Hex } from '../util/canonical.js'

const pause = new Int32Array(new SharedArrayBuffer(4))
const sleep = (ms) => Atomics.wait(pause, 0, 0, ms)
const TOKEN_RE = /^(\d+) (\S+) [0-9a-f]{16}\n$/

function readToken(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** @returns {'alive' | 'dead' | 'unknown'} */
export function ownerState(token) {
  const m = TOKEN_RE.exec(token ?? '')
  if (!m || m[2] !== os.hostname()) return 'unknown'
  try {
    process.kill(Number(m[1]), 0)
    return 'alive'
  } catch (err) {
    return err.code === 'ESRCH' ? 'dead' : 'alive' // EPERM: exists, owned by someone else
  }
}

/** @returns {boolean} true only when the owner is provably dead on this host */
export const ownerIsGone = (token) => ownerState(token) === 'dead'

/** Atomic create-if-absent with content already in place. @returns {boolean} acquired */
function createWithContent(lockFile, token) {
  const temp = `${lockFile}.new-${process.pid}-${randomBytes(4).toString('hex')}`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeSync(fd, token)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(temp, lockFile)
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  } finally {
    try {
      unlinkSync(temp)
    } catch {
      // already removed
    }
  }
}

function tryBreak(lockFile, deadToken) {
  const tomb = `${lockFile}.broken-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    renameSync(lockFile, tomb)
  } catch {
    return
  }
  if (readToken(tomb) !== deadToken) {
    try {
      linkSync(tomb, lockFile) // a live lock was caught: put it back
    } catch {
      // another lock exists now; the displaced owner notices through stillHeld()
    }
  }
  try {
    unlinkSync(tomb)
  } catch {
    // nothing to clean
  }
}

/**
 * @template T
 * @param {string} lockFile
 * @param {(stillHeld: () => boolean) => T} fn
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {T}
 */
export function withLock(lockFile, fn, { timeoutMs = 8000 } = {}) {
  const token = `${process.pid} ${os.hostname()} ${randomBytes(8).toString('hex')}\n`
  const started = Date.now()
  for (;;) {
    if (createWithContent(lockFile, token)) break
    const current = readToken(lockFile)
    if (current !== null && ownerIsGone(current)) {
      tryBreak(lockFile, current)
      continue
    }
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the receipt chain lock (owner still running or unknown)')
    sleep(5 + Math.floor(Math.random() * 20))
  }
  const stillHeld = () => readToken(lockFile) === token
  try {
    return fn(stillHeld)
  } finally {
    if (stillHeld()) {
      try {
        unlinkSync(lockFile)
      } catch {
        // already gone
      }
    }
  }
}

/** What an operator needs to decide about a stuck lock. */
export function inspectLock(lockFile) {
  if (!existsSync(lockFile)) return { exists: false }
  const content = readFileSync(lockFile)
  return {
    exists: true,
    sha256: 'sha256:' + sha256Hex(content),
    bytes: content.length,
    owner: ownerState(content.toString('utf8')),
  }
}

/**
 * Remove a lock the automatic rules refuse to touch, after an operator looked at it.
 * Compare-and-remove: the lock is renamed away and its content must hash to the
 * value the operator inspected; otherwise it is put back. A live local owner is
 * never removed. The removed file is kept next to the lock as evidence.
 *
 * @returns {{ removed_sha256: string, kept_as: string }}
 */
export function removeInspectedLock(lockFile, expectedSha256) {
  const seen = inspectLock(lockFile)
  if (!seen.exists) throw new Error('no lock to recover')
  if (seen.owner === 'alive') throw new Error('lock owner is a live process; refusing to remove it')
  if (seen.sha256 !== expectedSha256) throw new Error('lock changed since it was inspected; refusing to remove it')
  const kept = `${lockFile}.recovered-${Date.now()}-${randomBytes(3).toString('hex')}`
  renameSync(lockFile, kept)
  const taken = 'sha256:' + sha256Hex(readFileSync(kept))
  if (taken !== expectedSha256) {
    try {
      linkSync(kept, lockFile)
      unlinkSync(kept)
    } catch {
      // a new lock exists already; leave the caught file for inspection
    }
    throw new Error('lock was replaced while recovering; put back, nothing removed')
  }
  return { removed_sha256: taken, kept_as: kept }
}
