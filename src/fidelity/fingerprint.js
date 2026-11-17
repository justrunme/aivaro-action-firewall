/**
 * Fidelity fingerprint of the real target (R3.1). Shape is documented in gate.js.
 */

import { readFileSync } from 'node:fs'
import { hashValue, sha256Hex } from '../util/canonical.js'
import { sourceState } from './source.js'
import { measureDatabase } from '../rehearsal/measure.js'
import { imageDigests, psql } from '../rehearsal/compose.js'

/**
 * @param {object} a
 * @param {string} a.repoDir
 * @param {import('../rehearsal/compose.js').Target} a.target real (not rehearsal) Compose project
 * @param {any} a.contract
 * @param {string} a.contractHash
 */
export async function computeFingerprint({ repoDir, target, contract, contractHash }) {
  const source = sourceState(repoDir)
  const db = await measureDatabase((sql) => psql(target, { sql }))
  return {
    base: {
      // Which environment this is. Without it, a second Compose project with the same
      // data and images would produce the same fingerprint and accept the authorization.
      target: {
        project: target.project,
        db_service: target.dbService,
        db_name: target.dbName,
        compose_file_hash: 'sha256:' + sha256Hex(readFileSync(target.composeFile)),
      },
      git_head: source.git_head,
      tree_hash: source.tree_hash,
      images: await imageDigests(target),
      postgres: { [target.dbName]: { schema_hash: db.schema_hash, tables: db.tables } },
    },
    plan: { source, contract_hash: contractHash, plan_hash: hashValue(contract.plan) },
  }
}
