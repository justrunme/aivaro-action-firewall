# Requirements: Aivaro Action Firewall

## Revision history
| Date | Author | Notes |
|------|--------|-------|
| 2026-11-16 | Kiro (auto) | Initial spec — all features planned, none implemented |

---

## 1  Scope

This document specifies the functional and non-functional requirements for the
Aivaro Action Firewall.  Every requirement uses the EARS (Easy Approach to
Requirements Syntax) pattern and carries a stable R-ID.

---

## 2  Definitions

| Term | Meaning |
|------|---------|
| Action | A single tool-call event delivered to the firewall hook |
| Verdict | One of `allow`, `deny`, or `ask` |
| Receipt | An Ed25519-signed record attesting to a verdict |
| Chain | The ordered sequence of receipts in the SQLite audit log |
| Operator | The human who owns the passkey and reviews `ask` escalations |
| Policy | The YAML/JSON rule set that maps action patterns to verdicts |

---

## 3  Functional Requirements

### 3.1  Tool Gating (PreToolUse Hook)

**R-TG-01** — WHEN the Kiro runtime emits a `PreToolUse` event, the firewall
SHALL evaluate the action against the active policy before the tool executes.

**R-TG-02** — WHEN the policy yields `allow`, the firewall SHALL emit a signed
receipt and return control to the runtime within 100 ms (p99, local machine).

**R-TG-03** — WHEN the policy yields `deny`, the firewall SHALL block the
tool call, return a structured error to the runtime, and append a denial
receipt to the audit log.

**R-TG-04** — WHEN the policy yields `ask`, the firewall SHALL suspend the
tool call and present the action payload to the operator for a one-time
decision before proceeding.

**R-TG-05** — WHERE no policy rule matches an action, the firewall SHALL apply
a configurable default verdict (factory default: `deny`).

**R-TG-06** — The firewall SHALL process actions sequentially per session,
preserving causal order in the audit log.

### 3.2  Policy Engine

**R-PE-01** — The firewall SHALL load policy from a single YAML or JSON file
whose path is specified in an environment variable `AIVARO_POLICY_PATH`.

**R-PE-02** — WHEN the policy file changes on disk, the firewall SHALL reload
it without restarting the process.

**R-PE-03** — The policy engine SHALL support matching on tool name, argument
key-value patterns (glob), session ID, and time-of-day windows.

**R-PE-04** — WHEN a policy file fails schema validation, the firewall SHALL
retain the last valid policy and log the validation error; it SHALL NOT fall
back to `allow-all`.

### 3.3  Phone Passkey Authorization (WebAuthn)

**R-PK-01** — WHEN the verdict is `ask` and the operator approves, the firewall
SHALL require a WebAuthn assertion from a registered passkey device.

**R-PK-02** — The WebAuthn challenge SHALL be the SHA-256 hash of the
canonically serialized action payload, binding the biometric approval to
that exact call.

**R-PK-03** — The firewall SHALL reject any assertion whose challenge does not
match the hash of the pending action payload.

**R-PK-04** — The firewall SHALL support passkey registration via a one-time
CLI command (`aivaro passkey register`).

**R-PK-05** — Registered passkey credentials SHALL be stored in the OS keychain
or an encrypted local store; they SHALL NOT be written to the policy file or
the audit log.

### 3.4  Ed25519-Signed Receipts

**R-RC-01** — Every resolved action (allow or deny) SHALL produce a receipt
containing: action hash (SHA-256), verdict, ISO-8601 UTC timestamp, signer
public key (hex), and Ed25519 signature over the canonical receipt body.

**R-RC-02** — The firewall SHALL generate an Ed25519 key pair on first run and
persist it in the OS keychain or an encrypted local store.

**R-RC-03** — Receipts SHALL be verifiable offline using only the public key
and the receipt body, without access to the firewall process or database.

**R-RC-04** — The firewall SHALL expose a `verify-receipt` CLI subcommand that
accepts a receipt (JSON) and exits 0 if valid, non-zero otherwise.

### 3.5  Hash-Chained SQLite Audit Log

**R-AL-01** — The firewall SHALL append every receipt to a local SQLite
database at a path configurable via `AIVARO_DB_PATH`.

**R-AL-02** — Each database row SHALL store the SHA-256 hash of the previous
row's canonical serialization, forming a tamper-evident append-only chain.

**R-AL-03** — The first row SHALL record a genesis hash of 64 zero hex
characters in the `prev_hash` field.

**R-AL-04** — WHEN the firewall starts, it SHALL validate the chain from the
last known-good checkpoint; on detecting a break it SHALL halt and emit a
tamper-alert to stderr.

**R-AL-05** — The firewall SHALL expose an `audit verify` CLI subcommand that
replays the full chain and reports the first broken link, if any.

