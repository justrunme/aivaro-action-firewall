# Engineering Standards

## Runtime

- **Node.js 24 LTS**, ESM modules throughout (`"type": "module"` in `package.json`).
- No transpilation step; ship source directly.  `dist/` is reserved for a future
  compiled CLI binary and is not part of v1.

## Module conventions

- File extensions: `.js` (ESM source).  No `.cjs`, no `.mjs`.
- Imports use explicit file extensions: `import { x } from './x.js'`.
- No default exports; use named exports.
- Barrel `index.js` files are permitted only at package root and
  `src/core/index.js`.

## Code style

- No formatter is enforced at spec stage.  When implementation begins, Prettier
  with the project's `.prettierrc` (to be created) is the single source of truth.
- Prefer `const`; use `let` only when reassignment is required.
- Async functions over raw Promise chains.
- Never `catch` and silently swallow; always either rethrow or log + rethrow.

## Testing

- Runner: `node --test` (Node 24 built-in).  No Jest, Mocha, or Vitest.
- Test files live under `test/` and match `**/*.test.js`.
- Run all tests: `npm test`.
- Each unit test file is independent; no shared mutable state between tests.
- Use `node:assert/strict` for assertions.
- Fixtures (databases, keys, policy files) are created in `os.tmpdir()` and
  cleaned up in `after()` hooks.

## Security defaults

- Secrets come from environment variables or the OS keychain; never from
  source files, config files committed to git, or SQLite rows.
- Input from the Kiro hook stdio is treated as untrusted; validate with Zod
  before use.
- Parameterized queries only (better-sqlite3 bound parameters); no string
  interpolation into SQL.
- Dependencies: exact-version pinning in `package.json` (no `^` or `~`).
  Run `npm audit` before every release.

## Logging

- Structured JSON to `stderr` via the internal `src/core/logger.js` module.
- Log levels: `debug`, `info`, `warn`, `error`.  Controlled by `AIVARO_LOG_LEVEL`.
- Never log private keys, raw WebAuthn assertions, or full action payloads at
  `info` or above.

## Error handling

- Domain errors extend a base `AivaroError` class with a `code` string.
- The hook entry point translates domain errors to structured hook error
  responses; it never lets an unhandled exception propagate to Kiro.

## Git workflow

- Branch naming: `kiro/<slug>` for Kiro-authored branches, `feat/<slug>` for
  human-authored feature branches.
- No force-push to `main`.
- CI must pass before merge.
- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Versioning

- Semantic Versioning 2.0.  `0.x` until the first production deployment.
- `CHANGELOG.md` (to be created) tracks changes per release.
