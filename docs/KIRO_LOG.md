# Kiro Session Log

This file records every Kiro-authored bootstrap session for the
JustRunMe repository.  Entries are append-only.

---

## Run 1 — 2026-11-16 19:58 CET (Berlin)

| Field | Value |
|-------|-------|
| Date / time | 2026-11-16 19:58 CET (UTC+1, Berlin) |
| Kiro model | unspecified |
| Session type | Bootstrap |
| Branch | main |

### What Kiro wrote

- `LICENSE`
- `README.md`
- `.gitignore`
- `.kiro/steering/product.md`

### Context

Initial repository bootstrap.  Directories were created manually by the
operator before the session.  No source code or spec files existed yet.

---

## Run 2 — 2026-11-16 20:00 CET (Berlin) — UNSUCCESSFUL

| Field | Value |
|-------|-------|
| Date / time | 2026-11-16 20:00 CET (UTC+1, Berlin) |
| Kiro model | unspecified |
| Session type | Kiroween task 11 — first attempt |
| Branch | main |
| Outcome | **Failed — no files written** |

### What happened

Kiro attempted to write spec files and agent/hook configuration but was denied
by tool permission checks before any file could be created.  The session ended
with zero files written.

---

## Run 3 — 2026-11-16 20:02 CET (Berlin)

| Field | Value |
|-------|-------|
| Date / time | 2026-11-16 20:02 CET (UTC+1, Berlin) |
| Kiro model | unspecified |
| Session type | Kiroween task 11 — spec files and scaffold |
| Branch | main |

### What Kiro wrote

- `.kiro/specs/kiro-action-firewall/requirements.md` — EARS requirements with R-IDs, threat model
- `.kiro/specs/kiro-action-firewall/design.md` — module map, data models, key flows, security notes
- `.kiro/specs/kiro-action-firewall/tasks.md` — T-IDs, milestone breakdown, test-to-requirement mapping
- `.kiro/steering/engineering.md` — Node 24 ESM standards, test runner, security defaults
- `.kiro/steering/scope.md` — in-scope / out-of-scope table, agent constraints
- `.kiro/agents/builder.json` — custom builder agent definition (legacy schema)
- `.kiro/agents/skeptic.json` — custom skeptic agent definition (legacy schema)
- `.kiro/hooks/post-file-save.json` — PostFileSave hook (legacy flat schema)
- `.kiro/hooks/stop.json` — Stop hook (legacy flat schema)
- `package.json` — Node 24, ESM, `node --test`, no dependencies yet
- `test/smoke.test.js` — structural smoke tests (28 pass; no src/ yet)
- `.github/workflows/ci.yml` — CI matrix (macOS 14, Ubuntu 22.04, Windows 2022, Node 24)
- `docs/KIRO_LOG.md` — this file

### Context

All target directories were created manually by the operator before the session.
No production source code (`src/`) was written; all Milestone 1–8 tasks remain
pending.  `npm test` passes 28 tests.  Agent and hook files used a legacy flat
schema that did not match the Kiro v1 format; corrected in Run 4.

---

## Run 4 — 2026-11-16 20:06 CET (Berlin)

| Field | Value |
|-------|-------|
| Date / time | 2026-11-16 20:06 CET (UTC+1, Berlin) |
| Kiro model | auto |
| Session type | Kiroween task 11 — corrections run |
| Branch | kiro/spec-action-firewall |

### What Kiro wrote / changed

- `.kiro/agents/aivaro-builder.json` — renamed from `builder.json`; name changed to
  `aivaro-builder`; `instructions` array replaced with `prompt` string; tool list updated
  to current category tags (`read`, `write`, `shell`); hardcoded `<redacted-home>` path removed
- `.kiro/agents/aivaro-skeptic.json` — renamed from `skeptic.json`; name changed to
  `aivaro-skeptic`; `instructions` array replaced with `prompt` string; tool list updated
  to read-only tags (`read`, `shell`); hardcoded `<redacted-home>` path removed
