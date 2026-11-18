import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalLine, readyFile } from '../scripts/t25v2-lines.js'

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
