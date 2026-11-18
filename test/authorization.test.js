import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { stringify } from 'yaml'
import { parseContract } from '../src/contract/parser.js'
import { hashValue } from '../src/util/canonical.js'
import { signValue } from '../src/receipts/keys.js'
import { loadOrCreateTestKeys } from './support/keys.js'
import { sourceState } from '../src/fidelity/source.js'
import { compareFingerprints, baseHash } from '../src/fidelity/gate.js'
import { AuthorizationRefused, issueAuthorization, signatureProblem, entriesForPlan } from '../src/authorize/authorization.js'

const HOOK = new URL('../src/hook/pretooluse.js', import.meta.url).pathname
const CONTRACT = {
  id: 'mission-auth-test',
  objective: 'Signed authorization tests',
  allowed_paths: ['demo/'],
  protected_tables: ['orders'],
  time_limit_seconds: 300,
  irreversible_actions: [],
  plan: [
    { id: 'step-1', tool: 'sql_migration', args: ['demo/migrations/003_add.sql'], reversibility: true },
    { id: 'step-2', tool: 'shell', args: ['node', 'demo/check.js'], reversibility: true },
  ],
  resources: { databases: ['pumpkin_patch'], config_files: [], compose_services: ['db'] },
}

const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, stdio: 'pipe' })

