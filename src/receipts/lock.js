/**
 * Exclusive lock around a receipt chain (T16.1).
 *
 * Several PreToolUse hook processes can run at the same time, and each one appends
 * a receipt. The lock file is created with O_EXCL ('wx'), so exactly one process
 * holds it. It contains an owner token "<pid> <host> <nonce>".
 *
 * A lock is never taken away because of its age. A waiter may remove it only if
 * the owner is provably gone: the token parses, the host is this host, and the
 * pid no longer exists. A live owner that is paused for minutes keeps the lock;
 * waiters time out and the hook denies (fail closed). A lock whose owner cannot
 * be determined (unparseable token, other host, pid reused by a live process) is
 * never removed automatically.
 *
 * Removal is race-checked: the lock is renamed to a unique tombstone and the
 * tombstone's token compared with the dead owner's token. If a different (live)
 * token was caught, it is put back with link(), which cannot overwrite.
 *
 * The holder also re-checks its own token before each write (`stillHeld`), and
 * the chain verifies seq and prev_hash on every append, so even a lost lock
 * cannot produce an accepted chain with duplicate or missing receipts: it would
 * fail verification and every later call would be denied until an operator acts.
 */

import { closeSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'

const pause = new Int32Array(new SharedArrayBuffer(4))
const sleep = (ms) => Atomics.wait(pause, 0, 0, ms)

function readToken(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** @returns {boolean} true only when the owner is provably dead on this host */
export function ownerIsGone(token) {
  const m = /^(\d+) (\S+) [0-9a-f]{16}\n$/.exec(token ?? '')
  if (!m || m[2] !== os.hostname()) return false
  try {
    process.kill(Number(m[1]), 0)
    return false // exists (or exists and belongs to someone else: EPERM below)
  } catch (err) {
    return err.code === 'ESRCH'
  }
}

function tryBreak(lockFile, deadToken) {
  const tomb = `${lockFile}.broken-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    renameSync(lockFile, tomb)
  } catch {
    return // already gone or replaced; just retry acquiring
  }
  if (readToken(tomb) !== deadToken) {
    // We caught a fresh lock taken by someone else in the meantime: put it back.
    try {
      linkSync(tomb, lockFile)
    } catch {
      // Another process created a lock meanwhile; the stolen owner will notice
      // through stillHeld() and abort its write.
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
    try {
      const fd = openSync(lockFile, 'wx', 0o600)
      writeSync(fd, token)
      closeSync(fd)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const current = readToken(lockFile)
      if (current !== null && ownerIsGone(current)) {
        tryBreak(lockFile, current)
        continue
      }
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the receipt chain lock (owner still running or unknown)')
      sleep(5 + Math.floor(Math.random() * 20))
    }
  }
  const stillHeld = () => readToken(lockFile) === token
  try {
    return fn(stillHeld)
  } finally {
    // Release only our own lock, never one that replaced it.
    if (stillHeld()) {
      try {
        unlinkSync(lockFile)
      } catch {
        // already gone
      }
    }
  }
}
