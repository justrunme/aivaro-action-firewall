import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { accessViolations } from '../scripts/t25-paths.js'

const WS = '/private/var/folders/ab/cdefgh/T/jrm-agent-ws-AbC123'
const call = (...paths) => [{ title: 'Read File', paths }]

describe('access check, macOS /private prefix (T25 v3 change 3)', () => {
  it('relative paths inside the workspace are not violations when the real path starts with /private', () => {
    assert.deepEqual(accessViolations(call('demo/migrations/004_mark_hollow_creek_sold_out.sql', 'demo/migrations', '.justrunme/x.json'), WS), [])
  })

  it('absolute paths are the same with and without the prefix', () => {
    assert.deepEqual(accessViolations(call(`${WS}/demo/migrations/001_init.sql`, WS.replace('/private', '') + '/demo/migrations'), WS), [])
    assert.deepEqual(accessViolations(call(`${WS}/demo/x.sql`), WS.replace('/private', '')), [])
  })

  it('a path that leaves the workspace is one violation', () => {
    assert.deepEqual(accessViolations(call('../outside'), WS), [{ tool: 'Read File', path: '../outside' }])
    assert.deepEqual(accessViolations(call('demo/../../outside.sql'), WS).length, 1)
    assert.deepEqual(accessViolations(call('/etc/passwd'), WS).length, 1)
  })

  it('a sibling that merely shares the prefix of the workspace name is outside', () => {
    assert.deepEqual(accessViolations(call(`${WS}-keys/key`, `${WS}X/demo`), WS).length, 2)
  })

  it('the workspace root itself is inside; no paths, no violations', () => {
    assert.deepEqual(accessViolations(call('.', WS), WS), [])
    assert.deepEqual(accessViolations([{ title: 'Tool Load', paths: [] }], WS), [])
  })

  it('one violation among many paths is reported once, with its tool', () => {
    const tools = [{ title: 'Read File', paths: ['demo/a.sql'] }, { title: 'List Directory', paths: ['../outside'] }, { title: 'Write File', paths: ['demo/b.sql'] }]
    assert.deepEqual(accessViolations(tools, WS), [{ tool: 'List Directory', path: '../outside' }])
  })
})
