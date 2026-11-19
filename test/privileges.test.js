/**
 * Database privileges in captures and recovery verification (no Docker): the SQL that
 * restores database-level grants, the diff the verification reports, and the parser.
 * The real restore is tested against Postgres in test/demo-undo-grants.test.js.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { databaseGrantSql, diffPrivileges, measurePrivileges, PRIVILEGES_SQL } from '../src/capture/privileges.js'

describe('database-level grants for a restored database', () => {
  it('revokes from PUBLIC, the loader and every captured grantee, then grants exactly the captured rights', () => {
    const sql = databaseGrantSql('"pumpkin_patch_jrm_restore"', {
      owner: 'demo_user',
      grants: [
        { grantee: 'demo_user', privilege: 'CONNECT', grantable: true },
        { grantee: 'jrm_reader', privilege: 'CONNECT', grantable: false },
        { grantee: 'PUBLIC', privilege: 'TEMPORARY', grantable: false },
      ],
    }, 'demo_user')
    assert.equal(sql, [
      'REVOKE ALL ON DATABASE "pumpkin_patch_jrm_restore" FROM PUBLIC;',
      'REVOKE ALL ON DATABASE "pumpkin_patch_jrm_restore" FROM "demo_user";',
      'REVOKE ALL ON DATABASE "pumpkin_patch_jrm_restore" FROM "jrm_reader";',
      'GRANT CONNECT ON DATABASE "pumpkin_patch_jrm_restore" TO "demo_user" WITH GRANT OPTION;',
      'GRANT CONNECT ON DATABASE "pumpkin_patch_jrm_restore" TO "jrm_reader";',
      'GRANT TEMPORARY ON DATABASE "pumpkin_patch_jrm_restore" TO PUBLIC;',
      '',
    ].join('\n'))
  })

  it('refuses a privilege that is not a database privilege, and quotes role names', () => {
    assert.throws(() => databaseGrantSql('"d"', { grants: [{ grantee: 'x', privilege: 'SELECT; DROP DATABASE d', grantable: false }] }, 'u'), /unexpected database privilege/)
    const sql = databaseGrantSql('"d"', { grants: [{ grantee: 'we"ird', privilege: 'CONNECT', grantable: false }] }, 'u')
    assert.match(sql, /TO "we""ird";/)
  })
})

describe('privilege measurement', () => {
  it('parses the query result, hashes the sorted lines, and fails loudly on a query error', async () => {
    const lines = ['database owner demo_user', 'table public.orders grant jrm_reader SELECT']
    const out = await measurePrivileges(async (sql) => {
      assert.equal(sql, PRIVILEGES_SQL)
      return { code: 0, stdout: JSON.stringify({ lines, database: { owner: 'demo_user', grants: [] } }) + '\n', stderr: '' }
    })
    assert.deepEqual(out.lines, lines)
    assert.match(out.hash, /^sha256:[0-9a-f]{64}$/)
    await assert.rejects(measurePrivileges(async () => ({ code: 1, stdout: '', stderr: 'ERROR: permission denied' })), /privileges query failed: ERROR: permission denied/)
  })

  it('the query covers database, schemas, relations, columns, functions and default privileges; it leaves out the grantor', () => {
    for (const part of ["'database grant '", "'schema '", "'column '", "'function '", "'default '", "acldefault('d'", "acldefault('n'", "acldefault('f'", "'s' ELSE 'r' END)::\"char\""]) assert.ok(PRIVILEGES_SQL.includes(part), part)
    assert.ok(!/grantor/.test(PRIVILEGES_SQL))
  })

  it('the diff names what is missing and what is new; equal sets have no diff (property)', () => {
    assert.deepEqual(diffPrivileges({ lines: ['a', 'b'] }, { lines: ['b', 'c'] }), { missing: ['a'], extra: ['c'] })
    fc.assert(fc.property(fc.uniqueArray(fc.string(), { maxLength: 20 }), fc.uniqueArray(fc.string(), { maxLength: 20 }), (a, b) => {
      const d = diffPrivileges({ lines: a }, { lines: b })
      const same = d.missing.length === 0 && d.extra.length === 0
      return same === (new Set(a).size === new Set(b).size && a.every((x) => b.includes(x)))
    }))
  })
})

describe('a required check that could not be made is never a recovery', () => {
  it('verification: FAIL beats everything, UNVERIFIABLE when a check could not be made, PASS only when all were made and passed', async () => {
    const { verificationStatus } = await import('../src/undo/verify.js')
    const ok = { check: 'row_count', ok: true }
    const bad = { check: 'privileges', ok: false }
    const notDone = [{ check: 'privileges', resource: 'db', why: 'old capture' }]
    assert.equal(verificationStatus([ok], []), 'PASS')
    assert.equal(verificationStatus([ok], notDone), 'UNVERIFIABLE')
    assert.equal(verificationStatus([ok, bad], notDone), 'FAIL')
    assert.equal(verificationStatus([ok, bad], []), 'FAIL')
  })

  it('undo: RECOVERED only with PASS; UNVERIFIABLE gives RESTORED_UNVERIFIED; any failed restore is NOT_RECOVERED (property)', async () => {
    const { recoveryStatus } = await import('../src/undo/undo.js')
    fc.assert(fc.property(fc.constantFrom('PASS', 'FAIL', 'UNVERIFIABLE'), fc.array(fc.constantFrom('succeeded', 'failed'), { minLength: 1, maxLength: 5 }), (v, rs) => {
      const s = recoveryStatus(v, rs.map((status) => ({ status })))
      const restored = rs.every((x) => x === 'succeeded')
      if (s === 'RECOVERED') return restored && v === 'PASS'
      if (s === 'RESTORED_UNVERIFIED') return restored && v === 'UNVERIFIABLE'
      return s === 'NOT_RECOVERED' && (!restored || v === 'FAIL')
    }))
  })

  it('the CLI has a distinct exit code for it, and every exit code is distinct', async () => {
    const { EXIT } = await import('../src/cli/codes.js')
    assert.equal(EXIT.RECOVERY_UNVERIFIED, 33)
    const values = Object.values(EXIT)
    assert.equal(new Set(values).size, values.length)
    const src = (await import('node:fs')).readFileSync(new URL('../src/cli/commands.js', import.meta.url), 'utf8')
    assert.match(src, /r\.status === 'RESTORED_UNVERIFIED'\) return \{ exit: EXIT\.RECOVERY_UNVERIFIED/)
  })

  it('the Console shows RESTORED · NOT VERIFIED in grey, never RECOVERED · VERIFIED', async () => {
    const { runOutcome, missionVerdict, flight } = await import('../src/console/static/model.js')
    const story = {
      chain_ok: true, history: { ok: true },
      versions: [{ seq: 0, verdict: 'SAFE', available: true, plan_id: 'plan-000000000001', report_hash: 'h', files: [] }],
      requests: [], links: [], timeline: [],
      runs: [{ seq: 1, verdict: 'completed', matches_rehearsal: true, report_hash: 'h', authorization: 'a', undo: { seq: 2, verdict: 'undo', verification: 'UNVERIFIABLE' } }],
    }
    const out = runOutcome(story)
    assert.equal(out.label, 'RESTORED · NOT VERIFIED')
    assert.equal(out.tone, 'mute')
    assert.notEqual(missionVerdict(story, true).label, 'RECOVERED · VERIFIED')
    assert.equal(flight(story).find((n) => n.name === 'VERIFIED').state, 'mute')
  })

  it('the privileges check says what it covers, and claims nothing about the rest', async () => {
    const { PRIVILEGES_SCOPE } = await import('../src/undo/verify.js')
    assert.match(PRIVILEGES_SCOPE, /^supported database grants and ownership/)
    for (const not of ['RLS policies', 'role attributes', 'database settings', 'large objects']) assert.ok(PRIVILEGES_SCOPE.includes(not), not)
  })
})
