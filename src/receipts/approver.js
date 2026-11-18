/**
 * The approver key (T23): the key that signs run authorizations, apart from the
 * operator key that signs reports, receipts and comparisons.
 *
 * Why a second key. The MCP server and the Console run as the operator's OS user
 * and hold the operator key to record their work. If that key also signed
 * authorizations, any bug or compromise in those processes could approve a run.
 * The approver private key is stored encrypted and only the human-run CLI
 * (`justrunme approve`, `authorize`) ever decrypts it, with a passphrase typed at
 * a terminal. The MCP server loads only the public key, to verify.
 *
 * Approach (node:crypto only): the passphrase goes through scrypt (N=2^15, r=8,
 * p=1, random 16-byte salt) to a 256-bit key; the PKCS#8 private key is sealed
 * with AES-256-GCM under a random 96-bit nonce. The public key is stored in the
 * clear and bound into the GCM additional data, so a swapped public key breaks
 * the seal. Residual risk, stated in README: code that runs as the same OS user
 * can still read the encrypted file and try passphrases offline; a strong
 * passphrase is the defence, and passkey approval (R6.8) is the planned upgrade.
 */

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const APPROVER_KEY_FILE = 'approver.key.enc'
export const APPROVER_PUB_FILE = 'approver.pub'
export const MIN_PASSPHRASE = 8
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

export class ApproverKeyError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const hex = (publicKey) => publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
const aad = (publicHex) => Buffer.from(`justrunme-approver-v1:${publicHex}`)
const derive = (passphrase, salt) => scryptSync(String(passphrase), salt, 32, SCRYPT)

export const approverKeyExists = (home) => existsSync(path.join(home, APPROVER_KEY_FILE))

/**
 * Create the approver key pair. Refuses to replace an existing one: replacing the
 * approver is a deliberate act (delete the files), not something a command does.
 * @returns {{ publicKey: import('node:crypto').KeyObject }}
 */
export function createApproverKey(home, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new ApproverKeyError('WEAK_PASSPHRASE', `the passphrase needs at least ${MIN_PASSPHRASE} characters`)
  if (approverKeyExists(home)) throw new ApproverKeyError('APPROVER_EXISTS', 'an approver key already exists; remove approver.key.enc and approver.pub to replace it')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const pair = generateKeyPairSync('ed25519')
  const publicHex = hex(pair.publicKey)
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derive(passphrase, salt), nonce)
  cipher.setAAD(aad(publicHex))
  const ciphertext = Buffer.concat([cipher.update(pair.privateKey.export({ format: 'der', type: 'pkcs8' })), cipher.final()])
  const sealed = { version: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('hex'), nonce: nonce.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex'), public_key: publicHex }
  const file = path.join(home, APPROVER_KEY_FILE)
  writeFileSync(file, JSON.stringify(sealed) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  writeFileSync(path.join(home, APPROVER_PUB_FILE), pair.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o644 })
  return { publicKey: pair.publicKey }
}

/** The public half only: what the MCP server, the hook and `run` need to verify an authorization. */
export function loadApproverPublicKey(home) {
  try {
    return createPublicKey(readFileSync(path.join(home, APPROVER_PUB_FILE)))
  } catch {
    return null
  }
}

/**
 * Decrypt the approver key. Only the human-run CLI calls this.
 * @returns {{ privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject }}
 */
export function loadApproverKey(home, passphrase) {
  let sealed
  try {
    sealed = JSON.parse(readFileSync(path.join(home, APPROVER_KEY_FILE), 'utf8'))
  } catch {
    throw new ApproverKeyError('NO_APPROVER_KEY', 'no approver key is installed; run `justrunme approver init`')
  }
  if (sealed?.version !== 1 || sealed.kdf !== 'scrypt' || sealed.N !== SCRYPT.N || sealed.r !== SCRYPT.r || sealed.p !== SCRYPT.p) throw new ApproverKeyError('APPROVER_KEY_INVALID', 'the approver key file is not in a supported format')
  try {
    const decipher = createDecipheriv('aes-256-gcm', derive(passphrase, Buffer.from(sealed.salt, 'hex')), Buffer.from(sealed.nonce, 'hex'))
    decipher.setAAD(aad(sealed.public_key))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'))
    const der = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'hex')), decipher.final()])
    const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    const publicKey = createPublicKey(privateKey)
    if (hex(publicKey) !== sealed.public_key) throw new Error('public key mismatch')
    return { privateKey, publicKey }
  } catch {
    // A wrong passphrase and a damaged file fail the same way: the seal does not open.
    throw new ApproverKeyError('WRONG_PASSPHRASE', 'the passphrase does not open the approver key (or the file was changed)')
  }
}
