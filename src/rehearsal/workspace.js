/**
 * Disposable copy of the workspace for rehearsal (R2.1, R2.4, R2.5).
 *
 * A detached git worktree at HEAD, then the uncommitted state is replayed into
 * it: the binary diff of tracked files and a copy of every untracked, non-ignored
 * file. The copy therefore contains exactly what the fingerprint measured.
 */

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, runOk } from '../util/exec.js'
import { STATE_DIR, untrackedFiles } from './../fidelity/source.js'

/**
 * @param {string} repoDir
 * @returns {Promise<{ dir: string, remove: () => Promise<void> }>}
 */
export async function createWorkspaceCopy(repoDir) {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'jrm-rehearsal-')))
  const dir = path.join(parent, 'ws')
  const remove = async () => {
    await run('git', ['worktree', 'remove', '--force', dir], { cwd: repoDir })
    await run('git', ['worktree', 'prune'], { cwd: repoDir })
    rmSync(parent, { recursive: true, force: true })
  }
  try {
    await runOk('git', ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD'], { cwd: repoDir })
    const diff = await runOk('git', ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD', '--', '.', `:(exclude)${STATE_DIR}`], { cwd: repoDir })
    if (diff.length > 0) await runOk('git', ['apply', '--binary', '--whitespace=nowarn'], { cwd: dir, input: diff })
    for (const file of untrackedFiles(repoDir)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      cpSync(path.join(repoDir, file), path.join(dir, file))
    }
    return { dir, remove }
  } catch (err) {
    await remove()
    throw err
  }
}
