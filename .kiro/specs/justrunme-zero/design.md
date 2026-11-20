# JustRunMe — Design

## 1. System Overview

JustRunMe is a local Node.js process that wraps Kiro agent execution with four
guarantees: **rehearse before run**, **block if state drifted**, **capture
before commit**, and **verify after undo**.

It integrates with Kiro through a `PreToolUse` hook and an MCP server. It has
no cloud component and no GUI. All state is local: SQLite for the receipt chain,
the filesystem for capture archives, and Docker for the rehearsal environment.

```
Kiro agent
    │
    │  submits Mission Contract (YAML)
    ▼
┌──────────────────────────────────────────┐
│  Contract Parser + Validator             │  R1
│  schema check → contract hash → accept  │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│  Rehearsal Engine                        │  R2
│  git worktree fork                       │
│  isolated Compose project                │
│  agent plan executes on disposable copy  │
│  → Impact Report (files, rows, schema,   │
│    containers, duration)                 │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│  Fidelity Gate                           │  R3
│  record fingerprint at rehearsal end     │
│  re-check fingerprint before real run    │
│  mismatch → BLOCK + diff report          │
└───────────────────┬──────────────────────┘
                    │  fidelity pass
                    ▼
┌──────────────────────────────────────────┐
│  Approval Gate                           │  R6
│  irreversible? → WebAuthn challenge      │
│  challenge = SHA-256(canonical payload)  │
│  verify assertion → allow / deny receipt │
└───────────────────┬──────────────────────┘
                    │  approved
                    ▼
┌──────────────────────────────────────────┐
│  Pre-Run Capture                         │  R4
│  git stash / worktree snapshot           │
│  pg_dump per named DB                    │
│  container image tags + volume export    │
│  config file copies                      │
│  → Capture Manifest (checksums + paths)  │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│  Real Run (under PreToolUse hook)        │  R10
│  JUSTRUNME_GATE=on intercepts every call │
│  contract check per call                 │
│  bypass detection (inline, script, MCP)  │
│  emit allow/deny receipt per call        │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│  Receipt Chain (SQLite)                  │  R7
│  per-action Ed25519-signed receipt       │
│  hash-chained rows                       │
└───────────────────┬──────────────────────┘
                    │
         operator invokes undo
                    ▼
┌──────────────────────────────────────────┐
│  Undo Engine                             │  R4
│  restore in reverse: config → containers │
│  → pg_restore → git stash pop            │
│  → Undo Receipt                          │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│  Recovery Verification                   │  R5
│  checksum manifest diff                  │
│  pg row counts + schema hash             │
│  GET /health poll                        │
│  integration test suite                  │
│  → Verification Receipt (PASS/FAIL)      │
└───────────────────┬──────────────────────┘
                    │
         operator invokes judge mode
                    ▼
┌──────────────────────────────────────────┐
│  Judge / Replay                          │  R8
│  re-verify receipt signatures            │
│  recompute action hashes                 │
│  check policy compliance                 │
│  → Judge Report (< 60 s, no live creds)  │
└──────────────────────────────────────────┘
```

---

## 2. Component Map

```
src/
  contract/
    parser.js          — YAML parse + JSON Schema validation, returns ContractRecord
    schema.js          — JSON Schema for the contract format
    hash.js            — SHA-256 of canonical contract bytes
  rehearsal/
    engine.js          — orchestrates worktree + compose fork + plan execution
    worktree.js        — git worktree create / remove
    compose.js         — docker compose up/down with unique project name
    impact.js          — builds ImpactReport from rehearsal state delta
  fidelity/
    fingerprint.js     — computes FidelityFingerprint (git, pg, images)
    gate.js            — compares two fingerprints, returns gate decision
  approval/
    webauthn.js        — issue challenge, verify assertion (libfido2 or platform API)
    gate.js            — decides if action needs approval, routes to webauthn
  capture/
    capture.js         — orchestrates pre-run capture, writes CaptureManifest
    git.js             — git stash / worktree snapshot
    postgres.js        — pg_dump wrapper
    docker.js          — container state + volume export
    config.js          — named config file copy
  undo/
    engine.js          — restore in reverse order from CaptureManifest
    verify.js          — Recovery Verification pass
  receipts/
    receipt.js         — builds and signs ReceiptRecord (Ed25519)
    chain.js           — SQLite hash-chained log (append + verify)
    keys.js            — load operator key pair from env / key file
  hook/
    pretooluse.js      — PreToolUse hook entry point (exit 2 on block)
    bypass.js          — inline interpreter / undeclared script / MCP re-entry detection
  mcp/
    server.js          — MCP server entry point
    tools.js           — tool handler implementations
  judge/
    replay.js          — receipt re-verification + policy compliance check
  privacy/
    redact.js          — redact home paths, emails, credentials from strings/objects
  cli/
    index.js           — CLI entry point (undo, verify, judge, status)
  types/
    index.js           — JSDoc @typedef for all shared record types

demo/
  src/
    server.js          — Node HTTP server (Pumpkin Patch Orders)
    db.js              — Postgres connection pool
    routes/
      health.js        — GET /health
      orders.js        — GET/POST /orders
      patches.js       — GET /patches
  migrations/
    001_init.sql       — create tables
    002_seed_data.sql  — deterministic seed rows
  docker-compose.yml   — app + postgres:16.3-alpine, demo-only credentials
  .env.example         — documented env vars, no real secrets
  integration.test.js  — brings up stack, hits /health, asserts row counts, tears down

test/
  smoke.test.js        — structural invariants (always passes, no Docker needed)
```

