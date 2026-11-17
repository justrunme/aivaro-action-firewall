/**
 * Names shared by the MCP server and the PreToolUse hook. No imports: the hook
 * loads this file and must not depend on the MCP SDK.
 *
 * Kiro CLI 3.4.0 reports an MCP tool call to the hook as `mcp_<server>_<tool>`
 * (live check, docs/KIRO_LOG.md Run 18). The server name is fixed by the
 * operator's .kiro/settings/mcp.json, which the agent cannot write.
 */

export const SERVER_NAME = 'justrunme'

/**
 * Tools an agent may call. Each one enforces the real gates inside the server
 * (fidelity, selection, signed authorization, receipts); the hook only decides
 * that the agent may reach them. There is deliberately no tool that authorizes,
 * approves, or reads a key.
 */
export const AGENT_TOOLS = Object.freeze([
  'rehearse',
  'get_impact_report',
  'compare',
  'request_approval',
  'run_mission',
  'get_receipt',
  'undo_mission',
  'verify_recovery',
  'replay_mission',
])

/** Exact hook names of the agent tools, lower case as the hook sees them. */
export const AGENT_TOOL_HOOK_NAMES = Object.freeze(new Set(AGENT_TOOLS.map((t) => `mcp_${SERVER_NAME}_${t}`)))
