# Product: Aivaro Action Firewall

## Purpose

Aivaro Action Firewall is a Kiro `PreToolUse` hook that sits in front of every
agent tool call and enforces an explicit allow / deny / ask policy before any
action reaches the runtime.

## Core Capabilities

### Tool Gating (PreToolUse Hook)
Every tool invocation passes through the firewall before execution. The hook
evaluates the action against a policy and resolves to one of three verdicts:
- **allow** — proceed immediately, emit a signed receipt.
- **deny** — block and return an error; log the rejection.
- **ask** — pause execution and prompt the human operator for a one-time decision.

### Phone Passkey Authorization (WebAuthn)
High-risk or policy-escalated actions require a WebAuthn passkey assertion from
the operator's phone. The challenge is the SHA-256 hash of the exact serialized
action payload, binding the biometric approval cryptographically to the specific
tool call — not just a session or intent.

### Ed25519-Signed Receipts
Every resolved action (allow or deny) produces an Ed25519-signed receipt
containing the action hash, verdict, timestamp, and signer public key. Receipts
are verifiable offline without trusting the firewall process.

### Hash-Chained SQLite Audit Log
Receipts are appended to a local SQLite database. Each row stores the SHA-256
hash of the previous row, forming a tamper-evident chain. Any deletion or
modification of historical entries breaks the chain and is detected on next read.

### MCP Power Crew Integration
The firewall exposes a Model Context Protocol (MCP) server so that orchestrator
agents ("Power Crew") can query policy, fetch audit trails, and request
escalations through a standard tool interface.

### Safe Judge Replay
Any historical action sequence can be replayed in a sandboxed judge mode:
receipts are re-verified, the chain is validated, and the judge reports whether
the original policy was applied correctly — enabling post-hoc audits and
regression testing of policy changes.

## Non-Goals (Bootstrap Scope)
- No cloud sync or remote policy store in v1.
- No multi-tenant key management; single operator key pair per installation.
- No GUI; all interaction is CLI or MCP tool calls.
