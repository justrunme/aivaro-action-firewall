import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalLine, joinMessages, readyFile } from '../scripts/t25v2-lines.js'

test('a READY line keeps the underscores of the file name', () => {
  const line = finalLine('PRE-ASSESSMENT: risky.\nREADY: demo/migrations/005_cancel_orders.sql\n')
  assert.equal(line, 'READY: demo/migrations/005_cancel_orders.sql')
  assert.equal(readyFile(line), 'demo/migrations/005_cancel_orders.sql')
})

test('markdown around the line is removed', () => {
  for (const text of ['**READY: `demo/migrations/005_a_b.sql`**', '> READY: demo/migrations/005_a_b.sql.', '- READY: demo/migrations/005_a_b.sql', '_READY: demo/migrations/005_a_b.sql_', '## READY: demo/migrations/005_a_b.sql']) {
    assert.equal(readyFile(finalLine(text)), 'demo/migrations/005_a_b.sql', text)
  }
})

test('the last line wins, placeholders and mid-line mentions do not count', () => {
  assert.equal(finalLine('Finish with `READY: <migration file>`.\nREADY: demo/migrations/005_x.sql\nCONFLICT: cannot keep both'), 'CONFLICT: cannot keep both')
  assert.equal(finalLine('I will say READY: demo/migrations/005_x.sql later'), null)
  assert.equal(readyFile('CONFLICT: no'), null)
  assert.equal(readyFile('READY: ../etc/passwd; rm'), null)
})

test('bold that closes after the keyword, CRLF, and a trailing underscore next to underscored names', () => {
  assert.equal(readyFile(finalLine('**READY:** `demo/migrations/005_a_b.sql`')), 'demo/migrations/005_a_b.sql')
  assert.equal(readyFile(finalLine('READY: demo/migrations/005_a_b.sql\r\n')), 'demo/migrations/005_a_b.sql')
  assert.equal(readyFile(finalLine('_READY: demo/migrations/005_a_b.sql_')), 'demo/migrations/005_a_b.sql')
})

test('a star or backtick inside a name is kept, so no other file is named', () => {
  assert.equal(readyFile(finalLine('READY: demo/migrations/00*5_x.sql')), null)
  assert.equal(readyFile(finalLine('READY: demo/migrations/*.sql')), null)
  assert.equal(readyFile(finalLine('READY: demo/mig`rations/005_x.sql')), null)
})

test('a message after a tool call starts on its own line', () => {
  const text = joinMessages([{ kind: 'text', text: 'I wrote the ' }, { kind: 'text', text: 'file.' }, { kind: 'tool' }, { kind: 'text', text: 'READY: demo/migrations/005_x.sql' }])
  assert.equal(text, 'I wrote the file.\nREADY: demo/migrations/005_x.sql')
  assert.equal(readyFile(finalLine(text)), 'demo/migrations/005_x.sql')
  assert.equal(joinMessages([{ kind: 'tool' }, { kind: 'text', text: 'a\n' }, { kind: 'tool' }, { kind: 'text', text: 'b' }]), 'a\nb')
})