- `.kiro/hooks/test-on-save.json` — renamed from `post-file-save.json`; schema updated
  to v1 format (`version: "v1"`, `hooks` array, `trigger`, `action`); changed from
  agent-prompt to `type: "command"` running `npm test --silent` on `PostFileSave`
  for JS files
- `.kiro/hooks/stop-checklist.json` — renamed from `stop.json`; schema updated to v1
  format; trigger changed from `Stop` to `AgentStop`
- `test/smoke.test.js` — updated agent and hook tests to match new filenames, v1 hook
  schema, correct field names (`prompt` not `instructions`), and added assertions for
  builder tool coverage, skeptic read-only constraint, and no hardcoded paths
- `docs/KIRO_LOG.md` — added missing Run 2 failure entry; corrected branch from
  `kiro/spec-action-firewall` to `main`; added this Run 4 entry

### Context

`npm test` passes 33 tests after corrections.  Legacy `builder.json`,
`skeptic.json`, `post-file-save.json`, and `stop.json` files remain in place as
`.bak` or originals alongside the corrected files; they can be removed once the
team confirms the migration.

### Operator verification and cleanup — 2026-11-16 20:09 CET

Manual cleanup: removed four legacy agent JSON files (including two .bak copies) and two legacy hook JSON files; kept only task-specified filenames. Tests: npm test 33/33 passed; both Kiro agents validated; JSON syntax checks passed; git diff --check passed. No production source was implemented.

### CI repair — 2026-11-16 20:10 CET

Manual: updated four stale required-file paths in `.github/workflows/ci.yml` to the Kiro-corrected agent/hook filenames after CI lint failed on head `3fa6a1e`. No checks were disabled or weakened. macOS runner jobs were cancelled before logs became available; kept macOS matrix enabled.

---

## Run 5 — JustRunMe rebrand and task 11 spec

| Field | Value |
|-------|-------|
| Session type | Task 11 — JustRunMe spec, steering, scaffold |
| Branch | kiro/spec-justrunme |
| Outcome | **Generated scaffold; validation pending** |

### Context

This session rebranded the repository from "Aivaro Action Firewall" to **JustRunMe** and
restored exactly six files from closed PR #1 before adapting them:
`docs/KIRO_LOG.md`, `.github/workflows/ci.yml`, `package.json`,
`test/smoke.test.js`, `.kiro/hooks/test-on-save.json`, and
`.kiro/hooks/stop-checklist.json`. Other generated files were authored fresh.

### Files written / restored from closed PR #1 design

The six restored files listed above were copied from closed PR #1 as authorized, then adapted. Other listed files were generated by Kiro.

- `.kiro/steering/product.md` — JustRunMe brand, capabilities, naming rules, Kiro comparison
- `.kiro/steering/engineering.md` — Node 24 ESM, `node --test`, fast-check, docker-linux-only
- `.kiro/steering/scope.md` — in/out of scope, code origin policy, claims policy, privacy
- `.kiro/specs/justrunme-zero/requirements.md` — R1–R12, EARS format, threat model (7 vectors)
- `.kiro/specs/justrunme-zero/design.md` — module map, data formats, flows, PBT table
- `.kiro/specs/justrunme-zero/tasks.md` — T11–T20 queue, T-to-R mapping, status tracking
- `.kiro/agents/justrunme-builder.json` — builder agent; tools: read, write, shell; v1 schema
- `.kiro/agents/justrunme-skeptic.json` — read-only reviewer; tools: read only; six review categories; v1 schema
- `.kiro/hooks/test-on-save.json` — PostFileSave, `type: command`, runs `npm test --silent` on JS saves
- `.kiro/hooks/stop-checklist.json` — AgentStop, references `justrunme-zero/tasks.md`
- `demo/` — Node HTTP server, Postgres 16, migrations, seed, docker-compose, integration test stub
- `package.json` — updated name to `justrunme-zero`, retained Node 24 ESM, `node --test`
- `.github/workflows/ci.yml` — updated required-file paths to justrunme-zero agent/hook names
- `test/smoke.test.js` — updated all spec paths from `kiro-action-firewall` to `justrunme-zero`; replaced `aivaro-builder`/`aivaro-skeptic` agent assertions with `justrunme-builder`/`justrunme-skeptic`; replaced `R-TG-`/`R-PE-`/`R-PK-` prefix checks with actual JustRunMe R1–R12 sub-ID assertions; added EARS format check, fidelity fingerprint component checks, undo resource-type limit check, threat model vector checks, skeptic read-only tool assertion (no shell), skeptic six-category prompt check, tasks.md T12–T20 milestone check, `KIRO_LOG.md` JustRunMe entry check, and log home-path redaction check
- `docs/KIRO_LOG.md` — updated repository description from "Aivaro Action Firewall" to "JustRunMe"; added this run 5 entry

