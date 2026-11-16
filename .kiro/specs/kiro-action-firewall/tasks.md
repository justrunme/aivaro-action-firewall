# Tasks: Aivaro Action Firewall

## Revision history
| Date | Author | Notes |
|------|--------|-------|
| 2026-11-16 | Kiro (auto) | Initial task breakdown — all tasks pending |

---

## Status key
- `[ ]` pending
- `[~]` in progress
- `[x]` done

---

## Milestone 0 — Scaffold (this PR)

- [x] **T-00-01** Write `.kiro/specs/kiro-action-firewall/requirements.md`
- [x] **T-00-02** Write `.kiro/specs/kiro-action-firewall/design.md`
- [x] **T-00-03** Write `.kiro/specs/kiro-action-firewall/tasks.md` (this file)
- [x] **T-00-04** Write `.kiro/steering/engineering.md`
- [x] **T-00-05** Write `.kiro/steering/scope.md`
- [x] **T-00-06** Write `.kiro/agents/builder.json`
- [x] **T-00-07** Write `.kiro/agents/skeptic.json`
- [x] **T-00-08** Write `.kiro/hooks/post-file-save.json`
- [x] **T-00-09** Write `.kiro/hooks/stop.json`
- [x] **T-00-10** Write `package.json` (Node 24, ESM, `node --test`)
- [x] **T-00-11** Write `test/smoke.test.js`
- [x] **T-00-12** Write `.github/workflows/ci.yml`
- [x] **T-00-13** Write `docs/KIRO_LOG.md`

---

## Milestone 1 — Core Infrastructure

### Key management
- [ ] **T-01-01** Implement `src/core/keychain.js` — OS keychain / encrypted-file abstraction
  - *Covers*: R-RC-02, R-NF-03
  - *Tests*: `test/unit/keychain.test.js`

- [ ] **T-01-02** Generate Ed25519 key pair on first run; store via keychain
  - *Covers*: R-RC-02
  - *Tests*: `test/unit/keychain.test.js` (key generation path)

### Audit log
- [ ] **T-01-03** Implement `src/core/audit.js` — open DB, create schema, WAL mode
  - *Covers*: R-AL-01, R-AL-06
  - *Tests*: `test/unit/audit.test.js`

- [ ] **T-01-04** Implement `audit.append(receipt)` with hash chaining
  - *Covers*: R-AL-02, R-AL-03
  - *Tests*: `test/unit/audit.test.js` (append + prev_hash)

- [ ] **T-01-05** Implement `audit.verifyChain()` — full replay and tamper detection
  - *Covers*: R-AL-04, R-AL-05
  - *Tests*: `test/unit/audit.test.js` (valid chain), `test/unit/audit-tamper.test.js`

### Receipt factory
- [ ] **T-01-06** Implement `src/core/receipt.js` — build, sign, and verify receipts
  - *Covers*: R-RC-01, R-RC-03
  - *Tests*: `test/unit/receipt.test.js`

---

## Milestone 2 — Policy Engine

- [ ] **T-02-01** Implement `src/core/policy.js` — load and validate YAML/JSON policy
  - *Covers*: R-PE-01, R-PE-04
  - *Tests*: `test/unit/policy.test.js` (valid policy, schema violations)

- [ ] **T-02-02** Implement `policy.evaluate(action)` — rule matching (tool name, arg glob, session, time window)
  - *Covers*: R-PE-03, R-TG-05
  - *Tests*: `test/unit/policy.test.js` (match cases, default verdict)

- [ ] **T-02-03** Implement hot-reload via debounced file watcher; retain last valid on parse failure
  - *Covers*: R-PE-02, R-PE-04
  - *Tests*: `test/unit/policy-reload.test.js`

---

## Milestone 3 — Firewall Core & Hook

- [ ] **T-03-01** Implement `src/core/firewall.js` — orchestrate policy → receipt → audit
  - *Covers*: R-TG-01, R-TG-02, R-TG-03, R-TG-06
  - *Tests*: `test/integration/firewall.test.js`

- [ ] **T-03-02** Implement `src/hook/index.js` — PreToolUse stdio adapter
  - *Covers*: R-TG-01, R-TG-02, R-TG-03, R-TG-04
  - *Tests*: `test/integration/hook.test.js`

- [ ] **T-03-03** Measure allow-verdict latency; confirm ≤ 100 ms p99
  - *Covers*: R-NF-01
  - *Tests*: `test/perf/latency.test.js`

---

## Milestone 4 — Passkey Authorization

- [ ] **T-04-01** Implement `src/core/passkey.js` — WebAuthn challenge generation
  - *Covers*: R-PK-02
  - *Tests*: `test/unit/passkey.test.js`

- [ ] **T-04-02** Implement passkey assertion verification; bind challenge to action hash
  - *Covers*: R-PK-01, R-PK-03
  - *Tests*: `test/unit/passkey.test.js` (valid assertion, wrong-challenge rejection)

- [ ] **T-04-03** Implement credential storage (OS keychain)
  - *Covers*: R-PK-05
  - *Tests*: `test/unit/passkey.test.js` (store + retrieve)

