/**
 * The agent's closing line in a T25 v2 run: `READY: <migration file>` or `CONFLICT: <reason>`.
 *
 * Markdown around the line and around each word is removed: bold and code marks at the
 * ends of a word, quote and heading marks, list dashes, emphasis underscores at the ends
 * of the line. Characters inside a word are kept: `005_cancel_orders.sql` keeps its
 * underscores, and `00*5.sql` keeps its star (and is then not a file name `readyFile` accepts).
 */

const word = (w) => w.replace(/^[*`]+/, '').replace(/[*`]+([.,;:!)"']*)$/, '$1')

const clean = (line) =>
  line
    .trim()
    .replace(/^[>#-]+\s*/, '')
    .split(/(\s+)/)
    .map(word)
    .join('')
    .replace(/^_+|_+$/g, '')
    .trim()

/** The last `READY:` or `CONFLICT:` line at the start of a line; the task's own placeholders do not count. */
export function finalLine(text) {
  const lines = String(text)
    .split('\n')
    .map(clean)
    .filter((l) => /^(READY|CONFLICT):/.test(l) && !/<migration file>|<reason>/.test(l))
  return lines.at(-1) ?? null
}

/** The file named by a `READY:` line, without trailing punctuation; null for anything else. */
export const readyFile = (line) => /^READY:\s*([A-Za-z0-9_./-]+?)[.,;:!)"']*$/.exec(line ?? '')?.[1] ?? null

/**
 * Agent text from stream chunks. Chunks of one message are joined as they come; a new
 * message after a tool call starts on a new line, so `…done.` and `READY: …` never share one.
 */
export const breakAfterTool = (text) => (text !== '' && !text.endsWith('\n') ? text + '\n' : text)

export function joinMessages(parts) {
  let text = ''
  for (const p of parts) text = p.kind === 'tool' ? breakAfterTool(text) : text + p.text
  return text
}
