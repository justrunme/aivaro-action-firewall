/**
 * Small SQL lexer for what plan files may contain (T25 v2 review B1, S2).
 *
 * Plan files are fed to psql on stdin, and psql interprets backslash commands there
 * (`\c db superuser` reconnects as another role, `\!` runs a shell in the database
 * container). `metaCommandAt` finds a backslash outside string literals, quoted
 * identifiers, dollar-quoted bodies and comments: such a plan is refused before it
 * runs. `codeOnly` drops comments and the content of single-quoted literals so that
 * text patterns do not match words in a comment; dollar-quoted bodies (DO blocks,
 * function bodies) are code and stay.
 */

/**
 * Walk the text: calls emit(kind, text) for each piece, kind one of
 * code | comment | literal | ident | dollar.
 */
function walk(sql, emit) {
  const s = String(sql)
  let i = 0
  while (i < s.length) {
    const c = s[i]
    const n = s[i + 1]
    if (c === '-' && n === '-') {
      const end = s.indexOf('\n', i)
      const j = end === -1 ? s.length : end
      emit('comment', s.slice(i, j))
      i = j
    } else if (c === '/' && n === '*') {
      // Nested block comments, as in Postgres.
      let depth = 1
      let j = i + 2
      while (j < s.length && depth > 0) {
        if (s[j] === '/' && s[j + 1] === '*') (depth++, (j += 2))
        else if (s[j] === '*' && s[j + 1] === '/') (depth--, (j += 2))
        else j++
      }
      emit('comment', s.slice(i, j))
      i = j
    } else if (c === "'") {
      // E'...' strings use backslash escapes; standard strings double the quote.
      const escaped = i > 0 && /[eE]/.test(s[i - 1]) && (i < 2 || !/[A-Za-z0-9_]/.test(s[i - 2]))
      let j = i + 1
      while (j < s.length) {
        if (escaped && s[j] === '\\') j += 2
        else if (s[j] === "'" && s[j + 1] === "'") j += 2
        else if (s[j] === "'") break
        else j++
      }
      emit('literal', s.slice(i, j + 1))
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < s.length) {
        if (s[j] === '"' && s[j + 1] === '"') j += 2
        else if (s[j] === '"') break
        else j++
      }
      emit('ident', s.slice(i, j + 1))
      i = j + 1
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i))
      if (m && !(i > 0 && /[A-Za-z0-9_]/.test(s[i - 1]))) {
        const tag = m[0]
        const end = s.indexOf(tag, i + tag.length)
        const j = end === -1 ? s.length : end + tag.length
        emit('dollar', s.slice(i, j))
        i = j
      } else {
        emit('code', c)
        i++
      }
    } else {
      emit('code', c)
      i++
    }
  }
}

/** Index of the first psql meta-command backslash, or -1. */
export function metaCommandAt(sql) {
  let at = -1
  let pos = 0
  walk(sql, (kind, text) => {
    if (at === -1 && kind === 'code' && text === '\\') at = pos
    pos += text.length
  })
  return at
}

/** The text with comments removed and single-quoted literals emptied. */
export function codeOnly(sql) {
  let out = ''
  walk(sql, (kind, text) => {
    if (kind === 'comment') out += ' '
    else if (kind === 'literal') out += "''"
    else if (kind === 'dollar') {
      // A dollar-quoted body is code (DO block, function body): strip its comments and literals too.
      const m = /^(\$[A-Za-z0-9_]*\$)([\s\S]*?)(\$[A-Za-z0-9_]*\$)?$/.exec(text)
      out += m ? `${m[1]}${codeOnly(m[2])}${m[3] ?? ''}` : text
    } else out += text
  })
  return out
}
