/**
 * T25 v2 Step 2: parsing the server log between markers and judging what the rehearsal
 * observers recorded (no Docker; the Docker cases are in test/demo-bypass.test.js).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BYPASS_PATTERNS, createRoleSql, judgeObservations, recordsBetween } from '../src/rehearsal/observe.js'
import { backslashInCode, codeOnly, metaCommandAt } from '../src/rehearsal/sqltext.js'
import { buildImpact } from '../src/rehearsal/impact.js'
import { explainReport } from '../src/explain/remediation.js'
import { EXIT, verdictExit } from '../src/cli/codes.js'

const L = (level, text) => `2026-11-18 14:00:00.123 UTC [42] ${level}:  ${text}`
const LOG = [
  L('LOG', "statement: SELECT 'jrm-marker-a'"),
  L('LOG', 'statement: ALTER TABLE patches DISABLE TRIGGER ALL'),
  L('ERROR', 'must be owner of table patches'),
  L('STATEMENT', 'ALTER TABLE patches DISABLE TRIGGER ALL'),
  L('LOG', 'statement: UPDATE patches'),
  '  SET available_count = 0 WHERE id = 1',
  L('LOG', "statement: SELECT 'jrm-marker-b'"),
  L('LOG', 'statement: SET session_replication_role = replica'),
].join('\n')

const STATE = { event_trigger: 'O', watchers: { jrm_watch_0_abc: 'A' }, settings: { log_statement: 'all', track_functions: 'pl', log_min_error_statement: 'error' }, functions: { count_expected: 'x', on_ddl: 'y' } }
const INSTALLED = { watchers: [{ trigger: 'public.patches.patches_release_sold_out', function: 'public.release_sold_out_patch', foid: '16400', watch: 'jrm_watch_0_abc' }], state: STATE }
const base = { installed: INSTALLED, after: STATE, callsBefore: { 16400: 0 }, callsAfter: { 16400: 1 }, expected: { 'public.patches.patches_release_sold_out': 1 }, ddl: [], records: [], planRole: null }
const db = { schema_hash: 's', columns: { orders: ['id integer'] }, tables: { orders: { rows: 3, checksum: 'c' } }, logic: {} }

describe('rehearsal observers (T25 v2 Step 2)', () => {
  it('reads only the records between the two markers and joins continuation lines', () => {
    const r = recordsBetween(LOG, 'jrm-marker-a', 'jrm-marker-b')
    assert.deepEqual(r.map((x) => x.level), ['LOG', 'ERROR', 'STATEMENT', 'LOG'])
    assert.equal(r[3].text, 'statement: UPDATE patches\n  SET available_count = 0 WHERE id = 1')
    assert.ok(!r.some((x) => x.text.includes('session_replication_role')), 'after the end marker is not the plan')
  })

  it('a trigger that fired as often as it should, and no statement or error, is no evidence', () => {
    assert.deepEqual(judgeObservations(base), { evidence: [], unverifiable: [], records: 0 })
  })

  it('the fire counter: the condition held, the protected function did not run', () => {
    const j = judgeObservations({ ...base, callsAfter: { 16400: 0 } })
    assert.deepEqual(j.evidence, [{ kind: 'trigger_not_fired', trigger: 'public.patches.patches_release_sold_out', expected: 1, fired: 0 }])
  })

  it('statements and refused attempts in the log; observers switched off', () => {
    const j = judgeObservations({ ...base, records: recordsBetween(LOG, 'jrm-marker-a', 'jrm-marker-b'), after: { ...STATE, watchers: { jrm_watch_0_abc: 'O' } } })
    assert.deepEqual(j.evidence.map((e) => e.kind).sort(), ['bypass_attempt_refused', 'bypass_statement', 'observers_switched_off'])
    assert.equal(j.unverifiable.length, 1)
  })

  it('a plan role with more rights than A2 makes the rehearsal unverifiable', () => {
    const j = judgeObservations({ ...base, planRole: { restricted: false, problems: ['the plan role has superuser'] } })
    assert.deepEqual(j.unverifiable, ['the plan role has superuser'])
  })

  it('verdict order: LOGIC BYPASS before UNVERIFIABLE, FAILED, DATA LOSS; the agent gets constraints, the CLI an exit code', () => {
    const steps = [{ id: 'm1', status: 'failed' }]
    const bypass = buildImpact({ before: db, after: { ...db, tables: { orders: { rows: 2, checksum: 'd' } } }, protectedTables: ['orders'], steps, bypass: { evidence: [{ kind: 'bypass_attempt_refused', error: 'must be owner of table patches' }], unverifiable: ['x'] } })
    assert.equal(bypass.verdict, 'LOGIC BYPASS')
    assert.equal(buildImpact({ before: db, after: db, protectedTables: [], steps: [], bypass: { evidence: [], unverifiable: ['observers missing'] } }).verdict, 'UNVERIFIABLE')
    assert.equal(buildImpact({ before: db, after: db, protectedTables: [], steps: [], bypass: { evidence: [], unverifiable: [] } }).verdict, 'SAFE')
    const shown = explainReport({ plan_id: 'plan-0123456789ab', ...bypass, steps }, { used: 1 })
    assert.deepEqual([shown.status, shown.reason, shown.next_action], ['DENIED', 'LOGIC_BYPASS', 'REVISE_AND_REHEARSE'])
    assert.ok(shown.remediation.constraints.some((c) => c.kind === 'no_bypass'))
    assert.equal(verdictExit('LOGIC BYPASS'), EXIT.LOGIC_BYPASS)
    assert.equal(verdictExit('UNVERIFIABLE'), EXIT.UNVERIFIABLE)
    const unv = explainReport({ plan_id: 'plan-0123456789ab', ...buildImpact({ before: db, after: db, protectedTables: [], steps: [], bypass: { evidence: [], unverifiable: ['observers missing'] } }), steps: [] }, { used: 1 })
    assert.equal(unv.next_action, 'ASK_OPERATOR')
  })

  it('any backslash in a plan file is refused, wherever it is (review B1, second review)', () => {
    assert.equal(metaCommandAt('SELECT 1;\n\\c pumpkin_patch demo_user\n'), 10)
    assert.equal(metaCommandAt('SELECT 1 \\g'), 9)
    assert.notEqual(metaCommandAt('\\! id'), -1)
    // The two ways a second lexer could be fooled: a carriage return ending a comment, and
    // standard_conforming_strings = off turning \' into an escaped quote.
    assert.notEqual(metaCommandAt('-- x\r\\! id\nSELECT 1;'), -1)
    assert.notEqual(metaCommandAt("SET standard_conforming_strings = off;\nSELECT '\\'' ; \\! id ; ';"), -1)
    // Also inside strings, identifiers, dollar bodies and comments: no lexer state matters.
    for (const s of ["SELECT 'a\\b';", "SELECT E'\\n';", 'SELECT "we\\ird";', 'SELECT $$ \\c x $$;', '-- \\c in a comment\nSELECT 1;', '/* \\! nope */ SELECT 1;']) assert.notEqual(metaCommandAt(s), -1, s)
    assert.equal(metaCommandAt("SELECT cancel_patch_orders(1);\nUPDATE patches SET available_count = 0 WHERE id = 1;\n"), -1)
    assert.equal(codeOnly('-- c\rSELECT 1'), ' \rSELECT 1', 'a line comment ends at \\r, as in psql')
    // Report only: a backslash in code reads as a psql command (a bypass); one in a string is a plain refusal.
    assert.equal(backslashInCode('SELECT 1;\n\\c x'), true)
    assert.equal(backslashInCode("SELECT E'\\n';"), false)
    assert.equal(backslashInCode('-- \\c\nSELECT 1;'), false)
    assert.equal(codeOnly("-- DISABLE TRIGGER\nUPDATE t SET a = 'DROP TRIGGER' /* SET ROLE */;"), " \nUPDATE t SET a = ''  ;")
    assert.match(codeOnly("DO $d$ BEGIN EXECUTE 'x'; -- c\n END $d$"), /EXECUTE '';/)
  })

  it('judged on code only: a refused DO block that hid an ownership change is an attempt; a missing EXECUTE grant is not (review S2, S3)', () => {
    const rec = (level, text) => ({ level, text })
    const attempt = judgeObservations({ ...base, records: [rec('ERROR', 'must be owner of table patches'), rec('STATEMENT', "DO $d$ BEGIN EXECUTE 'ALTER TABLE patches DIS' || 'ABLE TRIGGER ALL'; END $d$")] })
    assert.deepEqual(attempt.evidence.map((e) => e.kind), ['bypass_attempt_refused'])
    const grant = judgeObservations({ ...base, records: [rec('ERROR', 'permission denied for function cancel_patch_orders'), rec('STATEMENT', 'SELECT cancel_patch_orders(1)')] })
    assert.deepEqual(grant.evidence, [])
    const comment = judgeObservations({ ...base, records: [rec('LOG', "statement: -- no DISABLE TRIGGER here\nUPDATE users SET role = 'admin'")] })
    assert.deepEqual(comment.evidence, [])
    // A setting changed through set_config names it in a string: still matched.
    const viaFunction = judgeObservations({ ...base, records: [rec('LOG', "statement: SELECT set_config('session_replication_role', 'replica', true)")] })
    assert.deepEqual(viaFunction.evidence.map((e) => e.kind), ['bypass_statement'])
  })

  it('the text patterns, and the role a copy gets', () => {
    for (const s of ['ALTER TABLE t DISABLE TRIGGER ALL', 'set local session_replication_role = replica', 'ALTER TABLE t DROP CONSTRAINT c', 'SET CONSTRAINTS ALL DEFERRED', 'RESET ROLE', 'CREATE OR REPLACE FUNCTION f()']) assert.ok(BYPASS_PATTERNS.some(([re]) => re.test(s)), s)
    for (const s of ['UPDATE patches SET available_count = 0', "SELECT cancel_patch_orders(1)", 'ALTER TABLE patches ADD COLUMN sold_out BOOLEAN']) assert.ok(!BYPASS_PATTERNS.some(([re]) => re.test(s)), s)
    assert.equal(createRoleSql({ name: 'jrm_plan', attributes: { login: true, superuser: false, createrole: false, createdb: false, replication: false, bypassrls: false, inherit: false } }), 'CREATE ROLE "jrm_plan" LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT;\n')
  })
})

