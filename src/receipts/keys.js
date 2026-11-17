/**
 * Operator Ed25519 key pair (T16.1, used early by run authorization).
 *
 * Approach: node:crypto generates the pair; the private key is stored as PKCS#8
 * PEM with file mode 0600 in the operator key directory, which lies outside the
 * workspace (JUSTRUNME_HOME, default ~/.justrunme). The PreToolUse hook denies
 * every agent tool call that touches this directory, so an agent cannot read the
 * private key or replace the public key with its file tools.
 *
 * Residual risk (documented in the threat model): code that the operator
 * rehearsed and authorized runs as the operator's OS user and could read this
 * directory. JustRunMe is not an OS sandbox.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalJson } from '../util/canonical.js'

const PRIVATE_FILE = 'operator.key'
const PUBLIC_FILE = 'operator.pub'

/** @returns {string} operator key directory */
export function keyHome(env = process.env) {
  return env.JUSTRUNME_HOME && env.JUSTRUNME_HOME.length > 0 ? path.resolve(env.JUSTRUNME_HOME) : path.join(os.homedir(), '.justrunme')
}

/**
 * Load the key pair, creating it on first use.
 * @param {string} home
 * @returns {{ privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject }}
 */
export function loadOrCreateKeys(home) {
  const priv = path.join(home, PRIVATE_FILE)
  const pub = path.join(home, PUBLIC_FILE)
  if (!existsSync(priv)) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const pair = generateKeyPairSync('ed25519')
    writeFileSync(priv, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    writeFileSync(pub, pair.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o644 })
    chmodSync(priv, 0o600)
  }
  const privateKey = createPrivateKey(readFileSync(priv))
  // home travels with the keys: receipt head anchors live next to them.
  return { privateKey, publicKey: createPublicKey(privateKey), home }
}

/**
 * Load an existing key pair without creating one (used by the hook: the gate must
 * not invent an operator identity on its own).
 * @returns {{ privateKey: any, publicKey: any, home: string } | null}
 */
export function loadExistingKeys(home) {
  try {
    const privateKey = createPrivateKey(readFileSync(path.join(home, PRIVATE_FILE)))
    return { privateKey, publicKey: createPublicKey(privateKey), home }
  } catch {
    return null
  }
}

/** @returns {import('node:crypto').KeyObject | null} */
export function loadPublicKey(home) {
  try {
    return createPublicKey(readFileSync(path.join(home, PUBLIC_FILE)))
  } catch {
    return null
  }
}

/** Raw 32-byte public key as lowercase hex. */
export function publicKeyHex(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
}

/** Ed25519 signature (hex) over the canonical JSON of value. */
export function signValue(privateKey, value) {
  return edSign(null, Buffer.from(canonicalJson(value)), privateKey).toString('hex')
}

/** @returns {boolean} */
export function verifyValue(publicKey, value, signatureHex) {
  if (typeof signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(signatureHex)) return false
  try {
    return edVerify(null, Buffer.from(canonicalJson(value)), publicKey, Buffer.from(signatureHex, 'hex'))
  } catch {
    return false
  }
}
