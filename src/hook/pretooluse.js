#!/usr/bin/env node
/**
 * Kiro PreToolUse hook entry point.
 *
 * Inactive unless JUSTRUNME_GATE=on. When on, the event JSON arrives on stdin,
 * exit 2 blocks the tool call and exit 0 lets it proceed (kiro.dev/docs/hooks).
 * The gate-off path avoids loading anything else so it adds almost no latency.
 */

if (process.env.JUSTRUNME_GATE !== 'on') process.exit(0)

let code = 2
try {
  const { runHook } = await import('./run.js')
  code = await runHook({ stdin: process.stdin, stderr: process.stderr, cwd: process.cwd() })
} catch (err) {
  process.stderr.write(JSON.stringify({ justrunme: 'deny', category: 'HOOK_ERROR', reason: String(err?.message ?? err).slice(0, 200) }) + '\n')
}
// exitCode (not process.exit) lets piped stderr flush before the process ends.
process.exitCode = code