---

## 3. Data Formats

### 3.1 Mission Contract (YAML)

```yaml
# File: justrunme.mission.yaml (repository root)
id: "mission-2026-001"
objective: "Apply database migration and restart app"
allowed_paths: ["demo/migrations/", "demo/src/"]
protected_tables: ["orders", "patches"]
time_limit_seconds: 300
irreversible_actions: ["step-3"]
plan:
  - id: "step-1"
    tool: "shell"
    args: ["node", "demo/migrations/run.js"]
    reversibility: true
  - id: "step-2"
    tool: "shell"
    args: ["docker", "compose", "restart", "app"]
    reversibility: true
  - id: "step-3"
    tool: "web_fetch"
    args: ["https://api.example.com/notify"]
    reversibility: false          # triggers approval gate
resources:
  databases: ["pumpkin_patch"]
  config_files: ["demo/.env"]
  compose_services: ["app", "db"]
impact_thresholds:
  max_rows_deleted: 100
  max_external_calls: 0
```

### 3.2 Fidelity Fingerprint

```json
{
  "mission_id": "mission-2026-001",
  "recorded_at": "2026-11-16T20:00:00Z",
  "git_head": "abc123def456...",
  "tree_hash": "sha256:...",
  "postgres": {
    "pumpkin_patch": {
      "row_counts": { "orders": 42, "patches": 7 },
      "schema_hash": "sha256:..."
    }
  },
  "images": {
    "app": "ghcr.io/justrunme/demo-app:0.1.0",
    "db": "postgres:16.3-alpine"
  },
  "uncommitted_hash": "sha256:...",
  "contract_hash": "sha256:...",
  "plan_hash": "sha256:..."
}
```

`postgres.<db>.table_checksums` holds one SHA-256 per table over rows in
primary-key order, in addition to `row_counts` and `schema_hash`.

### 3.2a Run Allowlist Entry

```json
{
  "mission_id": "mission-2026-001",
  "fingerprint_hash": "sha256:...",
  "expires_at": "2026-11-16T20:30:00Z",
  "action": { "tool": "shell", "argv": ["node", "demo/migrations/run.js"] },
  "script_hashes": { "demo/migrations/run.js": "sha256:..." }
}
```

The hook allows a call only if the normalized action equals `action`, every
file in `script_hashes` still hashes to the recorded value, the current
fingerprint equals `fingerprint_hash`, and the entry has not expired. Anything
else, including a parse error, exits 2 (R3.6, R3.7, R10.6).

### 3.3 Impact Report

```json
{
  "mission_id": "mission-2026-001",
  "rehearsal_duration_ms": 4820,
  "files": [
    { "path": "demo/migrations/applied.log", "added": 1, "removed": 0 }
  ],
  "databases": {
    "pumpkin_patch": {
      "before": { "orders": 42, "patches": 7 },
      "after":  { "orders": 42, "patches": 7 },
      "schema_delta": { "added_tables": [], "removed_tables": [], "altered_columns": [] }
    }
  },
  "containers": ["app", "db"],
  "irreversible_actions": ["step-3"],
  "threshold_breaches": []
}
```

### 3.4 Capture Manifest