### What was not written

No production source (`src/`) was implemented.  T12–T20 tasks remain `[ ]` not started.
`npm test` initially failed on stale smoke-test paths; a follow-up Kiro run updated the tests. Operator validation is recorded in the task report.

### Task 11 operator corrections — 2026-11-17 CET

Manual: redacted literal home-path examples from the skeptic prompt and historical log; corrected the Run 5 branch and provenance statement. First non-interactive Kiro attempt was stopped because tool permissions denied writes. Second Kiro v3 run generated steering, spec, agents and demo scaffold, but was cancelled after output stalled; third Kiro v3 run adapted smoke tests and log. Model not reported by CLI; credit usage not shown. Docker integration not yet verified.

### Run 6 — 2026-11-17 00:13–00:16 CET — demo correction

- Task: `2026-11-16-11-justrunme-spec.md`, demo target and integration scaffold (R12, T11.8)
- Model: not reported by Kiro CLI; credits: not displayed
- Prompt: repair Docker Node/Postgres integration, eliminate unavailable `psql` dependency, retain deterministic seed and test coverage
- Kiro generated: `demo/package.json`, `demo/src/db.js` and Docker/SQL/demo corrections
- Operator manual changes: generated npm lockfiles, smoke-test privacy literal cleanup, historical log corrections; no production functionality claimed
- Verification: `npm test` 83/83; Kiro agent validation both passed; Docker Compose started with healthy app/database and HTTP `/health`, `/patches`, `/orders` succeeded; full Linux-only integration test pending GitHub CI

### Manual cleanup — 2026-11-17 00:17 CET

Removed duplicate Kiro-generated `demo/migrations/002_seed.sql`; retained the original `002_seed_data.sql` required by the task. Two seed migrations would otherwise conflict in provenance even though their inserts were idempotent. Removed Markdown trailing whitespace; force-added npm lockfiles despite inherited `.gitignore` rule so CI audit/install can be reproduced.

### CI repair — 2026-11-17 00:18 CET

Manual: first PR head `7d5e706` passed Ubuntu, Windows, and Linux Docker integration; lint failed on three naming-rule mentions in `product.md` despite their negative context. Reworded them to explicit `Never use` prohibitions or a plain limitation; no test was weakened or skipped. CI rerun required on next head.

---

## Run 7 — T12 repository hygiene and spec alignment

| Field | Value |
|-------|-------|
| Date / time | 2026-11-17, exact time not recorded by the session |
| Kiro model | auto (the concrete model is not reported to the session) |
| Session type | T12, docs, CI and spec alignment; no `src/` code |
| Branch | `kiro/t12-hygiene`, created from `kiro/spec-justrunme` at `d56c928` |
| Commits / pushes | None made by Kiro |

### Provenance of the six files restored from closed PR #1

Checked with `gh pr view 1` and `git log`: PR #1 is closed, in this same repository (`justrunme/justrunme-zero`), authored by the repository owner, commits `3fa6a1e` and `ca90b8c` on `kiro/spec-action-firewall`. The six files are therefore not third-party code. No file was rewritten because of provenance.

