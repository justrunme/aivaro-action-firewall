/**
 * Git-level source state (part of the fidelity fingerprint, R3.1).
 *
 * { git_head, tree_hash, uncommitted_hash }. The uncommitted hash covers the
 * binary diff of tracked files against HEAD plus the path and content hash of
 * every untracked, non-ignored file. JustRunMe's own state directory is
 * excluded so that writing audit lines does not change the fingerprint.
 * Synchronous on purpose: the PreToolUse hook calls it on every gated call.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runSync } from '../util/exec.js'
import { sha256Hex } from '../util/canonical.js'

export const STATE_DIR = '.justrunme'
const EXCLUDE = `:(exclude)${STATE_DIR}`

/**
 * @param {string} repoDir
 * @returns {string[]} untracked, non-ignored files, sorted
 */
export function untrackedFiles(repoDir) {
  const out = runSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', EXCLUDE], { cwd: repoDir }).toString('utf8')
  return out.split('\0').filter(Boolean).sort()
}

/**
 * @param {string} repoDir root of a git working tree
 * @returns {{ git_head: string, tree_hash: string, uncommitted_hash: string }}
 */
export function sourceState(repoDir) {
  const head = runSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString('utf8').trim()
  const tree = runSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoDir }).toString('utf8').trim()
  const diff = runSync('git', ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD', '--', '.', EXCLUDE], { cwd: repoDir })
  const parts = [sha256Hex(diff)]
  for (const file of untrackedFiles(repoDir)) {
    let content
    try {
      content = readFileSync(path.join(repoDir, file))
    } catch {
      content = Buffer.from('<unreadable>')
    }
    parts.push(`${file}\0${sha256Hex(content)}`)
  }
  return { git_head: head, tree_hash: tree, uncommitted_hash: 'sha256:' + sha256Hex(parts.join('\n')) }
}
