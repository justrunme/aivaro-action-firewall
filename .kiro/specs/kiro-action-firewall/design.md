# Design: Aivaro Action Firewall

## Revision history
| Date | Author | Notes |
|------|--------|-------|
| 2026-11-16 | Kiro (auto) | Initial design — all features planned, none implemented |

---

## 1  Overview

The firewall is a single Node.js 24 ESM process.  It is invoked by Kiro as a
`PreToolUse` hook (stdio protocol) and separately as an MCP server
(`aivaro mcp-serve`).  A shared core library handles policy evaluation, receipt
generation, and audit-log writes; the two entry points are thin adapters over
that core.

```
┌─────────────────────────────────────────────────────┐
│  Kiro Runtime                                        │
│   PreToolUse event ──────────────────────────────► hook/index.js
│                                                       │
│  MCP client ────────────────────────────────────► mcp/server.js
└─────────────────────────────────────────────────────┘
                              │
              ┌───────────────▼───────────────┐
              │        core/firewall.js        │
              │  ┌─────────┐  ┌────────────┐  │
              │  │ policy  │  │  receipt   │  │
              │  │ engine  │  │  factory   │  │
              │  └────┬────┘  └─────┬──────┘  │
              │       │             │          │
              │  ┌────▼─────────────▼──────┐  │
              │  │       audit log         │  │
              │  │   (SQLite, WAL mode)    │  │
              │  └─────────────────────────┘  │
              │  ┌─────────────────────────┐  │
              │  │   passkey / keychain    │  │
              │  └─────────────────────────┘  │
              └───────────────────────────────┘
```

---

## 2  Module Map

| Path | Responsibility |
|------|---------------|
| `src/hook/index.js` | PreToolUse hook entry point; reads stdin, calls `core/firewall.js`, writes verdict to stdout |
| `src/mcp/server.js` | MCP server entry point; registers tools, delegates to `core/firewall.js` |
| `src/core/firewall.js` | Orchestrates policy eval → passkey check → receipt → audit write |
| `src/core/policy.js` | Loads, validates, and watches the policy file; evaluates an action against rules |
| `src/core/receipt.js` | Builds and signs Ed25519 receipts; exposes `verify(receipt)` |
| `src/core/audit.js` | Opens the SQLite database; appends rows; validates the hash chain |
| `src/core/passkey.js` | WebAuthn challenge generation, assertion verification, credential storage |
| `src/core/keychain.js` | OS-keychain / encrypted-file abstraction for private key storage |
| `src/cli/index.js` | CLI entry point (`aivaro`); delegates to subcommand modules |
| `src/cli/verify-receipt.js` | Implements `aivaro verify-receipt <file>` |
| `src/cli/audit.js` | Implements `aivaro audit verify` |
| `src/cli/judge.js` | Implements `aivaro judge replay <start> <end>` |
| `src/cli/passkey.js` | Implements `aivaro passkey register` |

---

## 3  Data Models

### 3.1  Action payload (input to hook)

```jsonc
{
  "sessionId": "sess_…",          // string, Kiro session ID
  "toolName": "fs_write",         // string
  "arguments": { … },             // object, tool-specific
  "timestamp": "2026-11-16T…Z"    // ISO-8601 UTC
}
```

### 3.2  Canonical serialization

For hashing and signing, the action payload is serialized as
`JSON.stringify(payload, Object.keys(payload).sort())` — deterministic key
order, no trailing whitespace.

### 3.3  Receipt

```jsonc
{
  "version": 1,
  "actionHash": "<64-char hex SHA-256>",
  "verdict": "allow" | "deny" | "ask-approved" | "ask-denied",
  "timestamp": "2026-11-16T19:58:00.000Z",
  "signerPublicKey": "<64-char hex Ed25519 public key>",
  "signature": "<128-char hex Ed25519 signature>"
}
```

The `signature` covers `JSON.stringify` of the receipt body with `signature`
set to an empty string, keys sorted.

### 3.4  Audit log schema (SQLite)

```sql
CREATE TABLE receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action_hash TEXT    NOT NULL,
  verdict     TEXT    NOT NULL,
  ts          TEXT    NOT NULL,   -- ISO-8601 UTC
  signer_pk   TEXT    NOT NULL,
  signature   TEXT    NOT NULL,
  prev_hash   TEXT    NOT NULL,   -- SHA-256 of previous row's canonical JSON
  row_hash    TEXT    NOT NULL    -- SHA-256 of this row's canonical JSON (all fields except row_hash)
);
```

The genesis row uses `prev_hash = '0'.repeat(64)`.

