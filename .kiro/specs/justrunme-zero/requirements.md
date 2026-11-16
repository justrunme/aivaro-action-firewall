# JustRunMe — Requirements

Format: EARS (Easy Approach to Requirements Syntax).
Every requirement is `WHEN <trigger> THE SYSTEM SHALL <response>`.
IDs are stable; do not renumber existing IDs when adding new ones.

---

## R1 — Mission Contract

**R1.1** WHEN an agent submits a mission contract, THE SYSTEM SHALL parse the YAML contract and reject with a structured error if any required field (`id`, `plan`, `resources`, `reversibility`) is absent or malformed.

**R1.2** WHEN a mission contract fails validation, THE SYSTEM SHALL block all execution and return an error that names the failing field and position, with no partial execution having occurred.

**R1.3** WHEN a validated contract is accepted, THE SYSTEM SHALL record the contract hash (SHA-256 of the canonical serialized bytes) and bind all subsequent receipts to that hash.

**R1.4** WHEN an agent attempts to execute a tool call not covered by the active contract, THE SYSTEM SHALL block the call, emit a denial receipt, and log the mismatch.

**R1.5** WHEN no contract is active and `JUSTRUNME_GATE=on`, THE SYSTEM SHALL block every tool call and return an error stating that no active contract exists.

---

## R2 — Rehearsal and Impact Report

**R2.1** WHEN a validated contract is submitted, THE SYSTEM SHALL create a git worktree at a temporary path that is isolated from the main working tree before beginning rehearsal.

**R2.2** WHEN rehearsal begins, THE SYSTEM SHALL start a Docker Compose project with a unique `COMPOSE_PROJECT_NAME` derived from the mission ID, isolating it from any other running Compose project.

**R2.3** WHEN rehearsal completes, THE SYSTEM SHALL emit a structured impact report containing: list of files changed with line-delta counts, database table row counts before and after, schema delta (added/removed tables and columns), container images used, and wall-clock rehearsal duration in milliseconds.

**R2.4** WHEN a rehearsal environment cannot be created (worktree or Compose failure), THE SYSTEM SHALL fail the rehearsal, clean up any partially created resources, and report the failure reason without blocking the operator from retrying.

**R2.5** WHEN rehearsal finishes (success or failure), THE SYSTEM SHALL remove the worktree and stop and remove the isolated Compose project, leaving no dangling volumes or networks.

---

## R3 — Simulation Fidelity

**R3.1** WHEN rehearsal completes successfully, THE SYSTEM SHALL record a fidelity fingerprint comprising: git HEAD commit SHA, SHA-256 of tracked-file tree, Postgres row counts per table, Postgres schema hash, and Docker image digests for all services in the contract.

**R3.2** WHEN a real run is requested after rehearsal, THE SYSTEM SHALL recompute the fidelity fingerprint of the current source state and compare it against the rehearsal fingerprint before allowing any real tool call to execute.

**R3.3** WHEN the fidelity check detects a mismatch in any fingerprint component, THE SYSTEM SHALL block the real run, report which components differ and their before/after values, and require the operator to either re-rehearse or submit a signed override justification.

**R3.4** WHEN the operator submits a signed override justification, THE SYSTEM SHALL record the override in the receipt chain, include the diff of mismatched fingerprint components, and proceed with the real run only after the receipt is written.

**R3.5** WHEN the fidelity check passes, THE SYSTEM SHALL record the pass result in the mission log and proceed with the pre-run capture step.

---

## R4 — Undo Mission

**R4.1** WHEN a real run is authorized and the fidelity check passes, THE SYSTEM SHALL capture pre-run state before any tool call executes: a git stash (or worktree snapshot) of tracked files, a `pg_dump` of every Postgres database named in the contract, container image tags and volume export paths, and the contents of every config file listed in the contract.

**R4.2** WHEN a pre-run capture fails for any named resource, THE SYSTEM SHALL abort the real run, leave all captured resources in place for inspection, and report which resource failed.

**R4.3** WHEN the operator invokes `justrunme undo <mission-id>`, THE SYSTEM SHALL restore all captured resources in reverse capture order: config files first, then containers and volumes, then Postgres databases, then tracked files last.