### Hook trigger check

`kiro.dev/docs/hooks` and `kiro.dev/docs/hooks/types` show `"trigger": "Stop"` in the hook JSON examples, with the UI label "Agent Stop". `AgentStop` does not appear in those pages. `stop-checklist.json` and its smoke test were changed from `AgentStop` to `Stop`. The documented `PreToolUse` event carries `tool_name` and `tool_input`, MCP tools are named `mcp_<server>_<tool>`, and exit code 2 blocks the call. Not yet confirmed in a live Kiro session; that is task T13.8.

### Changed

- `README.md`: rewritten for JustRunMe with a status table that marks everything unimplemented as such.
- `package.json`: removed `exports` and `bin` pointing to files that do not exist.
- `.github/workflows/ci.yml`: ubuntu only; runs full `npm test`; whitespace check against the PR base; brand check limited to banned product names in `README.md` and `docs/` (excluding this log); R1 to R14 prefix check.
- `.kiro/hooks/stop-checklist.json`, `test/smoke.test.js`: trigger name and R13, R14 assertions.
- `.kiro/steering/scope.md`, `.kiro/specs/justrunme-zero/{requirements,design,tasks}.md`: contract fields, allowlist binding, content-level fingerprint, fail-closed hook, loud recovery verification, Demo A and Demo B acceptance (R13, R14), passkey moved to P2, new deadlines.

### Verification (local, macOS)

- `npm test` before changes: 83 pass, 0 fail.
- `npm test` after changes: 85 pass, 0 fail.
- `git diff --check`: clean.
- JSON parse of `.kiro/hooks/*.json` and `package.json`: OK.
- `ci.yml` parsed by Ruby YAML: jobs `test`, `demo-integration`, `lint-specs`; matrix is ubuntu only.
- Not run: GitHub Actions, the Docker demo integration test (`npm run test:demo`), `npm audit`.

### Run 7 follow-up — review fixes

Applied after operator review, same branch, still uncommitted:

- `ci.yml`: both install steps use `npm ci --ignore-scripts` (a local `npm ci --dry-run` reported the lockfile in sync). The whitespace check now compares against `github.event.before` for pushes and the PR base for pull requests, with a merge-base fallback for a first push or an unreachable `before`.
- `requirements.md` R10.7: a dangerous shell construct is allowed only if it ran in rehearsal, the rehearsal environment matched the real run's declared resources, and it touches only declared resources; otherwise blocked. It is stated as a gate on declared actions, not isolation.
- `README.md`: added a sentence that no enforcement mechanism exists yet.
- Verification: see the report in the session; GitHub Actions not run.

---

## Run 8 — T13 contract parser and PreToolUse gate

| Field | Value |
|-------|-------|
| Date | 2026-11-17, exact time not recorded by the session |
| Kiro model | auto (the concrete model is not reported to the session) |
| Session type | T13 implementation, first `src/` code |
| Branch | `kiro/t13-hook`, from `kiro/t12-hygiene` at `6f7ed65` |
| Commits | Made by Kiro on explicit operator instruction, local only: roadmap and R15/R16, dependency pins, contract and privacy modules, hook. No push, no merge. The steering rule that Kiro never commits was overridden by the operator for this session only. |

### Context

The operator had already committed and pushed T12 as `6f7ed65` (pull request 3). All checks on that pull request passed on GitHub Actions: Test, Lint spec and config files, and the Docker demo integration test.

### Written

