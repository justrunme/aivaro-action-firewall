# JustRunMe — Task Queue

Tasks are grouped by milestone T12–T20 as specified.
Every task lists the R-IDs it satisfies and the tests it must pass.
Status: `[ ]` not started · `[~]` in progress · `[x]` done.

Completed in this session (task 11 — spec, steering, scaffold):
- T11.1 through T11.9 below are the work done in the current Kiro run.

---

## T11 — Spec, Steering, Scaffold (this session)

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T11.1 | Rewrite `.kiro/steering/product.md` for JustRunMe brand, capabilities, naming rules | — | smoke: steering files exist |
| T11.2 | Write `.kiro/steering/engineering.md` (Node 24 ESM, node --test, fast-check, docker-linux-only) | — | smoke: steering files exist |
| T11.3 | Write `.kiro/steering/scope.md` (in/out of scope, code origin, claims policy) | — | smoke: steering files exist |
| T11.4 | Write `.kiro/specs/justrunme-zero/requirements.md` (R1–R12, EARS, threat model) | R1–R12 | smoke: spec files exist and non-empty; requirements R-ID check |
| T11.5 | Write `.kiro/specs/justrunme-zero/design.md` (components, data formats, flows, threat model, PBT table) | R1–R12 | smoke: spec files exist and non-empty |
| T11.6 | Write `.kiro/specs/justrunme-zero/tasks.md` (this file; T12–T20 queue; T-to-R mapping) | — | smoke: tasks.md T-ID and mapping check |
| T11.7 | Write `.kiro/agents/justrunme-builder.json` and `.kiro/agents/justrunme-skeptic.json` | — | smoke: agent JSON valid, field checks |
| T11.8 | Write demo app (`demo/`): server, DB, migrations, seed, docker-compose, integration test | R12 | demo/integration.test.js (Linux only) |
| T11.9 | Update `package.json`, `ci.yml`, `smoke.test.js`, hooks, `docs/KIRO_LOG.md` | — | smoke: all invariants pass |

- [x] T11.1 · [x] T11.2 · [x] T11.3 · [x] T11.4 · [x] T11.5 · [x] T11.6 · [x] T11.7 · [x] T11.8 · [x] T11.9

---

## T12 — Repository Hygiene and CI

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T12.1 | Add `.kiro/` to `.gitignore` exceptions (`!.kiro/`) so the directory is tracked | — | CI: required files present |
| T12.2 | Confirm `git check-ignore .kiro` prints nothing | — | CI: lint-specs job |
| T12.3 | Add `git diff --check` step to CI | — | CI: diff-check job |
| T12.4 | Add `npm audit --audit-level=high` step | — | CI: audit job |
| T12.5 | Pin all images to tags (e.g. `postgres:16.3-alpine`); add digest pinning TODO for T14 | R12.1 | CI: docker-compose syntax check |
| T12.6 | Validate all JSON in `.kiro/` parses cleanly (`jq`) | — | CI: lint-specs validate-json step |
| T12.7 | Rewrite README for JustRunMe with an honest status table | — | CI: brand-name check |
| T12.8 | Remove `exports` and `bin` entries that point to files not yet written | — | `npm test` |
| T12.9 | Confirm hook trigger names against kiro.dev/docs/hooks; `AgentStop` replaced by documented `Stop` | R10.1 | smoke: stop-checklist trigger |
| T12.10 | CI: ubuntu only, run full `npm test`, check whitespace against the PR base, check banned product names in README and `docs/` only | — | CI |
| T12.11 | Spec update: contract fields, allowlist binding (R3.6, R3.7), fingerprint (R3.1), recovery verification (R5.7), Demo A and B acceptance (R13, R14), passkey moved to P2 (R6.7, R6.8) | R3, R5, R6, R13, R14 | smoke: R1 to R14 present |

Provenance check for the six files restored from PR #1: done with `gh pr view 1` and `git log`; same repository, same author (see `scope.md`, Code Origin).

- [x] T12.1 · [x] T12.2 · [x] T12.3 · [x] T12.4 · [x] T12.5 · [x] T12.6 · [x] T12.7 · [x] T12.8 · [x] T12.9 · [x] T12.10 · [x] T12.11

T12.3, T12.4, T12.6 and T12.10 were confirmed on GitHub Actions: all checks on pull request 3 passed (Test, Lint spec and config files, Demo integration test with Docker).

