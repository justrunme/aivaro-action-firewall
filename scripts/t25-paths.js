/**
 * ACCESS_VIOLATION check of the T25 runners: which tool-call paths leave the agent workspace.
 *
 * T25 v3 change 3. On macOS a temporary directory's real path starts with `/private`
 * (`/private/var/folders/...`) while the same directory is also written without it
 * (`/var/folders/...`). The v2 runner stripped the prefix from absolute paths and from the
 * workspace root but not from a relative path joined to the workspace, so every relative
 * path looked like a path outside the root. Here the prefix is stripped from the result
 * of the join, whichever way the path arrived.
 */

import path from 'node:path'

const unprivate = (p) => p.replace(/^\/private(?=\/var\/|\/tmp\/)/, '')

/**
 * @param {{ title: string, paths: string[] }[]} tools tool calls with the paths they name
 * @param {string} ws workspace root (absolute)
 * @returns {{ tool: string, path: string }[]} paths that resolve outside the workspace
 */
export function accessViolations(tools, ws) {
  const root = unprivate(path.resolve(ws))
  const bad = []
  for (const t of tools) {
    for (const p of t.paths) {
      const joined = path.isAbsolute(p) ? p : path.join(ws, p)
      const norm = unprivate(path.resolve(joined))
      if (norm !== root && !norm.startsWith(root + path.sep)) bad.push({ tool: t.title, path: p })
    }
  }
  return bad
}
