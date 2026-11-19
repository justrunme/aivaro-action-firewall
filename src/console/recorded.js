/**
 * Recorded Demo: opens an exported, signed run (see scripts/export-recorded-run.mjs)
 * read-only, with no Docker, no PostgreSQL and no workspace.
 *
 * The export is copied into a private temporary workspace and key directory, and the
 * signed head anchor is installed under the name the chain code computes for that copy.
 * The same read commands as in the live Console then verify the chain, the history
 * archive and the requests. Nothing is shown as verified here on the strength of a file
 * name: before that, every file must match the sha256 list of the manifest and no file
 * may be missing or extra. A failed check is reported as a failure, never as a pass.
 *
 * Written fresh for this repository.
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { anchorPath } from '../receipts/chain.js'
import { main } from '../cli/index.js'
import { MISSION_RE, createApi, InputError } from './api.js'

export const RECORDED_LABEL = 'RECORDED RUN · READ ONLY'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

/** One lock for every in-process read: the key directory comes from the environment. */
let queue = Promise.resolve()
export function serialized(fn) {
  const run = queue.then(fn, fn)
  queue = run.then(() => {}, () => {})
  return run
}

/**
 * Checks an export directory against its manifest.
 * @returns {{ ok: boolean, problems: string[], manifest: any | null }}
 */
export function checkExport(dir) {
  const problems = []
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return { ok: false, problems: ['manifest.json is missing or not valid JSON'], manifest: null }
  }
  if (manifest?.schema !== 1 || typeof manifest.files !== 'object' || !Array.isArray(manifest.missions)) problems.push('the manifest has an unknown shape')
  else {
    const listed = new Set(Object.keys(manifest.files))
    for (const [rel, want] of Object.entries(manifest.files)) {
      if (rel.includes('..') || path.isAbsolute(rel)) {
        problems.push(`unsafe path in the manifest: ${rel}`)
        continue
      }
      const file = path.join(dir, rel)
      if (!existsSync(file)) problems.push(`missing file: ${rel}`)
      else if (sha256(readFileSync(file)) !== want) problems.push(`file changed since the export: ${rel}`)
    }
    for (const f of walk(dir)) {
      const rel = path.relative(dir, f).split(path.sep).join('/')
      if (rel !== 'manifest.json' && !listed.has(rel)) problems.push(`file not in the manifest: ${rel}`)
    }
    for (const m of manifest.missions) if (!MISSION_RE.test(m)) problems.push(`invalid mission id in the manifest: ${m}`)
  }
  return { ok: problems.length === 0, problems, manifest }
}

/**
 * @param {string} dir the export directory
 * @returns {{ available: boolean, integrity: { ok: boolean, problems: string[] }, manifest: any, api: object | null, close: () => void }}
 */
export function openRecorded(dir) {
  if (!dir || !existsSync(path.join(dir, 'manifest.json'))) return { available: false, integrity: { ok: false, problems: ['no recorded run found'] }, manifest: null, api: null, close() {} }
  const check = checkExport(dir)
  const base = { available: true, integrity: { ok: check.ok, problems: check.problems }, manifest: check.manifest }
  // A changed export is never opened: nothing from it is shown as verified.
  if (!check.ok) return { ...base, api: null, close() {} }

  const root = mkdtempSync(path.join(os.tmpdir(), 'jrm-recorded-'))
  const repoDir = path.join(root, 'workspace')
  const home = path.join(root, 'keys')
  mkdirSync(repoDir, { recursive: true })
  mkdirSync(path.join(home, 'heads'), { recursive: true })
  cpSync(path.join(dir, '.justrunme'), path.join(repoDir, '.justrunme'), { recursive: true })
  if (existsSync(path.join(dir, 'demo'))) cpSync(path.join(dir, 'demo'), path.join(repoDir, 'demo'), { recursive: true })
  cpSync(path.join(dir, 'operator.pub'), path.join(home, 'operator.pub'))
  for (const m of check.manifest.missions) cpSync(path.join(dir, 'anchors', `${m}.json`), anchorPath(home, m, repoDir))

  const runMain = (argv) => serialized(async () => {
    const before = process.env.JUSTRUNME_HOME
    process.env.JUSTRUNME_HOME = home
    try {
      return await main(argv)
    } finally {
      if (before === undefined) delete process.env.JUSTRUNME_HOME
      else process.env.JUSTRUNME_HOME = before
    }
  })
  const inner = createApi({ repoDir, runMain })
  const refuse = () => {
    throw new InputError('RECORDED_READ_ONLY', 'a recorded run is read only: it cannot be approved, rejected or undone')
  }
  // Only the reads are exposed. The write methods exist to refuse, not to run.
  const api = {
    missions: () => inner.missions(),
    state: (m) => inner.state(m),
    approval: (id, m) => inner.approval(id, m),
    receipt: (seq, m) => inner.receipt(seq, m),
    replay: (m) => inner.replay(m),
    approve: refuse,
    deny: refuse,
    undo: refuse,
  }
  return { ...base, api, close: () => rmSync(root, { recursive: true, force: true }) }
}