## Plan and deadlines

Priority is one working vertical scenario: Rehearse, Detect, Replan, Run, Undo, Verify. Console work does not start until Demo A (R13) and Demo B (R14) pass.

| Milestone | Result | Deadline |
|-----------|--------|----------|
| T12 | Clean repository, docs, CI | 19 Nov |
| T13, T14 | Real rehearsal and `DATA LOSS` block, allowlist (Demo A) | 23 Nov |
| T15, T16 | Undo, recovery verification, receipts, local approval (Demo B) | 27 Nov |
| T17 | Working Kiro integration | 29 Nov |
| T19 | Judge mode, one command | 1 Dec |
| T18 | Minimal Console | 2 Dec |
| T20 | Video and submission | 3 Dec |

Kiro integration is checked early: T13.7 confirms in a real Kiro session that the hook gets events and exit 2 stops a call. Passkey and phone approval are P2.

---

## T13 — Mission Contract and Hook

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T13.1 | Implement `src/contract/schema.js` (JSON Schema, additionalProperties: false) | R1.1, R1.2 | test/contract.test.js — invalid contracts rejected |
| T13.2 | Implement `src/contract/parser.js` (YAML → validate → ContractRecord + hash) | R1.1, R1.2, R1.3 | test/contract.test.js — valid contract parses; hash stable |
| T13.3 | Property-based test: any YAML missing a required field returns structured error | R1.1 | test/contract.test.js — fast-check property |
| T13.4 | Implement `src/hook/bypass.js` (inline interpreter, undeclared script, MCP re-entry detection) | R10.2, R10.3, R10.4 | test/hook.test.js — each bypass category blocked |
| T13.5 | Implement `src/hook/pretooluse.js` (entry point; contract check; calls bypass.js; exit 2) | R1.4, R1.5, R10.1, R10.5 | test/hook.test.js — allowed call passes; blocked call exits 2 |
| T13.6 | Write `.kiro/hooks/pretooluse.json` (PreToolUse hook running the hook script) | R10.1 | smoke: hook JSON valid |
| T13.7 | Default-deny hook evaluation: parse failure, missing contract and missing authorization all exit 2; replayed `PreToolUse` event fixtures for allowed and blocked calls | R10.6, R10.7, R10.8 | test/hook.test.js |
| T13.8 | Manual check in a real Kiro session: hook receives events and exit 2 stops the tool call; result recorded in `docs/KIRO_LOG.md` | R10.8 | manual, logged |

- [x] T13.1 · [x] T13.2 · [x] T13.3 · [x] T13.4 · [x] T13.5 · [x] T13.6 · [x] T13.7 · [~] T13.8 (Kiro CLI 3.3.0 checked, see KIRO_LOG Run 9; Kiro IDE not checked)

T13 notes (what the code does and does not do yet):
- Done and tested: strict contract parser and hash; default-deny hook; writes limited to `allowed_paths` and never to the gate files; shell, web and MCP calls only if rehearsed, bound to script content hash, mission, contract hash and time window; exit 2 on every error path (150 tests pass locally).
- Not done: comparing `fingerprint_hash` with the live fingerprint (T14.9); signed denial receipts (T16, denials are unsigned audit lines until then); producing the authorization file from a rehearsal (T14). R1.6 protected-table enforcement in the hook is a best-effort text scan; the authoritative check is the measured rehearsal (T14.8).
- T13.8 stays open until the operator confirms in a real Kiro session that the hook receives events and that exit 2 stops a call.

---