**R4.4** WHEN restoring a resource during undo, THE SYSTEM SHALL report progress per resource (started, succeeded, failed) and continue restoring remaining resources even if one fails, collecting all failures into the final report.

**R4.5** WHEN undo completes, THE SYSTEM SHALL emit an undo receipt signed with the operator's Ed25519 key, recording mission ID, resources restored, resources failed, and timestamp.

**R4.6** WHEN the operator requests undo for a resource type not in the supported set (tracked git files, Postgres databases, Docker Compose services, named config files), THE SYSTEM SHALL reject the request with an explicit message stating the resource type is not supported for undo.

---

## R5 — Recovery Verification

**R5.1** WHEN undo completes, THE SYSTEM SHALL automatically run a verification pass that computes SHA-256 checksums of restored files and compares them to the pre-run capture manifest.

**R5.2** WHEN verification runs, THE SYSTEM SHALL query Postgres row counts and schema hash and compare them to the pre-run capture values.

**R5.3** WHEN verification runs and the demo application exposes a `GET /health` endpoint, THE SYSTEM SHALL poll the endpoint with exponential back-off (maximum 30 seconds) and record the HTTP status.

**R5.4** WHEN a configurable integration test suite is specified in the contract, THE SYSTEM SHALL execute it and record pass/fail counts.

**R5.5** WHEN all verification checks pass, THE SYSTEM SHALL emit a verification receipt with status `PASS` signed by the operator key.

**R5.6** WHEN any verification check fails, THE SYSTEM SHALL emit a verification receipt with status `FAIL`, listing every failing check with its expected and actual values, signed by the operator key.

---

## R6 — Irreversible Action Approval

**R6.1** WHEN a contract lists an action with `reversibility: false`, THE SYSTEM SHALL mark it as irreversible in the impact report and require out-of-band approval before the action executes.

**R6.2** WHEN any rehearsed action has a measured impact that exceeds a configured threshold (e.g. rows deleted > 1000, external API calls > 0), THE SYSTEM SHALL escalate the action to irreversible and require out-of-band approval even if the contract did not flag it.

**R6.3** WHEN out-of-band approval is required, THE SYSTEM SHALL issue a WebAuthn challenge whose value is the SHA-256 hash of the exact canonical serialized action payload.

**R6.4** WHEN the operator provides a WebAuthn assertion, THE SYSTEM SHALL verify the assertion against the registered credential and the exact challenge hash before allowing the action to execute.

**R6.5** WHEN the WebAuthn assertion fails verification, THE SYSTEM SHALL block the action, emit a denial receipt, and not retry automatically.

**R6.6** WHEN an irreversible action is approved and executes, THE SYSTEM SHALL record the approval assertion reference in the signed receipt so the approval is auditable offline.

---

## R7 — Ed25519-Signed Receipts

**R7.1** WHEN any action is resolved (approved, denied, or undone), THE SYSTEM SHALL emit a receipt containing: action hash (SHA-256 of canonical payload), verdict (`allow`/`deny`/`undo`), mission ID, timestamp (ISO 8601 UTC), operator public key (hex), and a signature over the canonical receipt bytes.

**R7.2** WHEN a receipt is emitted, THE SYSTEM SHALL append it to the hash-chained mission log: each log entry stores the SHA-256 hash of the previous entry, and the genesis entry hashes a fixed well-known constant.

**R7.3** WHEN the mission log is read, THE SYSTEM SHALL verify the hash chain from genesis to head and report any broken links before returning log entries.

**R7.4** WHEN a receipt's Ed25519 signature is verified, THE SYSTEM SHALL check the signature against the operator's public key on file; a mismatch must be reported and the entry flagged as tampered.

**R7.5** WHEN receipts are stored or transmitted, THE SYSTEM SHALL not include secrets, home-directory paths, email addresses, or credential material in any receipt field.

---

## R8 — Mission Replay and Judge Mode

**R8.1** WHEN the operator invokes judge mode for a mission ID, THE SYSTEM SHALL re-verify every receipt in the mission log, recompute action hashes from stored payloads, and report any hash or signature mismatches.

**R8.2** WHEN judge mode runs, THE SYSTEM SHALL complete within 60 seconds and use no production credentials or live external services.