- `docs/ROADMAP.md` (every item marked NOT IMPLEMENTED), R15 plan comparison (P1) and R16 Chaos Twin (P2) in `requirements.md`, tasks T14.11, T18.5, T19.4.
- Dependencies pinned to exact versions: `yaml` 2.9.1 (no built-in YAML parser), `fast-check` 4.10.2 (dev). `npm audit --audit-level=high`: 0 vulnerabilities.
- `src/util/canonical.js`, `src/privacy/redact.js`, `src/contract/schema.js`, `src/contract/parser.js`.
- `src/hook/{shell,bypass,allowlist,evaluate,run,pretooluse}.js` and `.kiro/hooks/pretooluse.json`.
- `test/contract.test.js`, `test/privacy.test.js`, `test/hook.test.js` (includes property tests and child-process exit-code tests with recorded-style event JSON).

### Verification (local, macOS)

- `npm test`: 150 pass, 0 fail.
- `git diff --check` clean; no trailing whitespace or home paths in new files.
- Not run: GitHub Actions for the T13 branch, Docker demo test, a live Kiro session.

### Open: T13.8 live check (operator)

1. In the workspace root, start Kiro with `JUSTRUNME_GATE=on` in the environment and a valid `justrunme.mission.yaml` (the example in `design.md` section 3.1 works).
2. Ask the agent to run any shell command, for example `ls`. Expected: the call is blocked and the hook reason (category `NO_AUTHORIZATION`) is shown. Check `.justrunme/audit.jsonl` for a `deny` line.
3. Ask the agent to edit a file under an allowed path. Expected: allowed.
4. Ask the agent to edit `justrunme.mission.yaml`. Expected: blocked with `PROTECTED_PATH`.
5. Record the actual Kiro behavior here. If the tool names or event fields differ from the ones in `src/hook/evaluate.js`, the tool-name sets there must be corrected.

### Known limits

- Tool names are matched against a fixed list (Kiro IDE and CLI names differ); unknown tools are denied, so a wrong name fails closed but may also block harmless tools.
- Reads are not gated. Fingerprint comparison and signed denial receipts come later (T14.9, T16).
- Shell analysis is conservative, not a sandbox: it denies anything it cannot parse with certainty.

---

## Run 9 — T13.8 live check, bypass fixes, T14 rehearsal and Demo A

| Field | Value |
|-------|-------|
| Date | 2026-11-17, exact time not recorded by the session |
| Kiro model | auto (the concrete model is not reported to the session) |
| Branch | `kiro/t14-rehearsal`, from `origin/main` at `bb6fd0d` |
| Commits | Local, by Kiro on operator instruction: `67a403a`, `8654c5e`, plus this docs commit. Push and PR creation authorized by the operator; merge not authorized |

### Context

The operator had pushed `kiro/t13-hook` and merged it as pull request 4 (`bb6fd0d`). All checks on that pull request and on `main` passed on GitHub Actions.

### T13.8 live check (Kiro CLI 3.3.0, macOS)

Setup: a throwaway clone outside the repository, a valid `justrunme.mission.yaml` with `allowed_paths: [demo/src/]`, `JUSTRUNME_GATE=on`, `kiro-cli chat --v3 --no-interactive --trust-all-tools --trust-workspace`. Trusting all tools leaves the hook as the only thing that can block. A second, temporary PreToolUse hook in the clone recorded the raw events; it was never part of the repository.

| Step asked of the agent | Kiro tool | Result | Hook category |
|---|---|---|---|
| `ls` | `execute_bash` | Blocked | `NO_AUTHORIZATION` |
| read `package.json` | `read_file` | Allowed | |
| create `demo/src/live-ok.txt` | `fs_write` | Allowed, file created | |
| overwrite `justrunme.mission.yaml` | `fs_write` | Blocked, file unchanged | `PROTECTED_PATH` |
| create `.justrunme/authorization.json` | `fs_write` | Blocked, file not created | `PROTECTED_PATH` |
| `python3 -c 'print(1)'` | `execute_bash` | Blocked | `INLINE_INTERPRETER` |
| create `README-live.txt` at the root | `fs_write` | Blocked, file not created | `OUT_OF_CONTRACT` |