## T14 — Rehearsal and Simulation Fidelity

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T14.1 | Implement `src/rehearsal/worktree.js` (git worktree create/remove; cleanup on failure) | R2.1, R2.5 | test/rehearsal.test.js — worktree created and removed |
| T14.2 | Implement `src/rehearsal/compose.js` (unique COMPOSE_PROJECT_NAME; up/down; health poll) | R2.2, R2.5 | test/rehearsal.test.js (Linux) — compose up/down |
| T14.3 | Implement `src/rehearsal/impact.js` (build ImpactReport from state delta) | R2.3 | test/rehearsal.test.js — report structure matches schema |
| T14.4 | Implement `src/rehearsal/engine.js` (orchestrate T14.1–T14.3; cleanup on any failure) | R2.1–R2.5 | test/rehearsal.test.js — full happy path; cleanup on error |
| T14.5 | Implement `src/fidelity/fingerprint.js` (git HEAD, tree hash, pg row counts, schema hash, image digests) | R3.1 | test/fidelity.test.js — determinism PBT |
| T14.6 | Implement `src/fidelity/gate.js` (compare two fingerprints; return gate decision + diff) | R3.2, R3.3, R3.4, R3.5 | test/fidelity.test.js — mismatch detected; pass recorded |
| T14.7 | Add Docker image digest pinning to `demo/docker-compose.yml` | R12 | CI: compose syntax check |
| T14.8 | Verdict `SAFE` or `DATA LOSS` in the impact report; failing-test count; block on `DATA LOSS` | R2.6, R2.7 | test/rehearsal.test.js |
| T14.9 | Run allowlist: entries bind action, script content hash, fingerprint, mission ID, expiry; hook consults it | R3.6, R3.7 | test/fidelity.test.js, test/hook.test.js: script edited after rehearsal is blocked |
| T14.11 | Store each impact report at `.justrunme/missions/<mission-id>/rehearsals/<plan_id>.json` with fields `plan_id`, `source_fingerprint_hash`, `verdict`, `rows_lost`, `failing_tests`, `duration_ms`, `all_reversible` (data structure only; comparison is T18.5) | R15.1 | test/rehearsal.test.js |
| T14.10 | Demo A end to end with a scripted agent: dangerous migration, `DATA LOSS`, block, replan, `SAFE`, run | R13.1 to R13.4 | test/demo-a.test.js (Linux, Docker) |

- [x] T14.1 · [x] T14.2 · [x] T14.3 · [x] T14.4 · [x] T14.5 · [x] T14.6 · [ ] T14.7 · [~] T14.8 · [x] T14.9 · [~] T14.10 · [x] T14.11

T14 notes:
- Tests live in `test/impact.test.js`, `test/authorization.test.js` (fingerprint comparison, signed authorization, hook with a real signature) and `test/demo-a.test.js` (real Docker and Postgres). Demo A passed 4/4 locally with `JRM_DOCKER_TESTS=1`; it runs automatically on Linux CI.
- T14.8 `[~]`: verdict and block are done; the failing-test count is not (no `test_command` in the contract yet), so reports do not claim one.
- T14.10 `[~]`: R13.1 to R13.3 pass; R13.4 (signed receipts for the block and the run) waits for T16.
- T14.7 not done: images are pinned by tag only.
- Authorization is issued only by the operator side (`authorizeMission`), signed with the operator Ed25519 key outside the workspace, bound to the full fingerprint, and consumed by the real run. The hook re-checks signature and git source state on every call; the database part is re-checked by the runner right before execution.
- Comparison of stored rehearsals (R15) is implemented as a library in T17 (counterfactual replay); the `justrunme compare` command (T18.5) is not.

---

## T15 — Undo Mission and Recovery Verification

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T15.1 | Implement `src/capture/git.js` (git stash / worktree snapshot; restore) | R4.1, R4.3 | test/capture.test.js — capture and restore tracked file |
| T15.2 | Implement `src/capture/postgres.js` (pg_dump wrapper; pg_restore; no password in logs) | R4.1, R4.3 | test/capture.test.js (Linux) — dump and restore round-trip |
| T15.3 | Implement `src/capture/docker.js` (image tag record; volume export/import) | R4.1, R4.3 | test/capture.test.js (Linux) — image tag captured |
| T15.4 | Implement `src/capture/config.js` (named file copy and restore) | R4.1, R4.3 | test/capture.test.js — config file round-trip |
| T15.5 | Implement `src/capture/capture.js` (orchestrate T15.1–T15.4; write CaptureManifest; abort on failure) | R4.1, R4.2 | test/capture.test.js — manifest written with checksums |
| T15.6 | Implement `src/undo/engine.js` (restore in reverse order; collect failures; emit undo receipt) | R4.3, R4.4, R4.5, R4.6 | test/undo.test.js — reverse order verified; unsupported type rejected |
| T15.7 | Property-based test: undo idempotence (calling undo twice returns same result) | R4.3 | test/undo.test.js — fast-check property |
| T15.8 | Implement `src/undo/verify.js` (checksum diff, pg row counts, schema hash, health poll, test suite) | R5.1–R5.6 | test/undo.test.js — verification pass and fail cases |
| T15.9 | Verification fails loudly: non-zero exit; negative control that corrupts one value must yield `FAIL` | R5.7, R14.4 | test/undo.test.js |
| T15.10 | Demo B end to end: intentional failure, `justrunme undo`, row counts, content checksums, schema hash, file checksums and `/health` each asserted | R14.1 to R14.5 | test/demo-b.test.js (Linux, Docker) |