describe('T25 v3: delete-audit triggers in the observer state', () => {
  const AUDIT = { ...STATE, audit: { jrm_watch_del_0: '16500:A', jrm_watch_trunc_0: '16500:A', jrm_watch_upd_0: '16500:A' }, tables: ['16500', '16600'] }
  const audited = { ...base, installed: { ...INSTALLED, state: AUDIT }, after: AUDIT }

  it('unchanged audit: nothing', () => {
    assert.deepEqual(judgeObservations(audited).evidence, [])
  })

  it('an audit trigger switched off while its table exists is observers_switched_off on audit', () => {
    const r = judgeObservations({ ...audited, after: { ...AUDIT, audit: { ...AUDIT.audit, jrm_watch_del_0: '16500:D' } } })
    assert.deepEqual(r.evidence, [{ kind: 'observers_switched_off', what: 'audit' }])
    assert.equal(r.unverifiable.length, 1)
  })

  it('an audit trigger dropped while its table exists is observers_switched_off on audit', () => {
    const { jrm_watch_upd_0: _gone, ...rest } = AUDIT.audit
    assert.deepEqual(judgeObservations({ ...audited, after: { ...AUDIT, audit: rest } }).evidence, [{ kind: 'observers_switched_off', what: 'audit' }])
  })

  it('the audit of a table whose oid is gone (dropped, or replaced by one of the same name) is not a switch-off', () => {
    assert.deepEqual(judgeObservations({ ...audited, after: { ...AUDIT, audit: {}, tables: ['16600', '16700'] } }).evidence, [])
  })

  it('an audit that moved to a table that did not exist before is still a change', () => {
    assert.deepEqual(judgeObservations({ ...audited, after: { ...AUDIT, audit: { jrm_watch_del_0: '16700:A' }, tables: ['16600', '16700'] } }).evidence, [{ kind: 'observers_switched_off', what: 'audit' }])
  })
})
