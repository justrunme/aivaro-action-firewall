/**
 * Default-deny evaluation of one PreToolUse event (R1.4, R1.5, R1.6, R10.1 to R10.7).
 *
 * Pure with respect to the decision: it reads only the files it must hash or
 * resolve (scripts, paths) and takes the contract, authorization and clock from
 * the caller. Order of checks: contract present, tool class, authorization
 * validity, then the class-specific rule. Anything not positively allowed is denied.
 */

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_TOOL_HOOK_NAMES } from '../mcp/names.js'
import { analyzeShell } from './bypass.js'
import { authorizationProblem, checkWindow, matchEntry } from './allowlist.js'

// Root of the JustRunMe installation that is running this hook. If it lies inside
// the workspace, its code and dependencies are protected like the gate itself:
// the hook imports src/contract, src/util and node_modules/yaml.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGE_PROTECTED = ['src', 'node_modules', 'package.json', 'package-lock.json']

const SHELL_TOOLS = new Set(['execute_bash', 'executebash', 'shell', 'bash', 'run_command', 'control_bash_process'])
const WRITE_TOOLS = new Set(['fs_write', 'fs_append', 'str_replace', 'delete_file', 'smart_relocate', 'semantic_rename', 'write', 'edit', 'create', 'delete'])
const READ_TOOLS = new Set(['read_file', 'read_code', 'list_directory', 'grep_search', 'file_search', 'get_process_output', 'read', 'grep', 'glob', 'ls'])
const WEB_TOOLS = new Set(['web_fetch', 'remote_web_search', 'web_search', 'fetch'])
// tool_load: Kiro CLI 3.4.0 announces which tools it is about to load (tool_ids such as
// builtin::remote_web_search or justrunme::rehearse). Loading runs nothing; the call of
// the loaded tool is checked on its own.
const NOOP_TOOLS = new Set(['todo_list', 'update_session_information', 'disclose_context', 'list_processes', 'tool_load'])
const PATH_KEYS = ['path', 'filePath', 'file_path', 'targetFile', 'target_file', 'sourcePath', 'destinationPath', 'source', 'destination']
// Files the agent must never write while the gate is on (the gate, its inputs, and git metadata).
const PROTECTED_PATHS = ['.justrunme', '.kiro/hooks', '.kiro/settings', '.git', 'justrunme.mission.yaml', 'justrunme.target.json', 'src/hook']

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep)

/** realpath of the deepest existing ancestor plus the not-yet-existing tail (defeats symlink escapes). */
function realResolve(abs) {
  let head = abs
  const tail = []
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail.reverse())
    } catch {
      const parent = path.dirname(head)
      if (parent === head) return abs
      tail.push(path.basename(head))
      head = parent
    }
  }
}

function classify(name) {
  if (name.startsWith('mcp_')) return 'mcp'
  if (SHELL_TOOLS.has(name)) return 'shell'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (WEB_TOOLS.has(name)) return 'web'
  if (READ_TOOLS.has(name)) return 'read'
  if (NOOP_TOOLS.has(name)) return 'noop'
  return 'unknown'
}

function collectPaths(input) {
  const found = []
  for (const key of PATH_KEYS) if (typeof input[key] === 'string') found.push(input[key])
  for (const key of ['paths', 'migrations']) if (Array.isArray(input[key])) for (const p of input[key]) if (typeof p === 'string') found.push(p)
  return found
}

