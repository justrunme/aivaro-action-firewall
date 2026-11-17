/**
 * File capture and restore for the paths a mission may change (R4.1, R4.3).
 *
 * Scope: every regular file under the contract's allowed_paths and every file in
 * config_files. These are the only workspace paths the gate lets the agent write.
 * Content is copied into the capture directory; restore rewrites changed files,
 * recreates deleted ones and removes files that did not exist at capture time.
 * Symbolic links are not followed and not captured; they are listed as skipped.
 */

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { sha256Hex } from '../util/canonical.js'

const MAX_BYTES = 64 * 1024 * 1024
const SKIP_DIRS = new Set(['.git', '.justrunme'])

/** Normalized repository-relative roots to capture. */
export function captureRoots(contract) {
  return [...new Set([...contract.allowed_paths, ...contract.resources.config_files].map((p) => path.normalize(p).replace(/[\\/]+$/, '')))].sort()
}

/** @returns {{ files: string[], skipped: string[] }} repository-relative paths under the roots */
export function listFiles(repoDir, roots) {
  const files = new Set()
  const skipped = new Set()
  const walk = (rel) => {
    const abs = path.join(repoDir, rel)
    if (!existsSync(abs)) return
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return skipped.add(rel)
    if (st.isFile()) return files.add(rel)
    if (!st.isDirectory()) return skipped.add(rel)
    for (const name of readdirSync(abs).sort()) {
      if (SKIP_DIRS.has(name)) continue
      walk(path.join(rel, name))
    }
  }
  for (const root of roots) walk(root)
  return { files: [...files].sort(), skipped: [...skipped].sort() }
}

const fileHash = (abs) => 'sha256:' + sha256Hex(readFileSync(abs))

/**
 * @returns {{ roots: string[], files: { path: string, sha256: string, mode: number }[], skipped: string[] }}
 */
export function captureFiles(repoDir, contract, captureDir) {
  const roots = captureRoots(contract)
  const { files, skipped } = listFiles(repoDir, roots)
  let total = 0
  const entries = []
  for (const rel of files) {
    const abs = path.join(repoDir, rel)
    const st = statSync(abs)
    total += st.size
    if (total > MAX_BYTES) throw new Error('files to capture exceed 64 MiB')
    const dest = path.join(captureDir, 'files', rel)
    mkdirSync(path.dirname(dest), { recursive: true })
    copyFileSync(abs, dest)
    entries.push({ path: rel, sha256: fileHash(abs), mode: st.mode & 0o777 })
  }
  return { roots, files: entries, skipped }
}

/**
 * @returns {{ restored: string[], removed: string[], unchanged: number }}
 */
export function restoreFiles(repoDir, captured, captureDir) {
  const restored = []
  const removed = []
  let unchanged = 0
  const known = new Set(captured.files.map((f) => f.path))
  for (const f of captured.files) {
    const abs = path.join(repoDir, f.path)
    if (existsSync(abs) && lstatSync(abs).isFile() && fileHash(abs) === f.sha256) {
      unchanged++
      continue
    }
    const src = path.join(captureDir, 'files', f.path)
    if (fileHash(src) !== f.sha256) throw new Error(`captured copy of ${f.path} does not match its checksum`)
    if (existsSync(abs) && !lstatSync(abs).isFile()) rmSync(abs, { recursive: true, force: true })
    mkdirSync(path.dirname(abs), { recursive: true })
    copyFileSync(src, abs)
    chmodSync(abs, f.mode)
    restored.push(f.path)
  }
  for (const rel of listFiles(repoDir, captured.roots).files) {
    if (!known.has(rel)) {
      rmSync(path.join(repoDir, rel), { force: true })
      removed.push(rel)
    }
  }
  return { restored, removed, unchanged }
}

/** @returns {{ check: string, resource: string, expected: unknown, actual: unknown, ok: boolean }[]} */
export function verifyFiles(repoDir, captured) {
  const checks = []
  const known = new Set(captured.files.map((f) => f.path))
  for (const f of captured.files) {
    const abs = path.join(repoDir, f.path)
    const actual = existsSync(abs) && lstatSync(abs).isFile() ? fileHash(abs) : null
    checks.push({ check: 'file_sha256', resource: f.path, expected: f.sha256, actual, ok: actual === f.sha256 })
  }
  for (const rel of listFiles(repoDir, captured.roots).files) {
    if (!known.has(rel)) checks.push({ check: 'file_absent', resource: rel, expected: 'absent', actual: 'present', ok: false })
  }
  return checks
}
