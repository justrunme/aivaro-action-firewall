# Scope Boundaries

This steering file tells every Kiro agent (and human contributor) what is and
is not in scope for the Aivaro Action Firewall repository.

---

## In scope

| Area | Description |
|------|-------------|
| PreToolUse hook | The `src/hook/` entry point and all code it calls |
| Policy engine | Loading, validating, hot-reloading, and evaluating YAML/JSON policy |
| Receipt factory | Building and Ed25519-signing receipts |
| Audit log | SQLite hash-chained append-only log and chain-verification logic |
| Passkey auth | WebAuthn challenge/assertion flow for `ask`-verdict escalations |
| Key management | OS-keychain / encrypted-file abstraction for the Ed25519 key pair |
| MCP server | `src/mcp/` server exposing `query_policy`, `get_audit_trail`, `request_escalation`, `verify_receipt` |
| Judge replay | Sandboxed read-only replay of historical audit-log entries |
| CLI | `aivaro` command with subcommands: `verify-receipt`, `audit verify`, `passkey register`, `judge replay` |
| Tests | `test/` tree; run with `node --test` |
| CI | `.github/workflows/ci.yml` |
| Docs | `docs/` Markdown files |
| Kiro configuration | `.kiro/` — specs, steering, agents, hooks |

---

## Out of scope (v1 — do not implement or design)

- **Cloud sync**: no remote policy store, no receipt upload, no cloud audit log.
- **Multi-tenant keys**: one operator key pair per installation; no key rotation
  UI, no HSM integration, no PKI hierarchy.
- **GUI / web dashboard**: all interaction is CLI or MCP.
- **Cross-machine federation**: receipts are local; no distributed verification.
- **Custom WebAuthn transport**: the passkey flow targets FIDO2/WebAuthn only;
  TOTP, SMS, or email OTP are not alternatives.
- **Policy authoring UI**: policy files are edited by hand; no policy editor.
- **Agent sandboxing**: the firewall gates tool calls but does not sandbox the
  agent process itself.

---

## Constraints every agent must respect

1. **Never execute `git commit`, `git push`, `git merge`, or any deployment
   command.**  Stage files, write files, run tests — that is all.
2. **Only modify files inside this repository** (`/Users/anl/aivaro-work/aivaro-action-firewall`).
   Do not touch global Kiro config, other projects, or system files.
3. **All features are planned, not implemented**, until a task is explicitly
   started.  Do not write production `src/` code unless a Milestone 1–8 task
   is assigned.
4. **Do not introduce new dependencies** without updating `package.json` and
   noting the addition in the relevant task in `tasks.md`.
5. **Keep `.kiro/` clean**: spec files, steering, agents, and hooks only.
   No build artifacts, no secrets, no large binary files.
