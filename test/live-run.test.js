/**
 * scripts/live-run.mjs (the live Kiro check): argument handling, refusing a state file that names
 * resources the script did not make, and no approval anywhere in it. No Docker, no Kiro: the commands
 * that would start them are refused before they run.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/live-run.mjs', import.meta.url))
const tmps = []
const tmp = (p) => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), p)))
  tmps.push(d)
  return d
}
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 })

describe('live-run: arguments', () => {
  it('needs --out, a known scenario and exactly one known command; anything else exits 2 with the usage', () => {
    const out = tmp('jrm-liverun-out-')
    for (const args of [[], ['setup'], ['--out', out], ['--out', out, 'approve'], ['--out', out, 'setup', 'down'], ['--out', out, '--scenario', 'other', 'setup'], ['--out', out, '--unknown', 'x', 'setup']]) {
      const r = run(...args)
      assert.equal(r.status, 2, JSON.stringify(args))
      assert.match(r.stderr, /usage: node scripts\/live-run\.mjs/, JSON.stringify(args))
    }
  })

  it('a command without a state file says so and does nothing', () => {
    const out = tmp('jrm-liverun-out-')
    const r = run('--out', out, 'down')
    assert.equal(r.status, 3)
    assert.match(r.stderr, /no state file/)
  })
})

describe('live-run: it removes only what it made', () => {
  it('a state file that names another directory is refused before down touches anything', () => {
    const out = tmp('jrm-liverun-out-')
    const decoy = tmp('jrm-liverun-decoy-')
    writeFileSync(path.join(decoy, 'keep.txt'), 'x')
    const cases = [
      { ws: decoy, home: `${decoy}-keys`, install: decoy, project: 'jrm-live-abcdef' },
      { ws: '/', home: '/-keys', install: '/', project: 'jrm-live-abcdef' },
      { ws: path.join(os.tmpdir(), 'jrm-live-ws-x', '..', 'elsewhere'), home: 'x', install: 'y', project: 'jrm-live-abcdef' },
      { ws: decoy, home: decoy, install: decoy, project: 'other; rm -rf' },
    ]
    for (const s of cases) {
      writeFileSync(path.join(out, 'live-state.json'), JSON.stringify(s))
      const r = run('--out', out, 'down')
      assert.equal(r.status, 3, JSON.stringify(s))
      assert.match(r.stderr, /^refused: /, r.stderr)
      assert.ok(existsSync(path.join(decoy, 'keep.txt')), 'the decoy directory is still there')
    }
  })

  it('a workspace with this script\'s name but another project in its target file is refused too', () => {
    const out = tmp('jrm-liverun-out-')
    const ws = tmp('jrm-live-ws-')
    const install = tmp('jrm-live-install-')
    mkdirSync(`${ws}-keys`)
    tmps.push(`${ws}-keys`)
    writeFileSync(path.join(ws, 'justrunme.target.json'), JSON.stringify({ project: 'jrm-live-111111' }))
    writeFileSync(path.join(out, 'live-state.json'), JSON.stringify({ ws, home: `${ws}-keys`, install, project: 'jrm-live-222222' }))
    const r = run('--out', out, 'down')
    assert.equal(r.status, 3)
    assert.match(r.stderr, /names another Compose project/)
    assert.ok(existsSync(ws) && existsSync(install))
  })
})

describe('live-run: nothing in it approves', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  it('never runs approve or authorize, and the approver key gets its passphrase on stdin at setup only', () => {
    assert.ok(!/\[\s*'(approve|authorize)'/.test(src), 'no approve or authorize call')
    assert.match(src, /\['approver', 'init', '--passphrase-stdin'\]/)
    assert.ok(!/JUSTRUNME_APPROVER_PASSPHRASE:\s/.test(src), 'the passphrase is never put in an environment')
  })
  it('Kiro and the CLI start from an environment without the passphrase, and Kiro gets JUSTRUNME_GATE=on', () => {
    assert.match(src, /delete e\.JUSTRUNME_APPROVER_PASSPHRASE/)
    assert.match(src, /JUSTRUNME_HOME: s\.home, JUSTRUNME_GATE: 'on'/)
  })
})