**R-AL-06** — The database file SHALL use WAL journal mode and be readable by
any standard SQLite client for offline inspection.

### 3.6  MCP Server Integration

**R-MCP-01** — The firewall SHALL expose an MCP-compatible server (`aivaro
mcp-serve`) that orchestrator agents can connect to over stdio or a local
Unix socket.

**R-MCP-02** — The MCP server SHALL provide at minimum the following tools:
`query_policy`, `get_audit_trail`, `request_escalation`, `verify_receipt`.

**R-MCP-03** — WHEN an orchestrator calls `request_escalation`, the MCP server
SHALL route the request through the same `ask` flow as a live PreToolUse event.

**R-MCP-04** — The MCP server SHALL authenticate callers using a shared secret
injected via `AIVARO_MCP_SECRET`; unauthenticated calls SHALL be rejected.

### 3.7  Safe Judge Replay

**R-JR-01** — The firewall SHALL provide a `judge replay` CLI subcommand that
accepts a range of audit-log row IDs and replays them in a sandboxed mode.

**R-JR-02** — WHEN replaying, the judge SHALL re-verify every receipt signature
and re-evaluate the action against the policy version recorded at that time.

**R-JR-03** — The judge SHALL report, for each replayed action, whether the
stored verdict matches the current policy re-evaluation, flagging divergences.

**R-JR-04** — Judge replay SHALL be strictly read-only; it SHALL NOT append new
rows to the audit log.

---

## 4  Non-Functional Requirements

**R-NF-01 (Performance)** — The end-to-end firewall latency for an `allow`
verdict SHALL be ≤ 100 ms at p99 on a 2020-era laptop with an idle SQLite
database.

**R-NF-02 (Reliability)** — The firewall SHALL not lose a receipt if the
process is killed after the SQLite `COMMIT` returns.

**R-NF-03 (Security — key storage)** — Private keys SHALL never appear in
environment variables, log files, or the SQLite database.

**R-NF-04 (Security — supply chain)** — The project SHALL pin all runtime
dependencies with exact versions in `package.json`; `npm audit` SHALL report
zero high/critical advisories at release time.

**R-NF-05 (Portability)** — The firewall SHALL run on macOS 14+, Ubuntu 22.04+,
and Windows 11+ under Node.js 24 LTS.

**R-NF-06 (Observability)** — The firewall SHALL emit structured JSON logs to
stderr; log level is configurable via `AIVARO_LOG_LEVEL`.

**R-NF-07 (Auditability)** — All source changes SHALL pass CI before merge;
the CI pipeline SHALL run the full test suite and chain-integrity check.

---

## 5  Threat Model

### 5.1  Assets

| Asset | Value |
|-------|-------|
| Operator private key | Signing authority; compromise enables forged receipts |
| Audit log database | Evidence chain; tampering conceals past actions |
| Policy file | Determines what agents can do; weakening it expands attack surface |
| Passkey credential | Authorizes high-risk actions; theft enables bypass |

### 5.2  Threat Actors

| Actor | Capability |
|-------|-----------|
| Rogue agent | Can call arbitrary tools; cannot access the filesystem outside its sandbox |
| Compromised dependency | Can execute arbitrary code in the firewall process |
| Local attacker | Has read/write access to the filesystem and environment |
| Network attacker | Can intercept unencrypted local sockets |

### 5.3  Threat / Mitigation Matrix

| ID | Threat | Mitigation Requirement |
|----|--------|------------------------|
| T-01 | Agent submits a crafted payload to trigger an unintended `allow` | R-TG-05 (default deny), R-PE-03 (strict pattern matching) |
| T-02 | Agent replays a stale `allow` receipt to bypass future checks | R-RC-01 (action hash bound to receipt), R-AL-02 (chain ordering) |
| T-03 | Local attacker edits audit log rows to erase evidence | R-AL-02 (hash chain), R-AL-04 (startup integrity check) |
| T-04 | Local attacker replaces the policy file with `allow-all` | R-PE-04 (validation on reload), R-NF-07 (CI policy linting) |
| T-05 | Compromised dependency exfiltrates the private key | R-NF-03 (keys never in env/logs), R-RC-02 (OS keychain) |
| T-06 | WebAuthn phishing — operator approves wrong payload | R-PK-02 (challenge = SHA-256 of exact payload) |
| T-07 | MCP caller impersonates orchestrator to request escalation | R-MCP-04 (shared secret authentication) |
| T-08 | Race condition allows tool to execute before verdict is logged | R-TG-01 (hook blocks execution), R-TG-06 (sequential processing) |

---

## 6  Out of Scope (v1)

- Cloud sync or remote policy store
- Multi-tenant key management
- GUI or web dashboard
- Cross-machine receipt federation