Volume backup is not part of v1 undo claims; Docker coverage is image tag and Compose service state only until a volume restore has an integration test.

- [x] T15.1 · [x] T15.2 · [~] T15.3 · [x] T15.4 · [x] T15.5 · [~] T15.6 · [x] T15.7 · [~] T15.8 · [~] T15.9 · [x] T15.10

T15 notes (as built, tests in `test/capture-files.test.js` and `test/demo-b.test.js`):
- T15.1 differs from the original plan: instead of `git stash`, every file under `allowed_paths` and `config_files` is copied with its SHA-256 (`src/capture/files.js`). These are the only workspace paths the gate lets the agent write. Restore rewrites changed files, recreates deleted ones and removes new ones; files outside those paths are neither captured nor claimed. Symbolic links are not followed.
- T15.2: `pg_dump` to a 0600 file plus a measurement. Restore loads into a scratch database, requires it to equal the capture, then swaps names; the previous database is kept as `<db>_jrm_prev_<t>`. Any failure before the swap leaves the live database untouched, and the dump is never deleted.
- T15.3 `[~]`: container images are recorded and verified; containers and volumes are not restored and not claimed.
- T15.6 `[~]`: reverse order, per-resource results, unsupported types refused; the signed undo receipt (R4.5) waits for T16.
- T15.7: undo idempotence is a fast-check property for files and an end-to-end test (undo twice) for Postgres.
- T15.8 `[~]` and T15.9 `[~]`: checksums, row counts, schema hash, images and `/health` (exponential back-off, 30 s) are checked and a corrupted value gives `FAIL` with expected and actual. Not done: the configurable integration test suite (R5.4) and the non-zero CLI exit (no CLI yet), and signed verification receipts (T16).
- Capture happens after the fidelity check and before the authorization is consumed; if capture fails nothing runs and the authorization stays usable. The capture manifest is signed with the operator key.

---

## T16 — Approval and Receipts

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T16.1 | Implement `src/receipts/keys.js` (load Ed25519 key pair from env / key file) | R7.1 | test/receipts.test.js — key load; no path in output |
| T16.2 | Implement `src/receipts/receipt.js` (build + sign ReceiptRecord; redact before write) | R7.1, R7.5 | test/receipts.test.js — signature verifies; no home path in receipt |
| T16.3 | Implement `src/receipts/chain.js` (SQLite append + hash chain verify) | R7.2, R7.3, R7.4 | test/receipts.test.js — chain verifies; mutation breaks chain (PBT) |
| T16.4 | Property-based test: appending N receipts then verifying always passes | R7.2 | test/receipts.test.js — fast-check property |
| T16.5 | Property-based test: mutating any single row breaks chain at that position | R7.3 | test/receipts.test.js — fast-check property |
| T16.6 | (P2) Implement `src/approval/webauthn.js` (challenge issuance; assertion verification) | R6.3, R6.4, R6.5, R6.8 | test/approval.test.js — invalid assertion rejected; valid passes |
| T16.7 | Implement `src/approval/gate.js` (irreversible flag + threshold check; local one-time approval bound to payload hash, nonce, expiry) | R6.1, R6.2, R6.6, R6.7 | test/approval.test.js — escalation, replay rejected, expiry rejected, payload mismatch rejected |

- [x] T16.1 · [x] T16.2 · [x] T16.3 · [x] T16.4 · [x] T16.5 · [ ] T16.6 (P2) · [ ] T16.7