```json
{
  "mission_id": "mission-2026-001",
  "captured_at": "2026-11-16T20:05:00Z",
  "git": { "stash_ref": "stash@{0}", "head": "abc123..." },
  "postgres": {
    "pumpkin_patch": { "dump_path": "/tmp/jrm-mission-2026-001/pg/pumpkin_patch.dump", "checksum": "sha256:..." }
  },
  "docker": {
    "app": { "image": "ghcr.io/justrunme/demo-app:0.1.0", "volume_backup": "/tmp/jrm-mission-2026-001/vol/app.tar" }
  },
  "config_files": {
    "demo/.env": { "backup_path": "/tmp/jrm-mission-2026-001/cfg/env", "checksum": "sha256:..." }
  }
}
```

### 3.5 Receipt Record

```json
{
  "receipt_id": "rcpt-uuid-v4",
  "mission_id": "mission-2026-001",
  "action_id": "step-1",
  "action_hash": "sha256:...",
  "verdict": "allow",
  "timestamp": "2026-11-16T20:06:00Z",
  "operator_pubkey": "hex-encoded-ed25519-public-key",
  "signature": "hex-encoded-ed25519-signature",
  "prev_chain_hash": "sha256:..."
}
```

The `signature` covers the canonical JSON of all other fields (sorted keys,
no trailing whitespace). `prev_chain_hash` is the SHA-256 of the previous
receipt's canonical JSON, or the well-known genesis constant
`"justrunme:genesis:v1"` for the first entry.

---

## 4. Key Flows

### 4.1 Happy path (reversible mission)

1. Agent calls `rehearse` MCP tool with contract YAML.
2. Contract Parser validates; contract hash stored.
3. Rehearsal Engine forks worktree + Compose project; plan executes.
4. Impact Report emitted; fidelity fingerprint recorded.
5. Operator reviews impact report; calls `request_approval` (no WebAuthn needed
   for reversible-only missions).
6. Fidelity Gate re-checks fingerprint; passes.
7. Pre-Run Capture archives all named resources.
8. Real run begins; PreToolUse hook validates each call against contract.
9. Each allow receipt appended to chain.
10. Run completes; operator calls `undo_mission` if desired.
11. Undo Engine restores in reverse; Undo Receipt emitted.
12. Recovery Verification runs; Verification Receipt emitted.

### 4.2 Fidelity mismatch

After step 4, the DB is modified by another process. At step 6, the Gate detects
row-count drift. The Gate returns a `FIDELITY_MISMATCH` error with the diff. The
real run does not start. The operator must call `rehearse` again.

### 4.3 Irreversible action approval

