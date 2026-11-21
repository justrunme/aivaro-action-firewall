# Scope and Constraints

## In Scope (v1)

| Area | Detail |
|------|--------|
| Mission Contract | Parse and validate YAML; fail-closed on schema errors |
| Rehearsal | git worktree fork + isolated Docker Compose project copy |
| Impact Report | File diff stats, DB row counts/schema delta, container image list, wall-clock time |
| Rehearsal fidelity | Fingerprint at rehearsal; re-check before real run; block on mismatch |
| Undo Mission | Pre-run capture of tracked files, `pg_dump`, container config; one-command restore |
| Recovery Verification | Checksums, row counts, schema hash, health endpoint, test suite pass/fail |
| Irreversible Action Flags | Explicit flag in impact report; require out-of-band approval |
| Out-of-Band Approval (P1) | Local one-time approval bound to SHA-256 of the exact action payload plus nonce and expiry (R6.7) |
| Run Allowlist | Only rehearsed actions run; entries bind canonical action, script content hash, fingerprint, mission ID and expiry (R3.6) |
| Demo A and Demo B | Acceptance scenarios R13 and R14; these have priority over every other feature |
| Ed25519 Receipts | Per-action signed receipt: hash, verdict, timestamp, public key, mission ID |
| Mission Replay / Judge Mode | Re-verify receipts and fidelity; < 60 s; no production credentials |
| Kiro PreToolUse Hook | `JUSTRUNME_GATE=on` gates every tool call against the active contract |
| MCP Server | `rehearse`, `get_impact_report`, `compare`, `request_approval`, `run_mission`, `get_receipt`, `undo_mission`, `verify_recovery`, `replay_mission`. No tool authorizes or approves; agent plans are `sql_migration` steps only |
| Demo App | Node HTTP + Postgres 16 + Docker Compose; fresh code, not copied |
| Single Operator | One operator Ed25519 key pair per installation (receipts, reports), plus one approver key pair, encrypted at rest and never loaded by the MCP server or the Console (signs run authorizations only) |

## Explicitly Out of Scope (v1)

| Area | Reason |
|------|--------|
| Cloud sync / remote policy store | v2+ |
| Multi-tenant key management | Out of scope for single-operator bootstrap |
| WebAuthn passkey / phone approval (P2) | Deferred; not claimed until implemented and tested (R6.8) |
| Console beyond the local four-screen page | The JustRunMe Console is in scope (operator decision, 2026-11-17): a local web page served by a small `node:http` server on 127.0.0.1, no framework, no build step, no new runtime dependency. Screens: **Missions**, **Impact Diff** (Original Plan against Revised Plan from signed reports), **Approval Center**, **Recovery & Replay** (undo, recovery verification, signed evidence timeline). It reads the same signed data as the CLI and MCP and has no authorization path of its own: Approve hands the operator's passphrase to a `justrunme approve` child process and never holds the approver key; Deny and Undo likewise run `justrunme deny` and `justrunme undo` as children. Not in scope: remote access, accounts, editing contracts, running any other command, cloud. The screen name "Mission Control" stays banned (see `product.md`). |
| Universal "undo anything" | Undo covers only: tracked git files, Postgres databases named in the contract, Docker Compose services, and config files listed in the contract. Network calls, email, payment charges, and other external side effects are **not** undoable. |
| Claiming undo for untested resource types | Never claim undo works for a resource type until the restore path has an integration test that verifies it |
| Auto-commit or auto-push | Kiro never commits or pushes |
| Sandboxing shell builtins | The fidelity gate and bypass-resistance rules apply; complete shell sandboxing is a future hardening task |

## Code Origin

- **Never copy code from other repositories**, including but not limited to: `aivaro`, `agent-approval`, `aivaro-agent-crew`, or any private Aivaro workspace.
- All production source in this repository must be written fresh in this session or by a future Kiro session.
- Provenance of closed PR #1 (checked in T12 with `gh pr view 1` and `git log`): it is in this same repository, authored by the repository owner, commits `3fa6a1e` and `ca90b8c` on branch `kiro/spec-action-firewall`. Files restored from it are therefore not third-party code. Any other source must still be written fresh, and anything whose origin cannot be shown through git history is rewritten and the decision logged in `docs/KIRO_LOG.md`.
- Naming rules apply to public product and feature names. Internal technical words such as goal, snapshot or checkpoint in code or specs are not violations by themselves; CI checks only the banned product names in user-facing material (README and `docs/`).
- If a utility (e.g. a crypto helper) looks identical to code in another repo, rewrite it from scratch with a comment explaining the approach.

## Claims Policy

- Never describe a capability as implemented until there is a passing test that exercises it end-to-end.
- Never claim "zero risk" or "complete undo" without the qualifying statement: "for the resource types listed in the contract."
- Threat model entries must name specific bypass vectors; do not use vague terms like "malicious input."
- Comparisons to Kiro's built-in features must cite documented behavior. Do not speculate about undocumented Kiro internals.

## Naming

See `product.md` for the full naming rules. Summary: use **JustRunMe**, never the banned terms (`Kiro Crew`, `Checkpoint`, `Snapshot`, `Rewind`, `Goal`, `Time Machine`, `Mission Control`) for our own features.

## Privacy

- No secrets, email addresses, or absolute home-directory paths in logs, receipts, test fixtures, or documentation.
- Demo credentials are clearly labelled "demo-only" in `demo/docker-compose.yml` and `demo/.env.example`.
- Redact sensitive fields before writing to the audit log; use the `src/privacy/` module.
