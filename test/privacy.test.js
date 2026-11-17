import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { redact, redactDeep } from '../src/privacy/redact.js'

// Built at runtime so this file itself holds no home path or e-mail literal.
const homePath = (name) => ['', 'Users', name, 'project', 'file.txt'].join('/')
const email = ['someone', 'example.org'].join('@')

describe('privacy redaction (R11.1, R11.2)', () => {
  it('replaces the configured home directory with $HOME', () => {
    const home = ['', 'srv', 'operator'].join('/')
    assert.equal(redact(`${home}/work/a.js`, home), '$HOME/work/a.js')
  })

  it('replaces generic user home prefixes', () => {
    assert.equal(redact(`opened ${homePath('alice')}`, '/nonexistent-home'), 'opened $HOME/project/file.txt')
  })

  it('masks e-mail addresses', () => {
    assert.equal(redact(`sent to ${email}`, '/nonexistent-home'), 'sent to [email]')
  })

  it('masks credential-looking assignments', () => {
    assert.equal(redact('PGPASSWORD=hunter2 run', '/nonexistent-home'), 'PGPASSWORD=[REDACTED] run')
    assert.match(redact('token: abc123', '/nonexistent-home'), /\[REDACTED\]/)
  })

  it('redactDeep walks nested values and keeps non-strings', () => {
    const out = redactDeep({ a: [homePath('bob'), 3], b: { c: email, d: true } }, '/nonexistent-home')
    assert.deepEqual(out, { a: ['$HOME/project/file.txt', 3], b: { c: '[email]', d: true } })
  })

  it('property: output never contains a user home prefix or an e-mail', () => {
    const name = fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/)
    fc.assert(
      fc.property(name, name, (user, domain) => {
        const text = `x ${homePath(user)} y ${user}@${domain}.com z`
        const out = redact(text, '/nonexistent-home')
        return !/\/Users\//.test(out) && !/@[a-z0-9]+\.com/.test(out)
      }),
      { numRuns: 100 }
    )
  })
})
