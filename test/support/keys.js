/**
 * Test keys: the operator key pair plus an approver key pair, created the way the
 * product creates them (the approver key is sealed with a passphrase and opened
 * again). `approver` and `approverPublicKey` are what authorizeMission and
 * runMission take.
 */

import { approverKeyExists, createApproverKey, loadApproverKey } from '../../src/receipts/approver.js'
import { loadOrCreateKeys } from '../../src/receipts/keys.js'

export const TEST_PASSPHRASE = 'correct horse battery staple'

export function loadOrCreateTestKeys(home) {
  const keys = loadOrCreateKeys(home)
  if (!approverKeyExists(home)) createApproverKey(home, TEST_PASSPHRASE)
  const approver = loadApproverKey(home, TEST_PASSPHRASE)
  return { ...keys, approver, approverPublicKey: approver.publicKey }
}