**R8.3** WHEN judge mode detects a policy violation (an action that the contract should have blocked but did not), THE SYSTEM SHALL report it as a `POLICY_VIOLATION` finding with the action ID and contract rule that was breached.

**R8.4** WHEN judge mode completes, THE SYSTEM SHALL emit a structured judge report with counts of receipts verified, mismatches found, policy violations found, and overall status (`PASS` or `FAIL`).

---

## R9 — MCP Server

**R9.1** WHEN the MCP server is started, THE SYSTEM SHALL expose the following tools: `rehearse`, `get_impact_report`, `request_approval`, `get_receipt`, `undo_mission`, `verify_recovery`, `replay_mission`.

**R9.2** WHEN an MCP tool call arrives without a valid mission ID or contract reference, THE SYSTEM SHALL return a structured error with an error code and human-readable message.

**R9.3** WHEN an MCP tool call would trigger an irreversible action, THE SYSTEM SHALL apply the same approval gate as the CLI path; MCP callers cannot bypass the approval requirement.

**R9.4** WHEN an MCP tool returns a receipt, THE SYSTEM SHALL include the receipt's signature and public key so the caller can verify it offline.

---

## R10 — Kiro Hook Enforcement

**R10.1** WHEN `JUSTRUNME_GATE=on` is set and the Kiro `PreToolUse` hook fires, THE SYSTEM SHALL evaluate the incoming tool call against the active contract before allowing Kiro to execute it.

**R10.2** WHEN the hook detects a tool call routed through an inline interpreter (Python `exec`, Node `eval`, shell heredoc, or equivalent), THE SYSTEM SHALL block the call and emit a denial receipt with bypass category `INLINE_INTERPRETER`.

**R10.3** WHEN the hook detects a tool call that invokes an external script not declared in the contract, THE SYSTEM SHALL block the call and emit a denial receipt with bypass category `UNDECLARED_SCRIPT`.

**R10.4** WHEN the hook detects an MCP tool call that re-enters the JustRunMe gate from a different server identity, THE SYSTEM SHALL block the call and emit a denial receipt with bypass category `MCP_REENTRY`.

**R10.5** WHEN the hook blocks a call, THE SYSTEM SHALL exit with code 2 (the Kiro convention for blocking a tool call) and include the denial receipt reference in the hook output.

---

## R11 — Privacy

**R11.1** WHEN writing any log entry, receipt, impact report, or audit artifact, THE SYSTEM SHALL not include email addresses, home-directory absolute paths, or credential material.

**R11.2** WHEN a file path in a log or report would expose a home-directory prefix, THE SYSTEM SHALL replace it with a placeholder (e.g. `$HOME`) before writing.

**R11.3** WHEN test fixtures or seed data are generated, THE SYSTEM SHALL use synthetic names and addresses, not real personal data.

---

## R12 — Demo Application

**R12.1** WHEN the demo application starts, THE SYSTEM SHALL respond to `GET /health` with HTTP 200 and a JSON body `{ "status": "ok", "db": "ok" }` only after the database connection is verified.

**R12.2** WHEN the demo database is seeded, THE SYSTEM SHALL insert a deterministic, fixed number of rows in each table so integration tests can assert exact row counts.

**R12.3** WHEN the demo integration test runs on Linux with Docker available, THE SYSTEM SHALL bring up the Compose stack, wait for health, run the assertions, and tear down — all without leaving containers or volumes behind.

---

## Threat Model

The following bypass vectors are explicitly in scope for the hook enforcement rules above:

| Vector | Mitigation rule |
|--------|----------------|
| Agent calls `python -c 'import subprocess; ...'` to run unapproved code | R10.2 — inline interpreter block |
| Agent writes a shell script to `/tmp` and executes it | R10.3 — undeclared script block |
| Agent re-routes a call through a second MCP server not in the contract | R10.4 — MCP re-entry block |
| Operator rehearses, then another process modifies the DB before the real run | R3.3 — fidelity mismatch block |
| Attacker modifies historical receipt rows in the SQLite log | R7.3 — hash chain verification |
| Agent submits a contract with a schema that bypasses required fields via aliasing | R1.1 — strict schema validation, fail-closed |
| Stale rehearsal (operator delays real run long enough for state to drift) | R3.2 — fingerprint re-check on every real-run request |
