# Scope and Constraints

## In Scope (v1)

| Area | Detail |
|------|--------|
| Mission Contract | Parse and validate YAML; fail-closed on schema errors |
| Rehearsal | git worktree fork + isolated Docker Compose project copy |
| Impact Report | File diff stats, DB row counts/schema delta, container image list, wall-clock time |
| Simulation Fidelity | Fingerprint at rehearsal; re-check before real run; block on mismatch |
| Undo Mission | Pre-run capture of tracked files, `pg_dump`, container config; one-command restore |
| Recovery Verification | Checksums, row counts, schema hash, health endpoint, test suite pass/fail |
| Irreversible Action Flags | Explicit flag in impact report; require out-of-band approval |
| Out-of-Band Approval | WebAuthn passkey assertion bound to SHA-256 of exact action payload |
| Ed25519 Receipts | Per-action signed receipt: hash, verdict, timestamp, public key, mission ID |
| Mission Replay / Judge Mode | Re-verify receipts and fidelity; < 60 s; no production credentials |
| Kiro PreToolUse Hook | `JUSTRUNME_GATE=on` gates every tool call against the active contract |
| MCP Server | `rehearse`, `get_impact_report`, `request_approval`, `get_receipt`, `undo_mission`, `verify_recovery`, `replay_mission` |
| Demo App | Node HTTP + Postgres 16 + Docker Compose; fresh code, not copied |
| Single Operator | One Ed25519 key pair per installation |

## Explicitly Out of Scope (v1)

| Area | Reason |
|------|--------|
| Cloud sync / remote policy store | v2+ |
| Multi-tenant key management | Out of scope for single-operator bootstrap |
| GUI / web UI | CLI and MCP only |
| Universal "undo anything" | Undo covers only: tracked git files, Postgres databases named in the contract, Docker Compose services, and config files listed in the contract. Network calls, email, payment charges, and other external side effects are **not** undoable. |
| Claiming undo for untested resource types | Never claim undo works for a resource type until the restore path has an integration test that verifies it |
| Auto-commit or auto-push | Kiro never commits or pushes |
| Sandboxing shell builtins | The fidelity gate and bypass-resistance rules apply; complete shell sandboxing is a future hardening task |

## Code Origin

- **Never copy code from other repositories**, including but not limited to: `aivaro`, `agent-approval`, `aivaro-agent-crew`, or any private Aivaro workspace.
- All production source in this repository must be written fresh in this session or by a future Kiro session. Referencing closed PR #1 as a design input is permitted; copying its source verbatim is not.
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