Observed: exit code 2 stops the call and Kiro shows the hook's stderr to the agent; the agent did not retry. Events carry `session_id`, `hook_event_name`, `cwd`, `tool_name`, `tool_input`; paths in `tool_input` are absolute; `execute_bash` input has its own `cwd`, `description`, `run_in_background`, `timeout`. The Stop-checklist hook then made the agent try `rm` on the file it created, which the gate also blocked.

Not checked: Kiro IDE (tool names there differ, for example `str_replace`, `fs_append`), MCP tool calls, `control_bash_process`. T13.8 stays `[~]`.

### Bypasses found and closed

- `execute_bash` `cwd`: a rehearsed `node demo/migrations/run.js` with another `cwd` would run a different file under the same command string. Now blocked unless `cwd` is empty or the workspace root.
- JustRunMe's own code and dependencies inside the workspace (`src/`, `node_modules/`, `package.json`) were writable if `allowed_paths` covered them. Now protected.
- Self-issued authorization: an unsigned file was accepted if it could be written by any means. Authorization is now signed with an operator Ed25519 key in `JUSTRUNME_HOME` (outside the workspace), bound to git HEAD, tree and uncommitted changes, and agent tool calls that touch the key directory are denied, reads included.
- Residual risk recorded in the threat model: authorized code runs as the operator's OS user and could read the key; the gate is opt-in through `JUSTRUNME_GATE`.

### T14 written

`src/rehearsal/{compose,measure,impact,workspace,steps,engine}.js`, `src/fidelity/{source,gate,fingerprint}.js`, `src/authorize/authorization.js`, `src/receipts/keys.js`, `src/run/mission.js`, `src/util/exec.js`; tests `test/{authorization,impact,demo-a}.test.js`; hook tests extended.

### Verification

- `npm test` (macOS, Docker test skipped by design): 173 pass, 0 fail. `git diff --check` clean.
- `JRM_DOCKER_TESTS=1 node --test test/demo-a.test.js` with real Docker and Postgres 16: 4 pass, 0 fail, 60.5 s in total. Measured in that run: dangerous migration `DATA LOSS` with `orders` 3 rows before, 2 after, and column `orders.created_at` removed; real database identical before and after; authorization refused with `DATA_LOSS`; safe migration `SAFE` with `orders.status` added; real run applied it with 3 rows kept; second run refused (authorization consumed); an UPDATE keeping the row count blocked authorization with `FIDELITY_MISMATCH` on `orders.checksum`.
- Local note: the shell had `DOCKER_DEFAULT_PLATFORM=linux/amd64` set, which failed on this arm64 machine; the run above unset it for the test process only. No configuration was changed.
- Not yet run: GitHub Actions for this branch.

### Not done

Failing-test count in the impact report; signed receipts (R13.4, T16); undo (T15); comparison of stored rehearsals (R15); a CLI; Kiro IDE live check; image digest pinning. Demo A takes about 60 s including stack start, so judge mode (under 60 s) will need the stack start shared or the rehearsal made faster.

---

## Run 10 — PR 5 review conditions, T15 undo and recovery verification (Demo B)

| Field | Value |
|-------|-------|
| Date | 2026-11-17, exact time not recorded by the session |
| Kiro model | auto (the concrete model is not reported to the session) |
| Branches | `kiro/t14-rehearsal` (PR 5, commit `f148e69`); `kiro/t15-undo` stacked on it |
| Commits / push | By Kiro, push and PR creation authorized by the operator; no merge |

### PR 5 review conditions

1. Authorization only after a successful rehearsal, not usable for another plan or environment. Two gaps were found and closed:
   - the fingerprint did not identify the environment, so a second Compose project with identical data and images would have accepted the same authorization. It now includes project, database service and name, and the compose file hash;
   - rehearsal reports were unsigned, so an edited report saying SAFE would have been accepted by `authorize`. Reports are now signed with the operator key and checked.
   Tests (real Docker): edited report refused with `REPORT_INVALID`; authorization used with a different plan refused with `AUTHORIZATION_INVALID`; used against a twin project with the same data refused with `FIDELITY_MISMATCH` on `base.target.project`; `FAILED` rehearsal refused with `NOT_SAFE`.
