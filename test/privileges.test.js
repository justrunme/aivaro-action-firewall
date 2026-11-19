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