### 3.5  Policy file (YAML)

```yaml
version: 1
default: deny          # allow | deny | ask

rules:
  - id: allow-read-only-fs
    match:
      tool: "fs_read"
    verdict: allow

  - id: gate-writes
    match:
      tool: "fs_write"
      args:
        path: "/tmp/**"
    verdict: allow

  - id: escalate-git
    match:
      tool: "execute_bash"
      args:
        command: "git *"
    verdict: ask
```

---

## 4  Key Flows

### 4.1  Allow flow

```
hook/index.js
  │  read stdin → parse action
  ▼
core/firewall.js
  │  policy.evaluate(action) → "allow"
  │  receipt.build(action, "allow")
  │  receipt.sign(receipt)         ← Ed25519 private key from keychain
  │  audit.append(receipt)         ← SQLite WAL COMMIT
  ▼
hook/index.js
  │  write { verdict: "allow", receiptId: … } to stdout
  ▼
Kiro runtime — tool executes
```

### 4.2  Ask flow

```
core/firewall.js
  │  policy.evaluate(action) → "ask"
  │  passkey.challenge(action) → challenge (= actionHash)
  │  [operator receives push notification / QR code]
  │  passkey.verify(assertion, challenge) → ok | fail
  │  if ok  → verdict = "ask-approved"
  │  if fail → verdict = "ask-denied"
  │  receipt.build + sign + audit.append
  ▼
return verdict to caller
```

### 4.3  Chain validation

```
audit.verifyChain()
  │  SELECT * FROM receipts ORDER BY id
  │  for each row:
  │    recompute SHA-256 of prev row's canonical JSON
  │    compare against row.prev_hash
  │    verify Ed25519 signature
  │  if any mismatch → throw TamperError(id, expected, actual)
```

---

## 5  Configuration Reference

| Env var | Default | Purpose |
|---------|---------|---------|
| `AIVARO_POLICY_PATH` | `~/.config/aivaro/policy.yaml` | Policy file location |
| `AIVARO_DB_PATH` | `~/.local/share/aivaro/audit.db` | SQLite database path |
| `AIVARO_MCP_SECRET` | _(required for mcp-serve)_ | Shared secret for MCP authentication |
| `AIVARO_LOG_LEVEL` | `info` | Log verbosity (`debug`/`info`/`warn`/`error`) |
| `AIVARO_KEY_BACKEND` | `keychain` | Key storage backend (`keychain`/`file`) |
| `AIVARO_KEY_FILE_PATH` | `~/.config/aivaro/keys.enc` | Path when `AIVARO_KEY_BACKEND=file` |

---

## 6  Dependencies (planned, unpinned at spec stage)

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | Synchronous SQLite driver (WAL, single-process safe) |
| `@noble/ed25519` | Ed25519 sign / verify (audited, zero-dependency) |
| `@noble/hashes` | SHA-256 (same family, consistent API) |
| `fido2-lib` | WebAuthn server-side assertion verification |
| `keytar` | OS keychain access (macOS Keychain, libsecret, Windows Credential Store) |
| `js-yaml` | YAML policy file parsing |
| `zod` | Runtime schema validation for policy, receipts, and MCP inputs |
| `@modelcontextprotocol/sdk` | MCP server scaffolding |

All packages will be pinned to exact versions before first release (R-NF-04).

---

## 7  Test Strategy

Tests run with `node --test` (Node 24 built-in runner), no additional framework.
See `tasks.md` for the T-ID → test-file mapping.

| Layer | Approach |
|-------|----------|
| Unit | Pure functions in `core/` tested in isolation with synthetic inputs |
| Integration | Hook and MCP entry points exercised against a temp SQLite database |
| Smoke | `test/smoke.test.js` — imports package.json and asserts structural invariants |
| Chain integrity | `audit.verifyChain()` exercised with both valid and tampered fixtures |
| Replay / judge | Judge replay tested against a pre-built fixture DB |

---

## 8  Security Design Notes

- The Ed25519 private key is loaded into memory only during signing and
  immediately released; it is never stored in a module-level variable.
- The WebAuthn challenge is derived solely from the action hash, not from
  any server-generated nonce, so the operator's phone approval is
  cryptographically bound to the exact payload (T-06 mitigation).
- Policy reload (R-PE-02) uses a debounced file-watcher; a parse failure
  retains the previous valid policy in-memory and logs the error — it does
  not fall back to `allow-all` (T-04 mitigation).
- The MCP server validates the `AIVARO_MCP_SECRET` on every request, not
  just at connection time (T-07 mitigation).