2. Cleanup on errors. The override file is now removed; each report records leftover containers, volumes, networks and worktree. Tests: a failing SQL step and a Compose copy that cannot start (unknown image) both end with 0 containers, 0 volumes, 0 networks, worktree removed, and the real database unchanged. The database dump used to seed a rehearsal is held in memory only.

Demo A after these changes, locally with real Docker: 7 pass, 0 fail.

### T15 written

`src/capture/{files,postgres,capture}.js`, `src/undo/{undo,verify}.js`, `httpStatusInService` in `src/rehearsal/compose.js`; `runMission` now captures before executing. Tests `test/capture-files.test.js` (no Docker, includes a fast-check property) and `test/demo-b.test.js` (real Docker, app and Postgres).

Demo fix: `demo/src/db.js` had no `error` listener on the `pg` pool, so terminating its connections during a restore would have crashed the app. Found while designing the restore; fixed.

### Demo B evidence (local, real Docker, app and Postgres 16): 6 pass, 0 fail, 70.5 s

- The plan rehearsed `SAFE`; in the real run step 1 changed `orders` data and the `patches` schema, step 2 wrote `applied.log` and changed `app.config.json`, then failed (`notification service unreachable`, simulated with `DEMO_NOTIFY_FAIL=1` for the real run only).
- Undo restored in the order config files, containers (verify only), Postgres, files. Verification `PASS` with each check asserted: schema hash, row count and content checksum per table, file hashes, no unexpected files, container images, `/health` 200. Live state independently equal to the state before the run.
- Undo a second time: same verified state.
- Negative control: one quantity set to 999 and a stray file added gives `FAIL`, with the `orders` checksum expected and actual values; the row-count check alone would have passed.
- Restore failures: a dump that no longer matches its checksum, and a dump with matching checksum but invalid SQL, both leave the live database unchanged; with the original capture back, the retry recovers fully.
- Undo refuses an unsupported resource type (`email`) and a capture signed by another key.

### Not done

Signed undo and verification receipts (T16); configurable integration test suite in verification (R5.4); CLI with non-zero exit; container or volume restore (not claimed). Residual risk unchanged: authorized code runs as the operator's OS user.

---

## Run 11 — T16 signed, hash-chained receipts

| Field | Value |
|-------|-------|
| Date | 2026-11-17, exact time not recorded by the session |
| Kiro model | auto (the concrete model is not reported to the session) |
| Branch | `kiro/t16-receipts`, stacked on `kiro/t15-undo` (PR 5 and PR 6 still open, so not branched from `main`) |
| Commits / push | By Kiro on operator authorization; no merge |

### Written

- `src/receipts/chain.js`: per-mission JSONL chain with `seq`, `prev_hash`, Ed25519 signature, canonical-form check per line, signed head anchor in the operator key directory, refusal to extend a chain that does not verify.
- `src/receipts/policy.js`: ordering rules (authorization only after SAFE rehearsal of the same plan; one run per authorization and only of the authorized plan; undo only for a recorded run; verification directly after its undo).
- Receipts written by `rehearse`, `authorizeMission` (issued and refused), `runMission` (result and refused), `undoMission` (undo and verification). `runMission` now also refuses an authorization that has no matching `authorization_issued` receipt, and `authorizeMission` one whose report has no matching rehearsal receipt.
- `loadOrCreateKeys` returns the key directory with the keys; `undoMission` takes `keys` instead of `publicKey`.
- Tests: `test/receipts.test.js` (no Docker), Demo A and Demo B chain assertions.

### Verification (local, macOS)

