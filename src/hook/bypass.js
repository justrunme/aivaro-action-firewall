/**
 * Bypass classification for shell calls (R10.2, R10.3, R10.7).
 *
 * The gate is default-deny, so this module does not try to list every bad
 * command. It answers two narrower questions: which script files does this
 * command execute (so their content hash can be bound in the allowlist), and
 * if it cannot be bound, which bypass category explains the denial.
 *
 * Categories: INLINE_INTERPRETER, UNDECLARED_SCRIPT, SHELL_METACHARACTER.
 */

import path from 'node:path'
import { tokenizeShell } from './shell.js'

const INTERPRETERS = new Set([
  'node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'php', 'lua',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'osascript', 'pwsh', 'powershell', 'rscript',
])
// Programs whose argument is itself a program, or that run another command.
const ALWAYS_INLINE = new Set([
  'sed', 'awk', 'gawk', 'eval', 'exec', 'env', 'sudo', 'xargs', 'nohup', 'time', 'timeout',
  'nice', 'command', 'builtin', 'watch', 'stdbuf', 'source', '.',
])
const NPM_LIKE = new Set(['npm', 'yarn', 'pnpm'])
const FETCH_AND_RUN = new Set(['npx', 'bunx', 'pnpx'])
const FETCH_SUBCOMMANDS = new Set(['exec', 'x', 'dlx', 'create', 'init'])
const INLINE_FLAGS = new Set(['-c', '-e', '-E', '-p', '--eval', '--print', '-r', '--require', '--import', '--loader', '--input-type'])
const INLINE_FLAG_PREFIXES = ['--eval=', '--print=', '--require=', '--import=', '--input-type=', '--loader=']

function baseName(program) {
  return path.basename(program).toLowerCase().replace(/\.exe$/, '').replace(/^(python3?)\.\d+$/, '$1')
}

function hasInlineFlag(args) {
  return args.some(
    (a) =>
      INLINE_FLAGS.has(a) ||
      INLINE_FLAG_PREFIXES.some((p) => a.startsWith(p)) ||
      /^-[A-Za-z]*[cepE][A-Za-z]*$/.test(a)
  )
}

/**
 * @param {string} command raw command string from the tool input
 * @returns {{
 *   kind: 'simple' | 'complex',
 *   argv: string[],
 *   raw: string,
 *   scripts: string[],
 *   category: string | null,
 *   detail: string
 * }}
 */
export function analyzeShell(command) {
  const raw = command.trim()
  const token = tokenizeShell(raw)

  if (token.complex) {
    const inline = /\b(python3?|node|nodejs|ruby|perl|php|sh|bash|zsh|eval|exec|source)\b/.test(raw)
    return {
      kind: 'complex',
      argv: token.argv,
      raw,
      scripts: [],
      category: inline ? 'INLINE_INTERPRETER' : 'SHELL_METACHARACTER',
      detail: token.reasons.join('; '),
    }
  }

  const [program, ...args] = token.argv
  const name = baseName(program)
  const simple = (extra) => ({ kind: 'simple', argv: token.argv, raw, scripts: [], category: null, detail: '', ...extra })

  if (ALWAYS_INLINE.has(name)) {
    return simple({ category: 'INLINE_INTERPRETER', detail: `${name} runs code or another command that cannot be bound` })
  }
  if (INTERPRETERS.has(name)) {
    if (hasInlineFlag(args)) {
      return simple({ category: 'INLINE_INTERPRETER', detail: `${name} with an inline code flag` })
    }
    if (name.startsWith('python') && args.includes('-m')) {
      return simple({ category: 'UNDECLARED_SCRIPT', detail: 'python -m runs a module that cannot be bound' })
    }
    const script = args.find((a) => !a.startsWith('-'))
    if (!script) return simple({ category: 'INLINE_INTERPRETER', detail: `${name} without a script file reads code from stdin` })
    return simple({ scripts: [script] })
  }
  if (FETCH_AND_RUN.has(name) || (NPM_LIKE.has(name) && FETCH_SUBCOMMANDS.has(args[0]))) {
    return simple({ category: 'UNDECLARED_SCRIPT', detail: `${name} downloads and runs a package` })
  }
  if (NPM_LIKE.has(name)) return simple({ scripts: ['package.json'] })
  if (name === 'make') return simple({ scripts: ['Makefile'] })
  if (program.includes('/') || program.includes('\\')) return simple({ scripts: [program] })
  return simple()
}