T16 notes (as built, tests in `test/receipts.test.js`, `test/demo-a.test.js`, `test/demo-b.test.js`):
- Storage is a per-mission JSONL file (`src/receipts/chain.js`), not SQLite: one canonical JSON receipt per line with `seq`, `prev_hash`, operator public key and Ed25519 signature. A line must equal the canonical form of its parsed receipt, so whitespace or escape changes are caught as well.
- A signed head anchor per mission lives in the operator key directory (outside the workspace) and catches a cut-off or deleted chain. Appending to a chain that does not verify is refused.
- Receipts are written for rehearsal, authorization issued or refused, run result or refused, undo and verification. Undo and verification receipts close R4.5, R5.5 and R5.6; Demo A's chain closes R13.4.
- `src/receipts/policy.js` checks the story: authorization only after a SAFE rehearsal of the same plan, each authorization used by one run of that plan, undo only for a recorded run, verification directly after its undo.
- T16.1 (done): hook decisions are `hook_decision` receipts in the mission chain. Appends hold an exclusive lock file (`receipts.jsonl.lock`, created by writing the owner token `<pid> <host> <nonce>` to a temp file and `link()`ing it, so a lock is never empty; wait at most 8 s). A lock is never removed because of age: only when its owner is provably dead on this host, with a race-checked rename; the holder re-checks its token before each write. The head anchor is written by rename and keyed by mission and workspace path. An append interrupted between receipt and anchor leaves the chain failing verification (`ANCHOR_BEHIND`), every gated call is denied, and only `reanchorChain` (operator key, written reason, refused for anything except a clean anchor-behind state) recovers. It writes the signed `chain_reanchored` receipt first and moves the anchor second; a crash in between is `REANCHOR_PENDING` (still denied) and a second call completes it without a second receipt. A lock whose owner cannot be determined is never removed automatically: `inspectChainLock` plus `recoverLock` (operator key, reason, exact inspected hash, refused for a live owner) keeps the removed file as evidence and records `lock_recovered`; a kept file without that receipt is `LOCK_RECOVERY_UNRECORDED` and denied. With an active contract the hook denies if the decision cannot be recorded (`RECEIPT_FAILED`) or no operator key is installed (`NO_OPERATOR_KEY`); it never creates a key itself. Only a hash of the tool input is recorded. Without a contract there is no mission chain, so those denials remain unsigned audit lines.
- Not done: T16.7 local approval for irreversible actions.

---

## T17 (operator order, 17 Nov) — Counterfactual Replay

The operator set the order T16.1, then counterfactual replay, then CLI with exit codes, then the final demo. Replay therefore runs under T17 with IDs T17.R1 to T17.R5; the MCP tasks below keep their IDs T17.1 to T17.5 and follow later. The comparison library delivers the core of T18.5; the `justrunme compare` command itself is CLI work.

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T17.R1 | Report records its rehearsal conditions (protected tables, thresholds, database, tests measured) | R15.1 | test/compare.test.js, test/demo-a.test.js |
| T17.R2 | `src/compare/compare.js`: refuse unless every report is operator-signed, is the one the latest rehearsal receipt recorded in a verifying chain, all `base_hash` equal (names differing components, including target identity) and all conditions equal | R15.2 | test/compare.test.js |
| T17.R3 | `src/compare/rank.js`: fixed rule R15.4.1 to R15.4.5, measured values only, rule that decided, rule that removed each plan | R15.3 to R15.5 | test/compare.test.js (unit + property: order-independent, never recommends a plan that is not SAFE) |
| T17.R4 | `src/compare/select.js`: signed comparison file, `plan_selected` receipt with refs to each rehearsal receipt, `plan_comparison_refused` on refusal; policy rule for `plan_selected` | R15.4, R7 | test/compare.test.js |
| T17.R5 | `verifySelection`: replay re-binds plans to rehearsal receipts, re-reads measured values from the signed stored reports (when still present) and re-runs the rule; it does not repeat any measurement | R8.3, R15.4 | test/compare.test.js, test/demo-a.test.js |

- [x] T17.R1 · [x] T17.R2 · [x] T17.R3 · [x] T17.R4 · [x] T17.R5

T17 notes:
- Verdict `FAILED` is removed by R15.4.1 together with `DATA LOSS`: a plan that did not complete has no measured outcome to recommend. This is stricter than the R15.4 text, which names only `DATA LOSS`.
- Failing tests are not measured during rehearsal yet (`tests_measured: false`); every plan shows `failing_tests: null` and R15.4.2 reports "not applied". Tests measured for some plans but not others is refused as not comparable.
- Rehearsal duration is wall-clock time and varies with machine load; R15.4.4 uses it as measured, without tolerance.
- Reports written before T17 have no `conditions` and are refused (`CONDITIONS_UNKNOWN`); rehearse again.
- Selection binds authorization (`src/compare/gate.js`, operator decision on PR 9): only the latest `plan_selected` for the current `base_hash` counts; it must replay, select this plan, have compared this exact report and cover every plan whose latest rehearsal is on this base. No selection: one plan on the base is single-rehearsal mode, several are `COMPARISON_REQUIRED`. A selection on another base grants nothing. Policy checks the same binding from the chain.