function repo(contract = CONTRACT) {
  const dir = tmp('jrm-auth-')
  mkdirSync(path.join(dir, 'demo/migrations'), { recursive: true })
  writeFileSync(path.join(dir, 'demo/check.js'), "console.log('ok')\n")
  writeFileSync(path.join(dir, '.gitignore'), '.justrunme/\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'base')
  writeFileSync(path.join(dir, 'demo/migrations/003_add.sql'), 'ALTER TABLE orders ADD COLUMN note TEXT;\n')
  writeFileSync(path.join(dir, 'justrunme.mission.yaml'), stringify(contract))
  return dir
}

// A fingerprint as fingerprint.js would build it, with a fixed database part.
function fingerprintOf(dir, parsed, rows = 3) {
  return {
    base: {
      git_head: sourceState(dir).git_head,
      tree_hash: sourceState(dir).tree_hash,
      images: { db: 'sha256:' + 'a'.repeat(64) },
      postgres: { pumpkin_patch: { schema_hash: 'sha256:' + 'b'.repeat(64), tables: { orders: { rows, checksum: 'c'.repeat(32) } } } },
    },
    plan: { source: sourceState(dir), contract_hash: parsed.hash, plan_hash: hashValue(parsed.contract.plan) },
  }
}

function setup({ verdict = 'SAFE' } = {}) {
  const dir = repo()
  const home = tmp('jrm-home-')
  const keys = loadOrCreateTestKeys(home)
  const parsed = parseContract(readFileSync(path.join(dir, 'justrunme.mission.yaml'), 'utf8'))
  const fp = fingerprintOf(dir, parsed)
  const report = { mission_id: parsed.contract.id, plan_id: 'plan-x', contract_hash: parsed.hash, verdict, fingerprint: fp, evidence: [] }
  return { dir, home, keys, parsed, fp, report }
}

const issue = (s, over = {}) =>
  issueAuthorization({ cwd: s.dir, contract: s.parsed.contract, contractHash: s.parsed.hash, report: s.report, currentFingerprint: s.fp, approver: s.keys.approver, now: Date.now(), ...over })

describe('authorization issuance (R2.7, R3.3, R3.6)', () => {
  it('issues a signed authorization for a SAFE rehearsal with an unchanged fingerprint', () => {
    const s = setup()
    const auth = issue(s)
    assert.equal(signatureProblem(auth, s.keys.approver.publicKey), null)
    // The operator key is not the approver key: it does not verify an authorization.
    assert.notEqual(signatureProblem(auth, s.keys.publicKey), null)
    assert.equal(auth.entries.length, 1) // sql_migration runs inside JustRunMe; only the shell step is a hook entry
    assert.deepEqual(auth.entries[0].action, { tool: 'shell', argv: ['node', 'demo/check.js'] })
    assert.match(auth.entries[0].script_hashes['demo/check.js'], /^sha256:/)
    assert.equal(auth.fingerprint_hash, hashValue(s.fp))
  })

  it('refuses DATA LOSS and FAILED verdicts and returns the evidence', () => {
    for (const verdict of ['DATA LOSS', 'FAILED']) {
      const s = setup({ verdict })
      s.report.evidence = [{ kind: 'protected_rows_lost', table: 'orders', rows_before: 3, rows_after: 2 }]
      assert.throws(() => issue(s), (e) => e instanceof AuthorizationRefused && e.code === (verdict === 'DATA LOSS' ? 'DATA_LOSS' : 'NOT_SAFE') && (verdict !== 'DATA LOSS' || e.detail[0].rows_after === 2))
    }
  })

  it('refuses when any fingerprint component changed, naming the component', () => {
    const s = setup()
    const changed = structuredClone(s.fp)
    changed.base.postgres.pumpkin_patch.tables.orders.checksum = 'd'.repeat(32) // same row count, different content
    assert.throws(() => issue(s, { currentFingerprint: changed }), (e) => e.code === 'FIDELITY_MISMATCH' && e.detail.some((d) => d.component.endsWith('orders.checksum')))
  })

  it('refuses when the contract changed after rehearsal', () => {
    const s = setup()
    assert.throws(() => issue(s, { contractHash: 'sha256:' + '9'.repeat(64) }), (e) => e.code === 'CONTRACT_CHANGED')
  })

  it('refuses plan steps that invoke JustRunMe itself or cannot be bound', () => {
    assert.throws(() => entriesForPlan([{ id: 's', tool: 'shell', args: ['node', 'src/cli/index.js', 'authorize'] }], '.'), (e) => e.code === 'SELF_REFERENCE')
    assert.throws(() => entriesForPlan([{ id: 's', tool: 'shell', args: ['sh', '-c', 'id'] }], '.'), (e) => e.code === 'UNBINDABLE_STEP')
    assert.throws(() => entriesForPlan([{ id: 's', tool: 'shell', args: ['node', 'missing.js'] }], os.tmpdir()), (e) => e.code === 'UNBINDABLE_STEP')
  })

  it('property: any change to a signed field breaks the signature', () => {
    const s = setup()
    const auth = issue(s)
    const fields = Object.keys(auth).filter((k) => k !== 'signature')
    fc.assert(
      fc.property(fc.constantFrom(...fields), fc.string({ minLength: 1, maxLength: 8 }), (field, junk) => {
        const forged = { ...auth, [field]: typeof auth[field] === 'string' ? auth[field] + junk : junk }
        return signatureProblem(forged, s.keys.approver.publicKey) !== null
      }),
      { numRuns: 100 }
    )
  })

  it('a signature from another key is rejected even if it is valid for that key', () => {
    const s = setup()
    const other = loadOrCreateTestKeys(tmp('jrm-other-'))
    const { signature, ...body } = issue(s)
    const forged = { ...body, signature: signValue(other.approver.privateKey, body) }
    assert.notEqual(signatureProblem(forged, s.keys.approver.publicKey), null)
    // Signed with the operator key (what the MCP server holds): rejected too.
    const byOperator = { ...body, signature: signValue(s.keys.privateKey, body) }
    assert.notEqual(signatureProblem(byOperator, s.keys.approver.publicKey), null)
  })

  it('refuses to issue without an approver key', () => {
    const s = setup()
    assert.throws(() => issue(s, { approver: undefined }), (e) => e instanceof AuthorizationRefused && e.code === 'NO_APPROVER_KEY')
    assert.throws(() => issue(s, { approver: { publicKey: s.keys.publicKey } }), (e) => e.code === 'NO_APPROVER_KEY')
  })
})

describe('fidelity comparison (R3.2, R3.3, R15.2)', () => {
  it('identical fingerprints pass; property: any single changed leaf is reported', () => {
    const s = setup()
    assert.equal(compareFingerprints(s.fp, structuredClone(s.fp)).ok, true)
    const leaves = ['base.git_head', 'base.tree_hash', 'base.images.db', 'base.postgres.pumpkin_patch.schema_hash',
      'base.postgres.pumpkin_patch.tables.orders.rows', 'base.postgres.pumpkin_patch.tables.orders.checksum',
      'plan.source.uncommitted_hash', 'plan.contract_hash', 'plan.plan_hash']
    fc.assert(
      fc.property(fc.constantFrom(...leaves), (leaf) => {
        const copy = structuredClone(s.fp)
        const keys = leaf.split('.')
        let o = copy
        for (const k of keys.slice(0, -1)) o = o[k]
        o[keys.at(-1)] = typeof o[keys.at(-1)] === 'number' ? o[keys.at(-1)] + 1 : o[keys.at(-1)] + 'x'
        const r = compareFingerprints(s.fp, copy)
        return !r.ok && r.diffs.length === 1 && r.diffs[0].component === leaf
      }),
      { numRuns: 50 }
    )
  })

  it('base hash ignores the plan part, so two plans on the same source are comparable', () => {
    const s = setup()
    const other = structuredClone(s.fp)
    other.plan.plan_hash = 'sha256:' + 'e'.repeat(64)
    assert.equal(baseHash(other), baseHash(s.fp))
  })

  it('source state is stable, changes on any workspace edit, and ignores .justrunme', () => {
    const s = setup()
    const a = hashValue(sourceState(s.dir))
    assert.equal(hashValue(sourceState(s.dir)), a)
    mkdirSync(path.join(s.dir, '.justrunme'), { recursive: true })
    writeFileSync(path.join(s.dir, '.justrunme/audit.jsonl'), '{}\n')
    assert.equal(hashValue(sourceState(s.dir)), a)
    writeFileSync(path.join(s.dir, 'demo/new.txt'), 'x')
    const b = hashValue(sourceState(s.dir))
    assert.notEqual(b, a)
    writeFileSync(path.join(s.dir, 'demo/check.js'), "console.log('changed')\n")
    assert.notEqual(hashValue(sourceState(s.dir)), b)
  })
})

describe('hook process with a signed authorization (R3.6, R3.7, R10.5)', () => {
  function hook(dir, home, command) {
    const env = { ...process.env, JUSTRUNME_GATE: 'on', JUSTRUNME_HOME: home }
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'execute_bash', tool_input: { command, cwd: dir } })
    return spawnSync(process.execPath, [HOOK], { cwd: dir, input, env, encoding: 'utf8' })
  }
  const write = (s, auth) => {
    mkdirSync(path.join(s.dir, '.justrunme'), { recursive: true })
    writeFileSync(path.join(s.dir, '.justrunme/authorization.json'), JSON.stringify(auth))
  }

  it('allows the authorized command, then blocks it after a workspace change', () => {
    const s = setup()
    write(s, issue(s))
    assert.equal(hook(s.dir, s.home, 'node demo/check.js').status, 0)
    assert.equal(hook(s.dir, s.home, 'node demo/other.js').status, 2)
    writeFileSync(path.join(s.dir, 'demo/check.js'), "console.log('DROP TABLE orders')\n")
    const r = hook(s.dir, s.home, 'node demo/check.js')
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stderr.trim()).category, 'FIDELITY_MISMATCH')
  })

  it('blocks when the authorization was signed by a key other than the installed one', () => {
    const s = setup()
    write(s, issue(s))
    const otherHome = tmp('jrm-home2-')
    loadOrCreateTestKeys(otherHome)
    const r = hook(s.dir, otherHome, 'node demo/check.js')
    assert.equal(r.status, 2)
    assert.equal(JSON.parse(r.stderr.trim()).category, 'AUTHORIZATION_INVALID')
  })

  it('blocks a tampered authorization (entry added by hand)', () => {
    const s = setup()
    const auth = issue(s)
    auth.entries.push({ action: { tool: 'shell', argv: ['rm', '-rf', 'demo'] }, script_hashes: {} })
    write(s, auth)
    assert.equal(hook(s.dir, s.home, 'rm -rf demo').status, 2)
  })
})
