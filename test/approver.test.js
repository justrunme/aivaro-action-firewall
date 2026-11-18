/**
 * T23: the approver key. Sealed with a passphrase, opened only by the human-run
 * CLI; the public half is all that run, the hook and the MCP server ever load.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { APPROVER_KEY_FILE, APPROVER_PUB_FILE, ApproverKeyError, approverKeyExists, createApproverKey, loadApproverKey, loadApproverPublicKey } from '../src/receipts/approver.js'
import { publicKeyHex, signValue, verifyValue } from '../src/receipts/keys.js'

const dirs = []
const home = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'jrm-approver-'))
  dirs.push(d)
  return d
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const PASS = 'a long passphrase for tests'
const code = (fn) => {
  try {
    fn()
  } catch (err) {
    return err instanceof ApproverKeyError ? err.code : `other:${err.message}`
  }
  return null
}

describe('approver key (T23)', () => {
  it('is created sealed, opened with the passphrase, and signs what the public half verifies', () => {
    const h = home()
    const { publicKey } = createApproverKey(h, PASS)
    assert.equal(approverKeyExists(h), true)
    const opened = loadApproverKey(h, PASS)
    assert.equal(publicKeyHex(opened.publicKey), publicKeyHex(publicKey))
    assert.equal(publicKeyHex(loadApproverPublicKey(h)), publicKeyHex(publicKey))
    const sig = signValue(opened.privateKey, { hello: 'world' })
    assert.equal(verifyValue(loadApproverPublicKey(h), { hello: 'world' }, sig), true)
    assert.equal(verifyValue(loadApproverPublicKey(h), { hello: 'worlds' }, sig), false)
  })

  it('keeps no readable private key on disk: owner-only file, no PEM, no key bytes', () => {
    const h = home()
    createApproverKey(h, PASS)
    const file = path.join(h, APPROVER_KEY_FILE)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /PRIVATE KEY|BEGIN/)
    const sealed = JSON.parse(text)
    assert.deepEqual([sealed.version, sealed.kdf, sealed.N, sealed.r, sealed.p], [2, 'scrypt', 2 ** 17, 8, 1])
    assert.ok(!text.includes(PASS))
    // The public half is read-only: replacing it is a deliberate act, not an overwrite.
    assert.equal(statSync(path.join(h, APPROVER_PUB_FILE)).mode & 0o777, 0o444)
  })

  it('PR B review: a replaced approver.pub is reported when the key is opened, not trusted', () => {
    const h = home()
    createApproverKey(h, PASS)
    const other = home()
    createApproverKey(other, PASS)
    rmSync(path.join(h, APPROVER_PUB_FILE), { force: true })
    writeFileSync(path.join(h, APPROVER_PUB_FILE), readFileSync(path.join(other, APPROVER_PUB_FILE)))
    assert.equal(code(() => loadApproverKey(h, PASS)), 'APPROVER_KEY_INVALID')
  })

  it('a wrong passphrase and a damaged file fail the same way, and never yield a key', () => {
    const h = home()
    createApproverKey(h, PASS)
    assert.equal(code(() => loadApproverKey(h, 'not the passphrase')), 'WRONG_PASSPHRASE')
    assert.equal(code(() => loadApproverKey(h, '')), 'WRONG_PASSPHRASE')
    const file = path.join(h, APPROVER_KEY_FILE)
    const sealed = JSON.parse(readFileSync(file, 'utf8'))
    // Flip one byte of the ciphertext, or of the tag: the seal does not open.
    const flip = (s) => (s[0] === 'a' ? 'b' : 'a') + s.slice(1)
    writeFileSync(file, JSON.stringify({ ...sealed, ciphertext: flip(sealed.ciphertext) }))
    assert.equal(code(() => loadApproverKey(h, PASS)), 'WRONG_PASSPHRASE')
    writeFileSync(file, JSON.stringify({ ...sealed, tag: flip(sealed.tag) }))
    assert.equal(code(() => loadApproverKey(h, PASS)), 'WRONG_PASSPHRASE')
    // Another public key in the sealed file no longer matches approver.pub: refused before decrypting.
    const other = home()
    createApproverKey(other, PASS)
    writeFileSync(file, JSON.stringify({ ...sealed, public_key: JSON.parse(readFileSync(path.join(other, APPROVER_KEY_FILE), 'utf8')).public_key }))
    assert.equal(code(() => loadApproverKey(h, PASS)), 'APPROVER_KEY_INVALID')
  })

  it('refuses a weak passphrase, never replaces an existing key, and says so when none is installed', () => {
    const h = home()
    assert.equal(code(() => createApproverKey(h, 'short')), 'WEAK_PASSPHRASE')
    assert.equal(code(() => createApproverKey(h, 'elevenchars')), 'WEAK_PASSPHRASE') // 11 < 12
    assert.equal(code(() => createApproverKey(h, undefined)), 'WEAK_PASSPHRASE')
    assert.equal(approverKeyExists(h), false)
    assert.equal(code(() => loadApproverKey(h, PASS)), 'NO_APPROVER_KEY')
    assert.equal(loadApproverPublicKey(h), null)
    createApproverKey(h, PASS)
    assert.equal(code(() => createApproverKey(h, PASS + ' again')), 'APPROVER_EXISTS')
    assert.equal(publicKeyHex(loadApproverKey(h, PASS).publicKey), publicKeyHex(loadApproverPublicKey(h)), 'the first key is still there')
  })

  it('rejects a file in an unsupported format', () => {
    const h = home()
    createApproverKey(h, PASS)
    const file = path.join(h, APPROVER_KEY_FILE)
    const sealed = JSON.parse(readFileSync(file, 'utf8'))
    // Old format, other KDF, weaker cost, a truncated GCM tag (Node would accept a short tag unless the length is pinned), a short nonce.
    for (const bad of [{ ...sealed, version: 1 }, { ...sealed, kdf: 'pbkdf2' }, { ...sealed, N: 1024 }, { ...sealed, tag: sealed.tag.slice(0, 8) }, { ...sealed, nonce: sealed.nonce.slice(0, 16) }, 'not json at all']) {
      writeFileSync(file, typeof bad === 'string' ? bad : JSON.stringify(bad))
      assert.ok(['APPROVER_KEY_INVALID', 'NO_APPROVER_KEY'].includes(code(() => loadApproverKey(h, PASS))))
    }
  })

  it('property: any passphrase other than the right one fails to open the key', () => {
    const h = home()
    createApproverKey(h, PASS)
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (guess) => guess === PASS || code(() => loadApproverKey(h, guess)) === 'WRONG_PASSPHRASE'),
      { numRuns: 8 }
    )
  })
})
