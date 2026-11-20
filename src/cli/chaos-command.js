/**
 * `justrunme chaos [--fault-after <n>]`: rehearse the recovery of the current plan on a
 * disposable twin (src/chaos/twin.js). The real database is only read. Exit 0 for
 * RECOVERY PROVEN, 36 for every other verdict, which the result names.
 */
import { ChaosRefused, rehearseRecovery } from '../chaos/twin.js'
import { EXIT } from './codes.js'
import { CliError, contractOf, operatorKeys, preflight, targetOf } from './commands.js'

export async function chaosCmd({ repoDir, opts }) {
  const c = contractOf(repoDir, opts)
  const { target } = targetOf(repoDir)
  const keys = operatorKeys()
  preflight(repoDir, c.contract.id)
  let afterStep = null
  if (opts['fault-after'] !== undefined) {
    if (!/^\d{1,3}$/.test(opts['fault-after'])) throw new CliError(EXIT.USAGE, 'USAGE', '--fault-after must be a number of steps')
    afterStep = Number(opts['fault-after'])
  }
  let r
  try {
    r = await rehearseRecovery({ repoDir, contract: c.contract, contractHash: c.hash, target, keys, afterStep })
  } catch (err) {
    if (err instanceof ChaosRefused) throw new CliError(err.code === 'FAULT_INVALID' ? EXIT.USAGE : EXIT.INTEGRITY, err.code, err.message)
    throw err
  }
  return { exit: r.verdict === 'RECOVERY PROVEN' ? EXIT.OK : EXIT.RECOVERY_NOT_PROVEN, result: { mission_id: c.contract.id, ...r } }
}
