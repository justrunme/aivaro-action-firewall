/**
 * Conservative shell tokenizer for the PreToolUse gate (R10.7).
 *
 * Approach: parse only what can be understood with certainty, which is plain
 * words and quoted strings. Anything that could change meaning at run time
 * (pipes, redirects, substitution, globbing, variables, backslashes, newlines,
 * unterminated quotes) marks the command "complex". Complex commands are never
 * treated as an argv list; the gate handles them separately and defaults to deny.
 */

const METACHARACTERS = '|&;<>`$(){}\\*?[]~!#'

/**
 * @param {string} command
 * @returns {{ argv: string[], complex: boolean, reasons: string[] }}
 */
export function tokenizeShell(command) {
  const reasons = new Set()
  const argv = []
  let current = ''
  let inToken = false
  let quote = null

  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '$' || ch === '`' || ch === '\\') reasons.add('expansion inside double quotes')
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      inToken = true
      continue
    }
    if (ch === '\n' || ch === '\r') {
      reasons.add('newline')
      if (inToken) {
        argv.push(current)
        current = ''
        inToken = false
      }
      continue
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        argv.push(current)
        current = ''
        inToken = false
      }
      continue
    }
    if (METACHARACTERS.includes(ch)) reasons.add(`shell metacharacter ${ch}`)
    current += ch
    inToken = true
  }

  if (quote) reasons.add('unterminated quote')
  if (inToken) argv.push(current)
  if (argv.length === 0) reasons.add('empty command')
  if (argv[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) reasons.add('environment assignment before command')

  return { argv, complex: reasons.size > 0, reasons: [...reasons] }
}
