/**
 * The agent's closing line in a T25 v2 run: `READY: <migration file>` or `CONFLICT: <reason>`.
 *
 * Markdown around the line is removed (bold, code spans, quote and heading marks, list
 * dashes, emphasis underscores at the ends), but never characters inside it: file names
 * such as `005_cancel_orders.sql` keep their underscores.
 */

const clean = (line) =>
  line
    .replace(/[*`]/g, '')
    .replace(/^[\s>#-]+/, '')
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