---

## T17 — MCP Server, Agents, and Powers

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T17.1 | Implement `src/mcp/tools.js` (all 7 MCP tool handlers; re-use core modules) | R9.1–R9.4 | test/mcp.test.js — each tool returns expected shape |
| T17.2 | Implement `src/mcp/server.js` (MCP server entry point; wire tools; auth check) | R9.1, R9.3 | test/mcp.test.js — server starts; irreversible tool blocked without approval |
| T17.3 | Write `.kiro/agents/justrunme-builder.json` (implements spec tasks; tools: read, write, shell) | — | smoke: agent JSON valid; builder tool check |
| T17.4 | Write `.kiro/agents/justrunme-skeptic.json` (read-only reviewer; tools: read; no write) | — | smoke: agent JSON valid; skeptic read-only check |
| T17.5 | Validate both agents with `kiro-cli agent validate` and record result in KIRO_LOG | — | manual / CI: agent validate step |

- [ ] T17.1 · [ ] T17.2 · [ ] T17.3 · [ ] T17.4 · [ ] T17.5

Note: T11.7 delivers the agent files. T17.3 and T17.4 are the implementation
milestone that adds resources and permissions blocks after the MCP server exists.

---

## T18 — Console UI

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T18.0 | (operator order) Exit code table `src/cli/codes.js`; target file `justrunme.target.json` (validated, protected by the hook); every command a thin call into the library, no path around the gates | R2, R3, R15 | test/cli.test.js, test/hook.test.js |
| T18.1 | Implement `src/cli/index.js` (commands: rehearse, undo, verify, judge, status, receipt) | R2, R4, R5, R8 | test/cli.test.js — each command exits 0 on success |
| T18.2 | JSON output mode (default); plain-text mode with `--text` flag | R11, R12 | test/cli.test.js — JSON parses; --text produces no raw JSON |
| T18.3 | ANSI color gated on NO_COLOR + isTTY; no hardcoded color in test environment | — | test/cli.test.js — no ANSI in piped output |
| T18.4 | Privacy: CLI output never includes home paths or emails | R11.1, R11.2 | test/cli.test.js — redaction assertions |

| T18.5 | (P1) `justrunme compare <plan_id>...`: refuse on fingerprint mismatch, show measured values, deterministic recommendation; Console shows Original vs Revised from the same data | R15.2 to R15.5 | test/compare.test.js: mismatch refused; same input same recommendation; DATA LOSS never recommended |

- [x] T18.0 · [~] T18.1 · [x] T18.2 · [x] T18.3 · [x] T18.4 · [~] T18.5

T18 notes (CLI, not the Console; tests in `test/cli.test.js` and `test/demo-cli.test.js`):
- Commands: `keys init`, `rehearse`, `compare`, `authorize`, `run`, `undo`, `verify`, `replay`, `status`, `receipt`, `reanchor`, `lock inspect|recover`. `judge` is T19. T18.1 `[~]` for that reason.
- JSON on stdout by default, `--text` plain listing, no ANSI ever (T18.3 satisfied by never emitting colour). Output is passed through `redactDeep`.
- T18.5 `[~]`: `justrunme compare` is done; the Console view of Original vs Revised is not.
- Only `keys init` creates an operator key. Read-only commands (`verify`, `replay`, `status`, `receipt`) need only the public key.
- The agent cannot run the CLI with the gate on (hook test: five spellings of the command are denied); plan steps that invoke JustRunMe are refused at authorization (`SELF_REFERENCE`).

---

## T19 — Judge Mode

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T19.1 | Implement `src/judge/replay.js` (re-verify signatures; recompute hashes; policy check; < 60 s) | R8.1, R8.2, R8.3, R8.4 | test/judge.test.js — passes on clean chain; flags tampered entry |
| T19.2 | Judge mode uses no live DB or external credentials | R8.2 | test/judge.test.js — no network calls during replay |
| T19.3 | Judge report emitted as structured JSON with counts and overall PASS/FAIL | R8.4 | test/judge.test.js — report schema matches spec |

