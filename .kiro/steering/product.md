# Product: JustRunMe

**Tagline:** Rehearse. Run. Recover.
**Sub-line:** AI says "Just run me." We say "Prove it first."
**Zero** = zero unverified execution, not zero risk.

---

## Purpose

JustRunMe is a Kiro integration layer that makes agent plans verifiable before they touch production. It rehearses the agent's intended actions on a disposable copy of the workspace and database, measures the impact, enforces that nothing has changed before the real run begins, and provides a one-command undo for every supported resource type afterward.

It is not a replacement for Kiro's built-in permissions, hooks, or agent controls. It adds rehearsal, measured impact, fidelity gating, structured undo, and cryptographic receipts for the things Kiro does not track: Postgres data, running containers, and configuration state outside the working tree.

---

## Core Capabilities

### Mission Contract
An agent submits a typed YAML contract describing its plan: tool calls, expected inputs and outputs, resource types touched, reversibility flags, and estimated impact. The contract is parsed, validated, and enforced. Any execution that does not match the contract is blocked (fail-closed).

### Rehearsal and Impact Report
Before the real run, JustRunMe forks the workspace into a git worktree and clones the application's Docker Compose project into an isolated network namespace. The agent's plan executes against this disposable copy. After the rehearsal completes, JustRunMe emits a structured impact report: files changed (with diff stats), database row counts before and after, schema delta, containers affected, and wall-clock duration.

### Rehearsal fidelity
At the end of rehearsal, JustRunMe records a fingerprint of the source state (git HEAD, Postgres row counts and schema hash, container image digests). Before the real run begins, the fingerprint is re-checked. If the source state has drifted from the rehearsed state, the real run is blocked. The operator must re-rehearse or explicitly override with a signed justification.

### Undo Mission
Before every real run, JustRunMe captures:
- a git stash or worktree snapshot of tracked files,
- a `pg_dump` of every named Postgres database in the contract,
- container image tags and volume backup,
- named configuration files listed in the contract.

After the run, a single `justrunme undo <mission-id>` command restores all captured state in reverse order and reports success or failure for each resource. Undo is supported only for the resource types listed above. Network calls, emails, payment transactions, and other external side effects are explicitly flagged as irreversible in the impact report and require out-of-band approval before the run.

### Recovery Verification
After an undo, JustRunMe runs a verification pass: SHA-256 checksums on restored files, Postgres row counts and schema hash compared to the pre-run capture, container health endpoint polls, and a configurable integration test suite. The result is a pass/fail report with per-resource detail.

### Out-of-Band Approval for Irreversible Actions
Any action flagged as irreversible in the contract, or any action whose rehearsal impact exceeds a configured threshold, requires a WebAuthn passkey assertion from the operator's registered device. The challenge is the SHA-256 hash of the exact serialized action payload, binding biometric approval to the specific call, not just a session or intent category.

### Ed25519-Signed Receipts
Every resolved action (approved, blocked, or undone) produces an Ed25519-signed receipt: action hash, verdict, operator public key, timestamp, and mission ID. Receipts are verifiable offline. They chain into the mission log so post-hoc auditors can reconstruct the exact sequence of decisions and outcomes.

### Mission Replay and Judge Mode
Any recorded mission can be replayed in judge mode: receipts are re-verified, the fidelity fingerprint is recomputed against the replay environment, and the judge reports whether the original policy was applied correctly. Judge mode runs in under 60 seconds, uses no production credentials, and emits a structured pass/fail report.

### Kiro Hook Enforcement
JustRunMe runs as a Kiro `PreToolUse` hook when `JUSTRUNME_GATE=on` is set. The hook intercepts every tool call, checks it against the active contract, and blocks calls not covered by an approved contract. The hook itself cannot be bypassed through inline interpreters, shell scripts, or MCP re-entrancy; bypass resistance is part of the threat model.

### MCP Server
JustRunMe exposes an MCP server so Kiro agents can call: `rehearse`, `get_impact_report`, `request_approval`, `get_receipt`, `undo_mission`, `verify_recovery`, `replay_mission`. This lets agents integrate JustRunMe into automated workflows without shell access.

---

## What JustRunMe Is Not

- It does not undo network calls, emails, payment charges, or any external API side effect. Those are marked irreversible and require approval.
- It does not replace Kiro's own permissions, approval flow, or sandbox. It layers on top of them.
- It does not provide unlimited undo for arbitrary shell commands.
- It does not track changes made outside a declared mission contract.

---

## Naming Rules

The public brand is **JustRunMe**. Internal modules may use short names (`rehearsal`, `undo`, `fidelity`, `receipt`).

Do **not** use the following names for JustRunMe features, even informally:
- "Kiro Crew" (Kiro's own orchestration product)
- "Checkpoint" or "Rewind" (Kiro IDE's built-in session undo)
- "Snapshot" (ambiguous with VM snapshots and Kiro checkpoints)
- "Goal" (Kiro's task planning concept)
- Never use "Time Machine" (macOS backup product; implies universal undo, which we do not provide)
- Never use "Mission Control" (macOS window manager). The Console's first screen is called **Missions**.

When comparing to Kiro's built-in features, be accurate:
- Kiro's checkpoints revert files edited by Kiro's own tools in a session. They do not cover Postgres data, running containers, or config state outside the working tree. JustRunMe covers those gaps.
- Kiro's `PreToolUse` hook with `exit 2` blocks a tool call. JustRunMe adds rehearsal and fidelity gating before the hook fires, and structured undo after.
- Kiro's sandbox is off by default. JustRunMe's rehearsal environment is always a disposable copy; the sandbox setting does not affect it.

All comparisons must be accurate and limited to documented behavior.
