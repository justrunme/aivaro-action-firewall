# Engineering Standards

## Runtime

- **Node.js 24+**, ESM modules throughout (`"type": "module"` in every `package.json`).
- No CommonJS `require()` in new code. Use `import`/`export` and dynamic `import()` where needed.
- All entry points use the `.js` extension; TypeScript source (if added) compiles to `dist/` and is not checked in.
- Target Node.js built-ins first. Add a third-party dependency only when the built-in alternative is materially worse; justify it in the PR.

## Module Design

- Small, single-responsibility modules. A module that needs more than ~200 lines usually has two concerns.
- No circular dependencies. Enforce with `madge --circular` in CI if the module graph grows.
- Public API surfaces are explicit named exports; avoid `export *`.
- Shared types live in `src/types/` as JSDoc `@typedef` blocks or (later) a `.d.ts` file; do not scatter ad-hoc type annotations.

## Testing

- Test runner: `node --test` (Node.js built-in). No Jest, Mocha, or Vitest.
- Test files: `**/*.test.js` under `test/` for unit/integration, `demo/*.test.js` for demo integration tests.
- Structural smoke tests in `test/smoke.test.js` must pass at every commit.
- Property-based tests with **fast-check** for safety-critical properties: fidelity fingerprint stability, receipt chain integrity, undo idempotence, contract parsing edge cases. Add fast-check as a pinned devDependency when those modules are implemented.
- Integration tests that require Docker run only on `ubuntu-latest` CI runners and are skipped automatically on macOS and Windows (`process.platform !== 'linux'`).
- Every test file imports only from the workspace (`../src/...`) or Node built-ins; no test helper frameworks beyond `node:assert/strict` and `node:test`.
- Aim for ≥ 1 property-based test per safety-critical invariant (see `requirements.md`).

## Code Style

- `git diff --check` must pass before every commit (no trailing whitespace, no mixed line endings).
- 2-space indentation; single quotes; no semicolons except where ASI would be ambiguous.
- Async/await everywhere; no raw Promise chains except in event-emitter bridges.
- No `eval`, `Function()`, or dynamic `require`; dynamic `import()` is allowed.
- Secrets must never appear in source, logs, or error messages. Use environment variables; document required vars in `demo/.env.example` and `docs/ENV.md`.
- Log lines must not contain email addresses, home directory paths, or credential material. Use redaction helpers from `src/privacy/`.

## Git

- Kiro never commits or pushes. All `git commit`, `git push`, `git merge`, and `git tag` commands are reserved for the human operator.
- Branch naming: `kiro/<feature>` for Kiro-generated branches, `feat/<feature>` for human branches.
- `git diff --check` is a required CI step.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Docker

- Demo integration tests that use Docker only run on `ubuntu-latest` CI.
- Pin every image by tag in `docker-compose.yml` (e.g. `postgres:16.3-alpine`). Digest pinning (`@sha256:...`) is added in task T14.
- Compose project names are unique per test run; use `COMPOSE_PROJECT_NAME` with a timestamp or random suffix to avoid port collisions.
- Containers must have health checks. Integration tests poll `GET /health` with exponential back-off, not `sleep`.

## Dependencies

- All dependencies are pinned to exact versions (no `^` or `~`). Renovate or Dependabot PRs may use ranges but the lockfile is the authority.
- `npm audit --audit-level=high` must pass in CI.
- `devDependencies` only for test tooling and build tools; nothing that ships with the production module.

## Accessibility and Privacy

- CLI output uses `process.stdout` / `process.stderr` with no ANSI color codes unless `process.env.NO_COLOR` is unset and `process.stdout.isTTY` is true.
- Impact reports and receipts may be rendered as plain text or JSON; default is JSON.
- No home-directory paths, email addresses, or credential fragments in any output or stored artifact.
