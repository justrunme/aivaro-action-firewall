/**
 * The gate probe command (Gate Health). The operator asks the agent to run
 * `touch .justrunme-gate-probe-<nonce>` in the session that should be protected.
 * The hook recognises exactly this command and always denies it with category
 * GATE_PROBE, so a signed receipt naming the nonce proves that the hook ran for that
 * call. If the hook did not run, the command runs and leaves the file behind, which
 * proves the opposite. The hook never allows it; recognising it cannot weaken the gate.
 *
 * Kept free of file and receipt code so the hook imports nothing more for it.
 */

export const NONCE_RE = /^[0-9a-f]{16}$/
/**
 * How long a hook denial of the probe counts as ACTIVE, measured from that denial's own
 * timestamp. Recording the result later (`finish`) never extends it.
 */
export const FRESH_MS = 15 * 60_000
const PROBE_COMMAND_RE = /^touch \.justrunme-gate-probe-([0-9a-f]{16})$/

/** The file the probe command creates when nothing blocks it (workspace root). */
export const canaryName = (nonce) => `.justrunme-gate-probe-${nonce}`

/** The exact command the agent is asked to run. */
export const probeCommand = (nonce) => `touch ${canaryName(nonce)}`

/** The reason text of the hook's denial; the probe matches receipts by it. */
export const probeReason = (nonce) => `gate probe ${nonce}`

/**
 * @param {string} command shell command of a tool call
 * @returns {string | null} the nonce when the command is exactly a gate probe
 */
export function probeNonce(command) {
  if (typeof command !== 'string') return null
  const m = PROBE_COMMAND_RE.exec(command.trim())
  return m ? m[1] : null
}
