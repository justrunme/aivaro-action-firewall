// Exports genuine, signed missions from a workspace into a read-only "recorded run"
// directory that the Console can open without Docker, PostgreSQL or a workspace.
//
//   node scripts/export-recorded-run.mjs --repo <workspace> --home <key dir> \
//        --out demo/recorded-run --mission <id> [--mission <id> ...] --provenance <file.json>
//
// Nothing is rewritten: receipts, reports and requests are signed, so they are copied
// byte for byte. The export carries only public material (operator.pub and the signed
// head anchors). It never copies operator.key, approver.key.enc or a passphrase file.
// Before anything is written, every file is scanned; a hit stops the export.
//
// Written fresh for this repository.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { anchorPath } from '../src/receipts/chain.js'

const MISSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/
// Per mission, only what the read commands need. captures/ and plans/ stay out: they are
// not read by history, verify, approvals, status, receipt or replay.
const PARTS = ['receipts.jsonl', 'history', 'approvals', 'rehearsals']
// A field name that is not a secret: the channel the passphrase arrived on.
const BENIGN = /"passphrase_source"/g

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

/** The reasons a text must not be published. Pure, so a test can feed it examples. */
export function leaks(text, extra = []) {
  const found = []
  const t = text.replace(BENIGN, '')
  const rules = [
    ['home directory', /\/(Users|home)\/[A-Za-z0-9._-]+/],
    ['temp directory', /\/(var\/folders|private\/var|tmp)\/[A-Za-z0-9._-]+/],
    ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
    ['connection string', /postgres(ql)?:\/\/\S+/i],
    ['credential word', /passphrase|password|secret|api[_-]?key|BEGIN [A-Z ]*PRIVATE KEY/i],
  ]
  for (const [name, re] of rules) if (re.test(t)) found.push(name)
  for (const s of extra) if (s && s.length > 3 && t.includes(s)) found.push('a local path or user name of this machine')
  return found
}

export function exportRun({ repo, home, out, missions, provenance }) {
  if (missions.length === 0) throw new Error('name at least one --mission')
  for (const m of missions) if (!MISSION_RE.test(m)) throw new Error(`invalid mission id ${m}`)
  const extra = [path.resolve(repo), home && path.resolve(home), os.homedir(), os.userInfo().username]
  const plan = [] // [from, to]
  for (const m of missions) {
    const base = path.join(repo, '.justrunme', 'missions', m)
    if (!existsSync(path.join(base, 'receipts.jsonl'))) throw new Error(`${m} has no receipts`)
    for (const part of PARTS) {
      const p = path.join(base, part)
      if (!existsSync(p)) continue
      for (const f of statSync(p).isDirectory() ? walk(p) : [p]) plan.push([f, path.join('.justrunme', 'missions', m, path.relative(base, f))])
    }
    const anchor = anchorPath(home, m, repo)
    if (!existsSync(anchor)) throw new Error(`${m} has no head anchor`)
    plan.push([anchor, path.join('anchors', `${m}.json`)])
  }
  plan.push([path.join(home, 'operator.pub'), 'operator.pub'])
  // The migration files the requests name: the Console shows the SQL that would have run.
  for (const m of missions) {
    const dir = path.join(repo, '.justrunme', 'missions', m, 'approvals')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      for (const file of JSON.parse(readFileSync(path.join(dir, f), 'utf8')).files ?? []) {
        if (!/^[A-Za-z0-9_./-]+$/.test(file.path) || file.path.includes('..')) throw new Error('a request names an unsafe file path')
        plan.push([path.join(repo, file.path), file.path])
      }
    }
  }
  const problems = []
  for (const [from] of plan) {
    const hit = leaks(readFileSync(from, 'utf8'), extra)
    if (hit.length) problems.push(`${path.basename(from)}: ${hit.join(', ')}`)
  }
  if (problems.length) throw new Error(`export stopped, a file would publish:\n  ${problems.join('\n  ')}`)

  rmSync(out, { recursive: true, force: true })
  const files = {}
  for (const [from, to] of plan) {
    const dest = path.join(out, to)
    mkdirSync(path.dirname(dest), { recursive: true })
    cpSync(from, dest)
    files[to.split(path.sep).join('/')] = sha256(readFileSync(dest))
  }
  const manifest = { schema: 1, label: 'RECORDED RUN · READ ONLY', exported_at: new Date().toISOString(), missions, provenance, files: Object.fromEntries(Object.entries(files).sort()) }
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { files: Object.keys(files).length, missions }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { values: v } = parseArgs({ options: { repo: { type: 'string' }, home: { type: 'string' }, out: { type: 'string' }, mission: { type: 'string', multiple: true }, provenance: { type: 'string' } } })
  if (!v.repo || !v.home || !v.out || !v.provenance) throw new Error('--repo, --home, --out and --provenance are required')
  const r = exportRun({ repo: v.repo, home: v.home, out: path.resolve(v.out), missions: v.mission ?? [], provenance: JSON.parse(readFileSync(v.provenance, 'utf8')) })
  process.stdout.write(`exported ${r.files} files for ${r.missions.join(', ')}\n`)
}
