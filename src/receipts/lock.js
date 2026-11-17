/**
 * Exclusive lock around a receipt chain (T16.1).
 *
 * Several PreToolUse hook processes can run at the same time, and each one appends
 * a receipt. Without a lock, two of them can read the same last receipt and both
 * write seq N, which breaks the chain. The lock is a file created with O_EXCL
 * ('wx'), so exactly one process holds it. Waiting is a short synchronous sleep;
 * the hook path is synchronous end to end.
 *
 * A lock older than staleMs is treated as left behind by a crashed process and
 * removed. A process that cannot get the lock within timeoutMs gets an error;
 * callers in the hook turn that into a deny (fail closed).
 */

import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'

const pause = new Int32Array(new SharedArrayBuffer(4))
const sleep = (ms) => Atomics.wait(pause, 0, 0, ms)

/**
 * @template T
 * @param {string} lockFile
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [opts]
 * @returns {T}
 */
export function withLock(lockFile, fn, { timeoutMs = 8000, staleMs = 30000 } = {}) {
  const started = Date.now()
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600)
      writeSync(fd, `${process.pid} ${Date.now()}\n`)
      closeSync(fd)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > staleMs) {
          unlinkSync(lockFile)
          continue
        }
      } catch {
        continue // removed by its holder between our attempts
      }
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the receipt chain lock')
      sleep(5 + Math.floor(Math.random() * 20))
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lockFile)
    } catch {
      // already gone; nothing to release
    }
  }
}