- `npm test`: 194 pass, 0 fail. Includes a fast-check property that changes one random byte of a five-receipt chain file to a random other value 400 times; verification failed every time.
- Also covered: removed middle receipt (sequence gap and broken link), cut-off tail (head anchor), swapped receipts, a receipt copied from another chain, a chain re-signed with another key, a deleted chain, home path and e-mail redaction, and six ordering-rule violations.
- Demo A with real Docker: 8 pass, including R13.4 (the DATA LOSS rehearsal, the refusals with codes `DATA_LOSS`, `REPORT_INVALID`, `FIDELITY_MISMATCH`, and the single completed run are one chain that verifies and passes the ordering rules).
- Demo B with real Docker: 7 pass, 75.2 s. The chain reads rehearsal `SAFE`, authorization `allow`, run `failed` (steps `ok`, `failed`), undo, verification `PASS`, then the later undo and verification pairs including the `FAIL` ones from the failed-restore tests; it verifies and passes the ordering rules. 0 containers left afterwards.
- Note: the first combined Demo A + B run was killed when the terminal session running it dropped (not a test failure); it left one Demo B Compose project behind, which was removed by project name. Demo B was then rerun on its own under `nohup`.

### Not done

Hook decisions are not in the chain (unsigned audit lines; concurrent hook processes need a lock first). No pruning of `<db>_jrm_prev_<t>` databases (listed in ROADMAP as P2, explicit operator action only). Judge mode and CLI still to come.

---

## Run 12 — merge of PR 5, 6, 7; T16.1 signed hook decisions

| Field | Value |
|-------|-------|
| Date | 2026-11-17, exact time not recorded by the session |
| Kiro model | auto (the concrete model is not reported to the session) |
| Branch | `kiro/t16-1-hook-receipts` from `origin/main` at `9d78a55` |
| Merges | Done by Kiro on the operator's instruction "check and merge sequentially" |

### Merging the stacked pull requests

Before merging, all three were `MERGEABLE` / `CLEAN`, each branch contained the previous one, and `main` had not moved. Merge commits were used instead of squash: squashing 5 would have forced a history rewrite and force-push of 6 and 7. Order: merge 5, retarget 6 to `main`, merge 6, retarget 7, merge 7, each with `--match-head-commit` on the head that CI had tested. After each merge the tree of `main` was compared with the tree of the merged branch: identical each time (`8f44dac`, `9233a4d`, `b34d4c8`). Retargeting did not start new CI runs; because the trees are identical, the earlier green runs cover the merged content. CI on `main` at `9d78a55`: completed, success.

### T16.1 written

- `src/receipts/lock.js`: exclusive lock file per chain (O_EXCL), stale after 30 s, waits at most 8 s.
- `src/receipts/chain.js`: appends run under the lock; head anchor written by rename; kind `hook_decision`.
- Bug found by the new tests and fixed: the head anchor was keyed by mission id only, so two workspaces using the same mission id overwrote each other's anchor and failed verification. It is now keyed by mission id and the workspace real path.
- `src/receipts/policy.js`: hook decisions may sit between an undo and its verification.
- `src/receipts/keys.js`: `loadExistingKeys` (the hook never creates keys).
- `src/hook/run.js`: with an active contract, each decision is appended before it takes effect; failure to record means deny.

### Verification (local, macOS)

- `npm test`: 200 pass, 0 fail. New: decisions recorded as signed receipts without the tool input; 24 hook processes started at once (12 allowed reads, 12 denied shell calls) give exit codes as expected and one chain with seq 0 to 23 that verifies; a tampered chain makes the hook deny with `RECEIPT_FAILED`; a missing key gives `NO_OPERATOR_KEY` and no key is created; a held lock makes the hook wait about 8 s and deny without writing; two workspaces with one mission id keep separate anchors.
- Demo A and Demo B with real Docker after the change: 15 pass, 0 fail (Demo A 8, Demo B 7); 0 containers left; `git diff --check` clean.

### Not done

Counterfactual plan comparison (next), CLI with exit codes, judge mode. Pruning of `<db>_jrm_prev_<t>` stays an explicit operator action (ROADMAP, P2).
