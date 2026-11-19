/**
 * Setup diagnostics for the Console's own workspace. Read only: nothing here creates a key,
 * writes a file, changes Kiro's configuration or starts a process.
 *
 * Three states are kept apart, because each one can hold without the next:
 *   hook installed   a PreToolUse hook file in .kiro/hooks/ runs src/hook/pretooluse.js
 *   gate enabled     JUSTRUNME_GATE=on in the environment Kiro starts with; another process,
 *                    such as this Console, cannot see that environment
 *   mission seen protected  the mission chain verifies and holds signed hook decisions, which
 *                    the hook writes only while the gate is on; that shows it was on when they
 *                    were written, not that it is on now
 * Nothing here is reported as PROTECTED.
 *
 * The answer holds booleans, counts and repo-relative names only: no key, no path of this machine.
 * Written fresh for this repository.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { keyHome } from '../receipts/keys.js'
import { parseContract } from '../contract/parser.js'

const HOOK_SCRIPT = 'src/hook/pretooluse.js'
const CONTRACT = 'justrunme.mission.yaml'
const TARGET = 'justrunme.target.json'
const OPERATOR_AGENT = '.kiro/agents/justrunme-operator.json'

/** Hook files in .kiro/hooks/ that run the JustRunMe gate on PreToolUse. */
function hookFiles(repoDir) {
  const dir = path.join(repoDir, '.kiro', 'hooks')
  if (!existsSync(dir)) return []
  const found = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const doc = JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
      const ours = (doc.hooks ?? []).filter((h) => h?.trigger === 'PreToolUse' && h?.action?.type === 'command' && String(h.action.command ?? '').includes(HOOK_SCRIPT))
      if (ours.length) found.push({ file: `.kiro/hooks/${name}`, command: ours[0].action.command, matcher: ours[0].matcher ?? null })
    } catch {
      // an unreadable hook file is not ours to report on
    }
  }
  return found
}

/**
 * @param {{ repoDir: string, runMain: (argv: string[]) => Promise<{ output: any }>, env?: NodeJS.ProcessEnv }} a
 */
export async function setupStatus({ repoDir, runMain, env = process.env }) {
  const home = keyHome()
  const hooks = hookFiles(repoDir)
  const hookScript = existsSync(path.join(repoDir, HOOK_SCRIPT))
  const keys = {
    operator: existsSync(path.join(home, 'operator.pub')),
    approver: existsSync(path.join(home, 'approver.pub')),
    home_from_env: typeof env.JUSTRUNME_HOME === 'string' && env.JUSTRUNME_HOME !== '',
  }
  let contract = { present: existsSync(path.join(repoDir, CONTRACT)), valid: false, mission_id: null, errors: [] }
  if (contract.present) {
    const parsed = parseContract(readFileSync(path.join(repoDir, CONTRACT), 'utf8'))
    contract = parsed.ok
      ? { present: true, valid: true, mission_id: parsed.contract.id, errors: [] }
      : { present: true, valid: false, mission_id: null, errors: parsed.errors.slice(0, 3).map((e) => `${e.field}: ${e.message}`) }
  }
  const target = existsSync(path.join(repoDir, TARGET))
  const agent = existsSync(path.join(repoDir, OPERATOR_AGENT))

  // Signed hook decisions in the contract's mission chain: written only while the gate is on.
  let evidence = { checked: false, chain_ok: null, hook_decisions: 0, last: null, problem: null }
  if (contract.valid && keys.operator) {
    const { output } = await runMain(['status', '--repo', repoDir, '--mission', contract.mission_id])
    if (output?.ok || output?.result) {
      const r = output.result
      evidence = { checked: true, chain_ok: r.chain_ok === true, hook_decisions: r.receipts?.hook_decision ?? 0, last: r.last_receipt ?? null, problem: r.chain_ok ? null : r.chain_findings?.[0]?.problem ?? 'the chain does not verify' }
    } else evidence = { checked: true, chain_ok: null, hook_decisions: 0, last: null, problem: output?.error ? `${output.error.code}: ${output.error.message}` : 'status could not be read' }
  }

  const hookInstalled = hooks.length > 0 && hookScript
  const seenProtected = evidence.checked && evidence.chain_ok === true && evidence.hook_decisions > 0
  return {
    ok: true,
    node: { version: process.versions.node, ok: Number(process.versions.node.split('.')[0]) >= 24 },
    hook: { installed: hookInstalled, files: hooks, script: hookScript },
    keys,
    // The Console cannot see the environment of the Kiro session; it never claims either way.
    gate: { observable: false, note: 'JUSTRUNME_GATE lives in the environment Kiro was started with; the Console cannot read it.' },
    contract,
    target,
    operator_agent: agent,
    evidence,
    states: {
      hook_installed: hookInstalled ? 'yes' : 'no',
      gate_enabled: 'unknown',
      mission_protected: seenProtected ? 'seen' : 'not_verified',
    },
  }
}
