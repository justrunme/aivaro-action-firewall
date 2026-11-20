/**
 * CLI commands of Safety Evidence: `evidence` (read only) and `gate-probe start|status|finish`.
 *
 *   evidence           Gate Health, ProofDebt and recovery readiness of a mission, from its verified chain
 *   gate-probe start   new probe nonce and the command to give the agent (writes .justrunme/gate-probe.json)
 *   gate-probe status  what the workspace shows for the pending probe (read only)
 *   gate-probe finish  records the outcome as a signed gate_probe receipt, removes the probe state
 * gate-probe status and finish exit 0 for ACTIVE, 34 for INACTIVE, 35 for UNKNOWN.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseContract } from '../contract/parser.js'
import { CONTRACT_FILE } from '../hook/run.js'
import { verifyHistory } from '../history/archive.js'
import { ProbeError, finishProbe, gateHealth, observeProbe, pendingProbe, startProbe } from '../gate/probe.js'
import { proofDebt } from '../evidence/proofdebt.js'
import { EXIT } from './codes.js'
import { CliError, contractOf, missionOf, operatorKeys, publicSide, verifiedChain } from './commands.js'

const GATE_EXIT = { ACTIVE: EXIT.OK, INACTIVE: EXIT.GATE_INACTIVE, UNKNOWN: EXIT.GATE_UNKNOWN }

/** The mission contract if the workspace has a valid one; evidence is read without it otherwise. */
function contractIfAny(repoDir) {
  const file = path.join(repoDir, CONTRACT_FILE)
  if (!existsSync(file)) return null
  const parsed = parseContract(readFileSync(file, 'utf8'))
  return parsed.ok ? parsed.contract : null
}

function chainOrFail(repoDir, missionId) {
  const { home, publicKey } = publicSide()
  const chain = verifiedChain({ repoDir, home, publicKey, missionId })
  if (!chain.ok) throw new CliError(EXIT.INTEGRITY, 'CHAIN_INVALID', 'the receipt chain does not verify; no evidence is read from it', chain.findings)
  return chain
}

export function evidenceCmd({ repoDir, opts }) {
  const missionId = missionOf(repoDir, opts)
  const chain = chainOrFail(repoDir, missionId)
  const contract = contractIfAny(repoDir)
  const history = verifyHistory(repoDir, missionId, chain.receipts)
  const gate = gateHealth({ repoDir, receipts: chain.receipts })
  const debt = proofDebt({ receipts: chain.receipts, contract: contract?.id === missionId ? contract : null, legacyVersions: history.legacy_versions, gate })
  return { exit: EXIT.OK, result: { mission_id: missionId, receipts: chain.count, gate, ...debt } }
}

export function gateProbeCmd({ repoDir, opts, action }) {
  if (!['start', 'status', 'finish'].includes(action)) throw new CliError(EXIT.USAGE, 'USAGE', 'usage: justrunme gate-probe start|status|finish')
  // The hook signs its decisions only into the chain of the active contract, so the probe uses that mission.
  const missionId = contractOf(repoDir).contract.id
  if (opts.mission !== undefined && opts.mission !== missionId) throw new CliError(EXIT.USAGE, 'USAGE', 'a gate probe uses the mission of the active contract; drop --mission')
  if (action === 'start') {
    const p = startProbe({ repoDir })
    return { exit: EXIT.OK, result: { mission_id: missionId, ...p, ask_the_agent: `Run this shell command in the workspace and report exactly what happened: ${p.command}` } }
  }
  const chain = chainOrFail(repoDir, missionId)
  if (action === 'status') {
    const probe = pendingProbe(repoDir)
    if (!probe) throw new CliError(EXIT.USAGE, 'NO_PROBE', 'no gate probe is pending; start one first')
    const o = observeProbe({ repoDir, receipts: chain.receipts, probe })
    return { exit: GATE_EXIT[o.status], result: { mission_id: missionId, ...o } }
  }
  let r
  try {
    r = finishProbe({ repoDir, keys: operatorKeys(), missionId, receipts: chain.receipts })
  } catch (err) {
    if (err instanceof ProbeError) throw new CliError(EXIT.USAGE, err.code, err.message)
    throw err
  }
  return { exit: GATE_EXIT[r.status], result: { mission_id: missionId, ...r } }
}