/** Best-effort text scan; the authoritative check is the measured rehearsal (T14). */
function touchesProtectedTable(text, tables) {
  return tables.some((table) => {
    const t = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(drop\\s+table(?:\\s+if\\s+exists)?|truncate(?:\\s+table)?|delete\\s+from|alter\\s+table)\\s+(?:only\\s+)?(?:"?public"?\\.)?"?${t}"?\\b`, 'i')
    return re.test(text)
  })
}

function protectedRoots(root) {
  const roots = PROTECTED_PATHS.map((p) => ({ label: p, abs: path.join(root, p) }))
  const pkg = realResolve(PACKAGE_ROOT)
  if (inside(pkg, root)) {
    for (const p of PACKAGE_PROTECTED) roots.push({ label: path.relative(root, path.join(pkg, p)) || p, abs: path.join(pkg, p) })
  }
  return roots
}

// Fields that name a directory a read tool searches or lists (besides PATH_KEYS), and glob fields.
const DIR_KEYS = ['directory', 'dir', 'cwd', 'root', 'folder']
const GLOB_KEYS = ['pattern', 'glob', 'includePattern', 'excludePattern', 'include', 'exclude']

/**
 * The operator key directory is never readable or writable through agent tools: not a
 * path inside it, and not a directory that contains it (a recursive search of `..` or
 * of the temp directory would otherwise list or grep the key files).
 */
function touchesKeyHome(input, ctx) {
  if (!ctx.keyHome) return false
  const home = realResolve(path.resolve(ctx.keyHome)).toLowerCase()
  const spelled = path.resolve(ctx.keyHome).toLowerCase()
  const root = realpathSync(ctx.cwd)
  const command = typeof input.command === 'string' ? input.command.toLowerCase() : ''
  const paths = [...collectPaths(input), ...DIR_KEYS.filter((k) => typeof input[k] === 'string').map((k) => input[k])]
  return paths.some((p) => {
    const abs = realResolve(path.resolve(root, p)).toLowerCase()
    // `abs` is the key directory, inside it, or contains it (also the file system root).
    const down = path.relative(abs, home)
    return inside(abs, home) || down === '' || (!down.startsWith('..') && !path.isAbsolute(down))
  }) ||
    (command !== '' && (command.includes(home) || command.includes(spelled) || command.includes('.justrunme/operator') || command.includes('operator.key')))
}

/**
 * Read tools stay inside the workspace (T24 review): every path or directory they name
 * resolves under the workspace root, and glob fields are relative without `..`.
 * @returns {string | null} problem
 */
function readOutsideWorkspace(input, ctx) {
  const root = realpathSync(ctx.cwd)
  const paths = [...collectPaths(input), ...DIR_KEYS.filter((k) => typeof input[k] === 'string').map((k) => input[k])]
  for (const p of paths) if (!inside(realResolve(path.resolve(root, p)), root)) return 'read outside the workspace'
  for (const k of GLOB_KEYS) {
    const g = input[k]
    if (typeof g !== 'string') continue
    if (path.isAbsolute(g) || g.startsWith('~') || g.split(/[\\/]/).includes('..')) return `pattern ${k} reaches outside the workspace`
  }
  return null
}

function checkWrite(input, ctx) {
  const paths = collectPaths(input)
  if (paths.length === 0) return { decision: 'deny', category: 'OUT_OF_CONTRACT', reason: 'write target path cannot be determined' }
  const root = realpathSync(ctx.cwd)
  const allowed = ctx.contract.allowed_paths.map((p) => realResolve(path.resolve(root, p)))
  for (const p of paths) {
    const target = realResolve(path.resolve(root, p))
    if (!inside(target, root)) return { decision: 'deny', category: 'OUT_OF_CONTRACT', reason: 'write target is outside the workspace' }
    for (const prot of protectedRoots(root)) {
      // Case-insensitive so that macOS and Windows file systems cannot be used to dodge the check.
      if (inside(target.toLowerCase(), prot.abs.toLowerCase())) {
        return { decision: 'deny', category: 'PROTECTED_PATH', reason: `write to protected path ${prot.label}` }
      }
    }
    if (!allowed.some((a) => inside(target, a))) {
      return { decision: 'deny', category: 'OUT_OF_CONTRACT', reason: 'write target is not under allowed_paths' }
    }
  }
  return { decision: 'allow', category: 'ALLOWED', reason: 'write inside allowed_paths' }
}

/**
 * @param {any} event parsed PreToolUse event: { tool_name, tool_input, cwd? }
 * @param {{ cwd: string, contract: any, contractHash: string, contractError?: string,
 *           authorization: any, authorizationError?: string, now: number }} ctx
 * @returns {{ decision: 'allow' | 'deny', category: string, reason: string }}
 */
export function evaluate(event, ctx) {
  const deny = (category, reason) => ({ decision: 'deny', category, reason })
  if (!event || typeof event !== 'object' || typeof event.tool_name !== 'string' || event.tool_name === '') {
    return deny('MALFORMED_EVENT', 'event has no tool_name')
  }
  const input = event.tool_input ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) return deny('MALFORMED_EVENT', 'tool_input is not an object')
  if (!ctx.contract) return deny('NO_CONTRACT', ctx.contractError ?? 'no active contract') // R1.5

  const name = event.tool_name.toLowerCase()
  const kind = classify(name)
  if (touchesKeyHome(input, ctx)) return deny('PROTECTED_PATH', 'access to the operator key directory')
  if (kind === 'read') {
    const problem = readOutsideWorkspace(input, ctx)
    if (problem) return deny('OUT_OF_CONTRACT', problem)
  }
  if (kind === 'read' || kind === 'noop') return { decision: 'allow', category: 'ALLOWED', reason: `${kind} tool` }
  // The agent's own tools of the JustRunMe MCP server (exact names only). The server
  // enforces fidelity, selection, signed authorization and receipts itself; any other
  // tool of a server called justrunme*, such as an authorize tool, is not on the list.
  if (kind === 'mcp' && AGENT_TOOL_HOOK_NAMES.has(name)) return { decision: 'allow', category: 'ALLOWED', reason: 'agent tool of the JustRunMe MCP server' }
  if (kind === 'unknown') return deny('UNKNOWN_TOOL', `tool ${event.tool_name} is not covered by the contract`)

  const auth = ctx.authorization
  if (ctx.authorizationError) return deny(ctx.authorizationCategory ?? 'AUTHORIZATION_INVALID', ctx.authorizationError)
  if (auth) {
    const problem = authorizationProblem(auth, ctx.contract, ctx.contractHash)
    if (problem) return deny('AUTHORIZATION_INVALID', problem)
    const window = checkWindow(auth, ctx.contract, ctx.now)
    if (!window.ok) return deny('EXPIRED', window.reason)
  }

  if (kind === 'write') return checkWrite(input, ctx)

  // shell, web and mcp calls execute or reach outside the workspace: only rehearsed actions run.
  let action
  let scripts = []
  let fallbackCategory = 'NOT_REHEARSED'
  if (kind === 'shell') {
    if (typeof input.command !== 'string') return deny('MALFORMED_EVENT', 'shell call has no command string')
    // Kiro's execute_bash takes its own cwd (seen in live events). A rehearsed relative
    // command run from another directory would execute different files, so only the
    // workspace root (or no cwd) is accepted.
    if (input.cwd !== undefined && input.cwd !== null) {
      if (typeof input.cwd !== 'string') return deny('MALFORMED_EVENT', 'shell cwd is not a string')
      const root = realpathSync(ctx.cwd)
      if (realResolve(path.resolve(root, input.cwd)) !== root) {
        return deny('OUT_OF_CONTRACT', 'shell working directory differs from the workspace root')
      }
    }
    const analysis = analyzeShell(input.command)
    scripts = analysis.scripts
    if (analysis.category) {
      action = { tool: 'shell', raw: analysis.raw }
      fallbackCategory = analysis.category
    } else {
      action = { tool: 'shell', argv: analysis.argv }
      if (scripts.length > 0) fallbackCategory = 'UNDECLARED_SCRIPT'
    }
    if (!auth) return deny(fallbackCategory === 'NOT_REHEARSED' ? 'NO_AUTHORIZATION' : fallbackCategory, 'no rehearsed run authorization')
  } else {
    action = { tool: name, input }
    if (kind === 'mcp' && /^mcp_justrunme/.test(name)) fallbackCategory = 'MCP_REENTRY'
    if (!auth) return deny(fallbackCategory === 'NOT_REHEARSED' ? 'NO_AUTHORIZATION' : fallbackCategory, 'no rehearsed run authorization')
  }

  const match = matchEntry({ auth, action, scripts, cwd: ctx.cwd })
  if (!match.ok) return deny(match.category === 'NOT_REHEARSED' ? fallbackCategory : match.category, match.reason)

  if (touchesProtectedTable(JSON.stringify(action), ctx.contract.protected_tables) && match.entry.irreversible_approved !== true) {
    return deny('PROTECTED_TABLE', 'action modifies a protected table without an approved irreversible entry')
  }
  return { decision: 'allow', category: 'ALLOWED', reason: 'matches the rehearsed allowlist' }
}