- [ ] **T-04-04** Wire passkey into ask flow in `core/firewall.js`
  - *Covers*: R-TG-04, R-PK-01
  - *Tests*: `test/integration/firewall.test.js` (ask path)

---

## Milestone 5 — CLI

- [ ] **T-05-01** Implement `src/cli/index.js` — command router
  - *Covers*: R-RC-04, R-AL-05, R-JR-01, R-PK-04
  - *Tests*: `test/integration/cli.test.js`

- [ ] **T-05-02** Implement `aivaro verify-receipt <file>`
  - *Covers*: R-RC-04
  - *Tests*: `test/integration/cli.test.js` (valid + tampered receipt)

- [ ] **T-05-03** Implement `aivaro audit verify`
  - *Covers*: R-AL-05
  - *Tests*: `test/integration/cli.test.js` (clean chain, broken chain)

- [ ] **T-05-04** Implement `aivaro passkey register`
  - *Covers*: R-PK-04
  - *Tests*: manual / interactive only (WebAuthn requires device)

- [ ] **T-05-05** Implement `aivaro judge replay <start> <end>`
  - *Covers*: R-JR-01, R-JR-02, R-JR-03, R-JR-04
  - *Tests*: `test/integration/judge.test.js`

---

## Milestone 6 — MCP Server

- [ ] **T-06-01** Implement `src/mcp/server.js` — MCP server scaffold
  - *Covers*: R-MCP-01
  - *Tests*: `test/integration/mcp.test.js`

- [ ] **T-06-02** Implement MCP tool `query_policy`
  - *Covers*: R-MCP-02
  - *Tests*: `test/integration/mcp.test.js`

- [ ] **T-06-03** Implement MCP tool `get_audit_trail`
  - *Covers*: R-MCP-02
  - *Tests*: `test/integration/mcp.test.js`

- [ ] **T-06-04** Implement MCP tool `request_escalation`
  - *Covers*: R-MCP-02, R-MCP-03
  - *Tests*: `test/integration/mcp.test.js`

- [ ] **T-06-05** Implement MCP tool `verify_receipt`
  - *Covers*: R-MCP-02
  - *Tests*: `test/integration/mcp.test.js`

- [ ] **T-06-06** Add per-request shared-secret authentication
  - *Covers*: R-MCP-04
  - *Tests*: `test/integration/mcp.test.js` (unauthenticated rejection)

---

## Milestone 7 — Judge Replay

- [ ] **T-07-01** Implement `src/cli/judge.js` replay engine
  - *Covers*: R-JR-01, R-JR-02, R-JR-03
  - *Tests*: `test/integration/judge.test.js`

- [ ] **T-07-02** Confirm judge replay is read-only (no audit-log writes)
  - *Covers*: R-JR-04
  - *Tests*: `test/integration/judge.test.js` (row count before/after)

---

## Milestone 8 — Hardening & Release

- [ ] **T-08-01** Pin all dependencies to exact versions
  - *Covers*: R-NF-04

- [ ] **T-08-02** Run `npm audit`; resolve all high/critical findings
  - *Covers*: R-NF-04

- [ ] **T-08-03** Add structured JSON stderr logging via `AIVARO_LOG_LEVEL`
  - *Covers*: R-NF-06
  - *Tests*: `test/unit/logger.test.js`

- [ ] **T-08-04** Cross-platform smoke test on macOS, Ubuntu, Windows (CI matrix)
  - *Covers*: R-NF-05

- [ ] **T-08-05** Write `docs/THREAT_MODEL.md` from design.md §5 threat table
  - *Covers*: T-01 through T-08 mitigations

- [ ] **T-08-06** Write `docs/OPERATOR_GUIDE.md` — install, configure, register passkey

---

## Test-to-requirement mapping

| Test file | R-IDs covered |
|-----------|---------------|
| `test/smoke.test.js` | R-NF-04, R-NF-05 (structural) |
| `test/unit/audit.test.js` | R-AL-01, R-AL-02, R-AL-03, R-AL-06 |
| `test/unit/audit-tamper.test.js` | R-AL-04, R-AL-05 |
| `test/unit/receipt.test.js` | R-RC-01, R-RC-03 |
| `test/unit/policy.test.js` | R-PE-01, R-PE-03, R-PE-04, R-TG-05 |
| `test/unit/policy-reload.test.js` | R-PE-02, R-PE-04 |
| `test/unit/passkey.test.js` | R-PK-01, R-PK-02, R-PK-03, R-PK-05 |
| `test/unit/keychain.test.js` | R-RC-02, R-NF-03 |
| `test/unit/logger.test.js` | R-NF-06 |
| `test/integration/firewall.test.js` | R-TG-01 – R-TG-06, R-NF-02 |
| `test/integration/hook.test.js` | R-TG-01 – R-TG-04 |
| `test/integration/cli.test.js` | R-RC-04, R-AL-05, R-PK-04 |
| `test/integration/judge.test.js` | R-JR-01 – R-JR-04 |
| `test/integration/mcp.test.js` | R-MCP-01 – R-MCP-04 |
| `test/perf/latency.test.js` | R-NF-01 |