| T19.4 | (P2) Chaos Twin: one fault at a named migration marker in the demo, classification reported, repeatable | R16.1 to R16.4 | test/chaos.test.js (Linux, Docker) |

- [~] T19.1 · [~] T19.2 · [x] T19.3 · [ ] T19.4 (P2)

T19 notes (`justrunme judge`, modules in `src/judge/`, tests in `test/judge.test.js` and `test/demo-judge.test.js`):
- Operator order: the judge is a one-command demo against a real Postgres, not only a replay. It builds a throwaway workspace, key and Compose project, then drives the CLI through: rehearse the dangerous plan (DATA LOSS, rows lost measured), authorize it (DENY, `DATA_LOSS`), rehearse the safe plan on the same base, compare, authorize (ALLOW, selection `selected`), run, undo, verify, replay. Then it removes the containers and checks the chain again with no Docker and an empty `PATH`, changes one byte of the chain (verification must fail, exit 30) and puts it back.
- Report: `judge.status` PASS or FAIL, counts (receipts verified, mismatches, policy violations), per-step results with the expected and observed exit code and named checks, the story (measured loss, denial, selection, run, undo), the receipt list with hashes, the operator public key. Exit 0 PASS, 40 FAIL, 41 Docker missing or demo database not prepared.
- A step that does not match stops the run; every later step is reported `skipped`, and a skipped step is never a pass.
- The 60 s budget is judged only when the Postgres image was already on the machine. A first run that downloads it is timed and reported, not judged (`budget_enforced: false`).
- `[~]` T19.1: R8.1 asks for judge mode on a mission ID. `justrunme verify` and `justrunme replay` re-check any recorded mission (chain, policy, selections); `judge` runs its own demo mission and does not take a mission ID. `[~]` T19.2: the offline phase needs no Docker and no `PATH` (tested); "no network calls" is not asserted by a network probe.
- T19.4 (Chaos Twin) is not started.

---

## T21 to T26 — Kiro integration and the agent loop (operator-approved plan, 2026-11-17)

Goal: a real Kiro agent repairs a dangerous plan on its own and can run a plan only with a signed approval it cannot give itself. Order of PRs: A (T21 + T22), B (T23), C (T24), Console (T27), D (T25), E (T26). Video and submission text only after the real-agent run (C).

Decisions fixed by the operator: official MCP SDK from plain JavaScript (no TypeScript, no build); an approver key the MCP process never loads; agent plans are `sql_migration` steps only, inside the operator's mission; one-time approvals; no connection parameters in any tool; rehearsals of agent SQL only in the disposable copy; PRs may be merged by the agent after green CI and a clean `justrunme-skeptic` review.

| ID | Description | Tests |
|----|-------------|-------|
| T21.1 | MCP server (stdio) on `@modelcontextprotocol/server` 2.4.0; tools call the CLI command functions where one exists; closed input schemas; serialized calls; paths and secrets redacted | test/mcp.test.js (plain JSON-RPC client against the real process) |
| T21.2 | Hook: exact agent-tool names `mcp_justrunme_<tool>` allowed, everything else under the server name denied (`MCP_REENTRY`); `tool_load` is bookkeeping; `migrations` paths checked against the key directory | test/hook.test.js |
| T21.3 | Agent plans: `src/mission/plans.js`; sql_migration only, inside `allowed_paths`, regular files, no symlinks, size and count limits; stored effective contract re-validated on every load; `--plan` in the CLI | test/plans.test.js (incl. property test) |
| T21.4 | Live check with Kiro CLI 3.4.0: tool names, hook events | docs/KIRO_LOG.md Run 18 |
| T22.1 | Structured remediation from the signed report: reason, rule, measured impact, constraints, next action; attempt limit; no promise of safety | test/remediation.test.js, test/mcp.test.js |
| T22.2 | Agent loop against real Postgres through MCP: DENIED, revise, SAFE, compare, verify | test/demo-mcp.test.js (Linux, Docker) |
| T23.1 | Approver key: separate Ed25519 key sealed at rest (scrypt + AES-256-GCM, owner-only file), opened only by the human-run CLI; signs authorizations only; the hook and `run` verify with its public half | test/approver.test.js, test/authorization.test.js, test/cli.test.js |
| T23.2 | Approval requests: `request_approval` (SAFE, current, recommended plan only), signed and recorded, bound to report hash, base, SQL file hashes and expiry; `justrunme approvals` / `approve <id> --confirm <plan_id>` / `deny <id> --reason`; chain policy rule 7 (answered once, not after denial or expiry, same plan) | test/approval.test.js |
| T23.3 | `run_mission` (refused without an approval; post-run comparison with the rehearsal), `undo_mission`, `verify_recovery` against real Postgres; the MCP server runs without the passphrase and with the sealed key unreadable | test/demo-approval.test.js (Linux, Docker) |
| T24 | `justrunme-operator` agent (v3, MCP server declared in the agent; `.kiro/settings/mcp.json` is not writable by Kiro), steering, throwaway workspace script; full loop in real Kiro CLI | test/agent-config.test.js; docs/agent-runs/2026-11-18-run1.md, KIRO_LOG Run 20 |
| T27 | Console (`node:http` on 127.0.0.1, startup token, no framework): Missions, Impact Diff, Approval Center, Recovery & Replay; Approve runs `justrunme approve --passphrase-stdin` as a child; no authorization path over HTTP | PR Console |
| T25 | Real-agent evaluation, preregistered set, all runs kept | PR D |
| T26 | `init`, `doctor`, Evidence Timeline | PR E |