At step 5, the impact report shows `step-3` calls an external API
(`reversibility: false`). The Approval Gate issues a WebAuthn challenge
(SHA-256 of `step-3`'s canonical payload). Operator approves on device. The
assertion is verified; an approval receipt is written. The real run proceeds.

### 4.4 Bypass attempt (inline interpreter)

Agent sends a tool call: `shell ["python", "-c", "import subprocess; ..."]`.
The PreToolUse hook's bypass detector matches the inline interpreter pattern,
returns exit 2, and writes a denial receipt with
`bypass_category: INLINE_INTERPRETER`.

---

## 5. Threat Model

| Threat | Component | Mitigation |
|--------|-----------|------------|
| Agent calls inline interpreter to escape contract | hook/bypass.js | Pattern match on interpreter + `-c`/`-e` flags; exit 2 |
| Agent writes script to /tmp and executes it | hook/bypass.js | Undeclared-script detection; any executable not in contract blocked |
| MCP re-entry from second server identity | hook/bypass.js | MCP server identity check against contract's declared servers |
| State drift between rehearsal and real run | fidelity/gate.js | Fingerprint re-check; block on any component mismatch |
| Tampered receipt rows in SQLite | receipts/chain.js | Hash chain verification on every read; broken link reported |
| Contract schema aliasing bypasses required fields | contract/parser.js | Strict JSON Schema (additionalProperties: false); fail-closed |
| Stale rehearsal (operator delays real run) | fidelity/gate.js | Fingerprint recomputed fresh on every real-run request |
| Approval assertion replayed for different action | approval/webauthn.js | Challenge is SHA-256(exact payload); assertion is single-use |
| Home path or credential in audit log | privacy/redact.js | Redact before every write; enforced in receipt.js and impact.js |
| pg_dump exposes passwords in dump file | capture/postgres.js | Use `.pgpass` or `PGPASSWORD` env; never log the env var |
| Kiro IDE skips workspace hooks in an untrusted workspace (seen in IDE 1.0.411: log `hooks.v2.executionDisabledUntrustedWorkspace`; shell ran, no receipt) | Kiro IDE, outside JustRunMe | Not prevented by JustRunMe. The untrusted IDE workspace was not probed. Gate Health (`justrunme gate-probe`, src/gate) reports INACTIVE when an ungated session runs the probe command, as checked live for Kiro CLI with the gate off (docs/agent-runs/2026-11-20-gate.md). The operator must run the probe; nothing detects an untrusted IDE session without it |
| Agent fakes a gated session to Gate Health | gate/probe.js, receipts/policy.js | Partly mitigated. ACTIVE needs a signed denial of the probe's own random nonce after the probe started, at most 15 minutes before the result is recorded; its age is counted from that denial, so recording late cannot renew it (verify rule 8). In an ungated session an agent with a shell can read the key directory (the operator key is not passphrase-protected), sign such a denial and remove the canary: Gate Health then shows ACTIVE falsely. It detects misconfiguration (gate off, untrusted workspace), not a hostile agent that is already ungated. Creating the canary only raises a false alarm |
| Agent reads the operator key directory (`JUSTRUNME_HOME`) to sign or approve | hook/evaluate.js | Any tool call naming the key directory or a directory containing it is denied (`PROTECTED_PATH`); shell is default-deny. Same OS user, so this holds only for calls the hook sees (docs/agent-runs/2026-11-20-probe.md) |

---

## 6. What Is and Is Not Reversible

| Resource type | Reversible? | Mechanism |
|---------------|-------------|-----------|
| Tracked git files | Yes | git stash pop / worktree restore |
| Postgres databases (named in contract) | Yes | pg_restore from pg_dump |
| Docker Compose service restart | Yes | docker compose up with captured image tag |
| Named config files (listed in contract) | Yes | file copy restore from capture |
| Network API calls (HTTP POST, webhooks) | **No** | Out-of-band approval required; undo not possible |
| Email / SMS sends | **No** | Out-of-band approval required; undo not possible |
| Payment transactions | **No** | Out-of-band approval required; undo not possible |
| Untracked files (not in git, not in contract) | **No** | Not captured; not restored |
| Shell side effects outside declared resources | **No** | Captured only if listed in contract |

The impact report must list every irreversible action explicitly. Claims about
undo are limited to the resource types in the "Yes" rows above.

---

## 7. Properties Covered by Property-Based Tests

These invariants must each have at least one fast-check property test:

| Property | Module | Test file |
|----------|--------|-----------|
| Fidelity fingerprint is deterministic for identical state | fidelity/fingerprint.js | test/fidelity.test.js |
| Receipt chain: appending N receipts, verifying chain always passes | receipts/chain.js | test/receipts.test.js |
| Receipt chain: mutating any row breaks chain at that position | receipts/chain.js | test/receipts.test.js |
| Undo is idempotent: calling undo twice returns same result | undo/engine.js | test/undo.test.js |
| Contract parser: any YAML missing a required field returns a structured error | contract/parser.js | test/contract.test.js |
| Privacy redactor: no output string contains a home path or email | privacy/redact.js | test/privacy.test.js |

---

## 8. Demo Application Design

The demo is "Pumpkin Patch Orders" — a small produce-ordering service used
purely as a rehearsal and undo target. It is not part of the JustRunMe core.

**Endpoints:**
- `GET /health` — returns `{ status: "ok", db: "ok" }` after a live DB query; 503 if DB unreachable.
- `GET /patches` — list all pumpkin patches (name, location, available_count).
- `GET /orders` — list all orders (id, patch_id, quantity, created_at).
- `POST /orders` — create an order `{ patch_id, quantity }`; decrements available_count; 409 if insufficient stock.

**Database (Postgres 16.3-alpine):**
- Table `patches`: id SERIAL PK, name TEXT, location TEXT, available_count INT.
- Table `orders`: id SERIAL PK, patch_id INT FK, quantity INT, created_at TIMESTAMPTZ.

**Migrations:** versioned SQL files in `demo/migrations/`; applied in filename order.
**Seed:** `002_seed_data.sql` inserts exactly 5 patches and 3 orders (fixed values so tests assert exact counts).
**Credentials:** demo-only password `demo_password` in `docker-compose.yml`; clearly labelled.

**Integration test (`demo/integration.test.js`):**
1. Skips if `process.platform !== 'linux'`.
2. Starts Compose with unique `COMPOSE_PROJECT_NAME=jrm-demo-test-<timestamp>`.
3. Polls `GET /health` with exponential back-off until 200 or 30 s timeout.
4. Asserts `GET /patches` returns 5 rows.
5. Asserts `GET /orders` returns 3 rows.
6. Posts a valid order; asserts 201 and decremented stock.
7. Stops and removes all Compose resources.