- [x] T21.1 · [x] T21.2 · [x] T21.3 · [x] T21.4 · [x] T22.1 · [x] T22.2 · [x] T23.1 · [x] T23.2 · [x] T23.3 · [x] T24 · [ ] T27 · [ ] T25 · [ ] T26

---

## T20 — Submission

| ID | Description | R-IDs | Tests |
|----|-------------|-------|-------|
| T20.1 | Final `README.md`: JustRunMe brand, quick-start, honest Kiro comparison, Kiroween context | — | — |
| T20.2 | `docs/SUBMISSION.md`: write-up of how Kiro was used (hooks, MCP, agents, specs, steering) | — | — |
| T20.3 | Record < 3 min demo video (Rehearse → fidelity mismatch → undo → verify) | — | — |
| T20.4 | Confirm `npm test` green, CI green ubuntu + windows, demo integration test green on Linux | — | CI: all jobs pass |
| T20.5 | PR: `Kiro spec, steering, agents and demo target for JustRunMe` | — | PR review by justrunme-skeptic |
| T20.6 | `gh repo edit justrunme/justrunme-zero --description "Rehearse. Run. Recover. The mission simulator and undo engine for Kiro agents." --add-topic justrunme --add-topic kiro --add-topic kiroween --add-topic mcp --add-topic rehearsal --add-topic undo --remove-topic firewall` | — | manual |

- [ ] T20.1 · [ ] T20.2 · [ ] T20.3 · [ ] T20.4 · [ ] T20.5 · [ ] T20.6

---

## Test-to-Requirement Mapping

| Test file | R-IDs covered |
|-----------|---------------|
| test/smoke.test.js | structure only (all R via scaffold invariants) |
| test/contract.test.js | R1.1, R1.2, R1.3, R1.4, R1.5 |
| test/hook.test.js | R10.1, R10.2, R10.3, R10.4, R10.5 |
| test/rehearsal.test.js | R2.1, R2.2, R2.3, R2.4, R2.5 |
| test/fidelity.test.js | R3.1, R3.2, R3.3, R3.4, R3.5 |
| test/capture.test.js | R4.1, R4.2, R4.3 |
| test/undo.test.js | R4.3, R4.4, R4.5, R4.6, R5.1–R5.6 |
| test/receipts.test.js | R7.1, R7.2, R7.3, R7.4, R7.5 |
| test/approval.test.js | R6.1, R6.2, R6.3, R6.4, R6.5, R6.6 |
| test/mcp.test.js | R9.1, R9.2, R9.3, R9.4 |
| test/cli.test.js | R11.1, R11.2 |
| test/judge.test.js | R8.1, R8.2, R8.3, R8.4 |
| test/privacy.test.js | R11.1, R11.2, R11.3 |
| demo/integration.test.js | R12.1, R12.2, R12.3 |
| test/demo-a.test.js | R13.1, R13.2, R13.3, R13.4, R2.6, R2.7 |
| test/demo-b.test.js | R14.1, R14.2, R14.3, R14.4, R14.5, R5.7 |
