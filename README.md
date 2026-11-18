# JustRunMe

**Rehearse. Run. Recover.**
The mission simulator and undo engine for Kiro agents.

> AI says "Just run me." We say "Prove it first."

"Zero" means zero unverified execution. It does not mean zero risk.

## Status

Kiroween 2026 entry, work in progress. Nothing below is a claim of a working
feature until it has a passing end-to-end test.

| Area | State |
|------|-------|
| Spec, steering, agents, hooks (`.kiro/`) | Written |
| Demo app (Node + Postgres 16 + Docker Compose) | Written, integration test runs on Linux CI |
| Mission contract parser and PreToolUse hook | Implemented and tested; checked in a live Kiro CLI 3.3.0 session (blocked shell, protected files, inline interpreter; allowed reads and allowed-path writes). Kiro IDE not yet checked |
| Rehearsal, impact report, fidelity gate | Implemented for `sql_migration` and `shell` steps; Demo A (DATA LOSS blocked, safe replan runs, drift blocked) passes against real Docker and Postgres. No failing-test count yet |
| Signed run authorization | Implemented: signed by a separate approver Ed25519 key that is sealed at rest (scrypt + AES-256-GCM) and opened only by the CLI the human runs; bound to the fingerprint, single use. The operator key signs receipts, the approver key signs authorizations only |
| Approval of agent plans | Implemented and tested against real Postgres (test/demo-approval.test.js): the agent asks with `request_approval` for a SAFE plan that is still current (the workspace unchanged since its rehearsal, and the plan the fixed rule recommends); the operator reads the exact SQL and the measured impact (`justrunme approvals <id>`) and approves with the plan id typed again, or denies. A request is answered once, is bound to the report, the rehearsed base and the SQL file hashes, and expires after one hour at most; a file changed before approval cannot be approved, and a file changed after approval stops the run (the source fingerprint catches it; the authorization also carries the file hashes and the runner checks them again after the capture, a second check that no test reaches because the fingerprint refuses first). A migration file git ignores is not in the rehearsal copy, so it never rehearses SAFE. A used authorization put back is refused from the chain. The receipt records where the passphrase came from (`tty`, `stdin` or `env`). In the test the MCP server runs without the passphrase and the sealed key file is unreadable while the server works (not checked when the tests run as root) |
| Undo and recovery verification | Implemented for files under `allowed_paths`, contract config files and the named Postgres database; Demo B (failed real run, undo, verification of schema, row counts, checksums, files, images and `/health`, negative controls) passes against real Docker and Postgres. Containers and volumes are verified, not restored |
| Receipts (Ed25519, hash chain) | Implemented for rehearsal, authorization, run, undo, verification and every hook decision, with a head anchor outside the workspace and ordering rules; a one-byte change anywhere fails verification (property test); 24 parallel hook processes produce one gap-free chain (test) |
| Plan comparison (counterfactual replay) | Implemented as a library: stored rehearsals are compared only with equal `base_hash` (same source state and environment), equal rehearsal conditions, operator signatures and matching rehearsal receipts; a fixed rule picks the plan, names the deciding rule, and the choice is a signed `plan_selected` receipt. A replay checks that the choice follows from the signed measurements; it does not measure the database again. When several plans were rehearsed on the current state, only the selected one can be authorized; a selection made on another state grants nothing. Demo A compares its dangerous and safe plans against real Postgres. No `compare` CLI command yet |
| MCP server (`node src/mcp/server.js`, official SDK, stdio) | Implemented and tested against real Postgres: `rehearse`, `get_impact_report`, `compare`, `request_approval`, `run_mission`, `get_receipt`, `undo_mission`, `verify_recovery`, `replay_mission`. An agent proposes only SQL migration files inside the operator's mission; a denied plan comes back with the measured loss, the constraints a revision must meet and the next action; nothing here says a revision will be safe, only a new rehearsal does. `run_mission` runs only with the operator's approval and reports whether the real result matches the rehearsal (schema hash, row counts, checksums). No tool can approve |
| Plan history (`justrunme history`) | Implemented and tested: every rehearsal archives its signed report and SQL by content hash, and the report and its receipt name the SQL file hashes, so a plan edited and rehearsed again under the same id keeps both versions. `verify` fails (exit 30) when a version the chain names is missing or changed. `history` builds the story from the chain and checks four links: the approved version rehearsed SAFE, the authorization binds the requested files, the run used those files, and the run's measured result (now recorded in the signed `run_result`) equals the rehearsal. Deleting the archive is detected, not prevented; receipts from before this change are counted as legacy and not checked |
| Real Kiro agent (`justrunme-operator`) | One recorded run with Kiro CLI 3.4.0 and `JUSTRUNME_GATE=on` (docs/agent-runs/2026-11-18-run1.md): given a teammate's destructive migration, the agent rehearsed it (DENIED: 1 order row and a column lost), rewrote it as an additive view (SAFE), asked for approval and stopped; after approval it ran the plan and the result matched the rehearsal. Limits: the model saw the problem in the SQL before rehearsing, the approval was scripted, and one run is not a rate (evaluation is T25) |
| Judge mode (`justrunme judge`) | Implemented as a one-command demo: a throwaway Postgres 16 container, a throwaway operator key and workspace; a dangerous plan is rehearsed (rows lost measured), its authorization is denied, the safe plan is rehearsed on the same base, compared, authorized, run and undone, then the receipt chain is verified again with no Docker and an empty `PATH`, and a one-byte change to the chain must be detected. Prints a PASS/FAIL report with counts, per-step results and the signed receipts. The Docker test asserts under 60 s when the Postgres image is already on the machine (about 45 s on the author's Mac). Judge does not take a mission ID; `verify` and `replay` re-check any recorded mission |
| CLI (`justrunme`) | Implemented: JSON output, stable exit codes, every refusal named; the whole mission (rehearse, compare, authorize, run, undo, verify, replay) runs through the CLI against real Docker and Postgres in a test |
| Console (`justrunme console`) | Implemented and tested: a local page on 127.0.0.1 (`node:http`, no framework, no new dependency) with four screens. **Missions**: the pipeline PROPOSED → REHEARSED → DENIED → REVISED → SAFE → APPROVED → EXECUTED → VERIFIED and the Plan A / Plan B / approval / execution / verification story, each step backed by a checked link. **Impact Diff**: two archived versions side by side with protected rows lost, per-table row bars, schema delta and a SQL line diff; a banner when they were measured on different database states. **Approval Center**: the exact SQL, whether it changed since the request, the measured impact, the agent note marked as unverified, Approve (plan id typed again plus passphrase) and Deny (reason). **Recovery & Replay**: runs, Undo (capture id typed again), verification, replay and the receipt timeline. Every API call needs the per-start token and a Host naming this server; a POST also needs this server's Origin and a JSON body. Reads run only the CLI's read commands in process (an allowlist; the approve code is loaded with the CLI but never called there); approve, deny and undo run the CLI as a child, and the passphrase reaches `approve --passphrase-stdin` on stdin only. A Console approval is therefore recorded as `passphrase_source: stdin`, which names the channel, not the person: a script piping into `--passphrase-stdin` records the same. Limits: the passphrase passes through the Console process memory; anyone with the token and the passphrase can approve; no browser test (the HTTP API is tested, and the approve path against real Postgres on Linux) |
| Phone passkey approval (WebAuthn) | Deferred to P2 |

Limits that matter today:

- With the gate on, read tools are limited to the workspace, and no tool may name
  the key directory or a directory that contains it.
- The hook is inactive unless `JUSTRUNME_GATE=on` is set in the environment
  Kiro starts with. An agent cannot change that variable for the hook, but an
  operator who forgets it gets no protection.
- Undo covers only files under `allowed_paths`, the contract's config files
  and the named Postgres database. Anything else a run changes (other files,
  container volumes, network calls) is not restored.
- With the gate on, an operator key must be installed (`JUSTRUNME_HOME`,
  default `~/.justrunme`); otherwise every call is denied. Hook decisions are
  signed into the mission chain only while a valid contract exists. Denials
  without a contract are audit lines marked `unsigned_diagnostic`: they are
  diagnostics, not evidence.
- If an append is interrupted between the receipt and its anchor, the gate
  denies everything until the operator reviews the chain and reanchors it
  explicitly. The reanchor is itself recorded before the anchor moves; an
  interrupted reanchor stays denied until it is completed. A lock left by a
  crash whose owner cannot be determined is never removed automatically; the
  operator inspects it and removes it by its exact hash, which is recorded
  (`justrunme reanchor`, `justrunme lock inspect`, `justrunme lock recover`).
- The CLI is the operator's tool. With the gate on, the agent cannot run it:
  shell calls that were not rehearsed are denied, and a plan whose steps name
  JustRunMe on their command line is refused before rehearsal runs anything.
  Plan steps run without `JUSTRUNME_HOME` in their environment.
- **Security limit: JustRunMe is not a sandbox.** Plan steps (during rehearsal
  and the real run) execute as your OS user. A step or a script it calls can
  read the operator key directory, import JustRunMe code, or reach anything else
  your user can reach; nothing detects that. Signatures and receipts prove what
  was decided and recorded, not that rehearsed code was harmless. Run JustRunMe
  under a dedicated OS user or in a VM if plans come from an untrusted agent.
- Plans an agent proposes through the MCP server are rehearsed in a disposable
  database copy on an `internal` Docker network. Before any real data is loaded
  the engine asks Docker to confirm that every network of the copy is internal
  and refuses to continue otherwise, and a test reads the copy's routing table
  (no default route, against a non-isolated control). The SQL runs there as the
  database superuser and can run programs inside that container. What is not
  tested: a host service listening on the bridge address, IPv6, DNS, Docker
  Desktop behaviour; and the Compose file's own `include`, `env_file` or bind
  mounts are not examined.
- **Open: the rehearsal copy holds a dump of the real database and the agent
  writes the SQL that runs in it, so the agent has channels to read real data.**
  Error text reaches it (cut to the first line, 160 characters), and so do
  numbers (row counts of tables it creates, `content_changed`, the number of
  attempts). The names of objects the plan created are shown only if the plan's
  own SQL text contains them, which stops names built from data at run time but
  not the numeric channels. A masked or sampled copy would close this; it does
  not exist yet.
- A rehearsal cannot prove that agent-written SQL behaves the same on the real
  database: SQL can tell the copy from the real database (for example by its
  routing table) and act differently. The human who approves a run reads the SQL
  that will run (`justrunme approvals <id>`); nothing else binds the behaviour.
  After the run, `run_mission` compares the real database with the rehearsal's
  measurement and reports `COMPLETED_WITH_DIVERGENCE` when they differ; it does
  not undo by itself.
- The approver passphrase can come from `JUSTRUNME_APPROVER_PASSPHRASE` for
  automation (the judge demo and tests use it). Then the approval is a script's,
  not a person's: the CLI prints a notice and the authorization receipt records
  `passphrase_source: "env"`. Anyone who can read that variable can approve, so
  do not export it in the shell Kiro starts from. The approver key does not
  protect against your own OS user: a process running as you can read the sealed
  file and try passphrases (scrypt N=2^17 slows that down; it does not stop it).
- `approver.pub` is the key `run` and the hook trust. It is read-only and checked
  against the sealed key whenever the key is opened, but a process that can
  write `JUSTRUNME_HOME` could replace it between approvals; with the gate on the
  agent cannot write there. The chain records the approver public key of each
  authorization; `verify` does not yet check it against a pinned key.
- The agent can record a signed plan selection with `compare`; that steers which
  plan the operator is asked about and authorizes nothing.
- Each undo keeps the replaced database as `<db>_jrm_prev_<t>`. Nothing
  removes these yet; clean them up by hand until a pruning command exists.
- The environment identity in the fingerprint covers the Compose project, db
  service, name and user, the health probe and the Compose file hash: changing
  any of them after rehearsal blocks the run.

Do not rely on this repository to protect real data yet.

## CLI

`justrunme` (`node src/cli/index.js`) reads `justrunme.mission.yaml` and
`justrunme.target.json` from the workspace (`--repo`, default the current
directory) and the operator key from `JUSTRUNME_HOME`. It prints one JSON object
on stdout (`--text` for a plain listing) and never writes colour codes.

```
justrunme keys init                     # once; no other command creates a key
justrunme rehearse                      # 0 SAFE, 10 DATA LOSS, 11 FAILED
justrunme compare [plan_id ...]         # no ids: every plan rehearsed on the latest state
justrunme authorize                     # only the selected plan when several were rehearsed
justrunme run
justrunme undo <capture_id>
justrunme verify | replay | status | receipt [--seq n]
justrunme reanchor --reason "..." | lock inspect | lock recover --sha256 ... --reason "..."
justrunme judge [--text]                # the whole demo in one command; needs Docker
justrunme approver init                 # once; asks for a passphrase (12+ characters), twice at a terminal
justrunme approvals [request_id]        # requests of the mission; with an id: SQL, impact, state
justrunme approve <request_id> --confirm <plan_id>
justrunme deny <request_id> --reason "..."
justrunme history                       # versions, approvals, runs and the links between them
justrunme console [--port n]            # local Console; prints a URL with a per-start token
```

`authorize` and `approve` ask for the approver passphrase at the terminal
without echo; `--passphrase-stdin` or `JUSTRUNME_APPROVER_PASSPHRASE` are for
automation. `deny` needs no passphrase.

`justrunme.target.json` names the operator's Compose project:
`{"project", "compose_file", "db_service", "db_user", "db_name", "health"?}`.
The hook protects it like the contract.

| Exit | Meaning |
|------|---------|
| 0 | done; `rehearse`: SAFE |
| 1 | internal error |
| 2 | usage error |
| 3 | contract, target or operator key missing or invalid |
| 10 | `rehearse`: DATA LOSS |
| 11 | `rehearse`: a step failed or the copy did not start |
| 12 | `compare`: no plan survived the rule |
| 13 | `run`: a step failed; undo with the printed `capture_id` |
| 14 | `undo`: not RECOVERED |
| 15 | `run`: completed, but steps that need approval were skipped |
| 16 | `rehearse`: the copy was not fully removed (it holds a dump of the real database) |
| 17 | `undo --emergency-recovery`: restored and verified, but `evidence_status: "unverified"` (never 0) |
| 20 | `compare` refused |
| 21 | `authorize` refused |
| 22 | `run` refused |
| 23 | `undo` refused |
| 24 | `reanchor` or `lock recover` refused |
| 25 | `rehearse` refused before running anything |
| 26 | `approvals` / `approve` / `deny` refused (`REQUEST_APPROVED`, `REQUEST_DENIED`, `REQUEST_EXPIRED`, `FILES_CHANGED`, `PLAN_CHANGED`, `NOT_SAFE`, ...) |
| 30 | `verify` / `replay` / `status`: chain, policy or selection does not check out; or a command did its work but could not record it (`RESULT_UNRECORDED`, result included) |
| 31 | the receipt chain lock is held or stuck (`justrunme lock inspect`) |
| 40 | `judge`: a step did not match, or the 60 s budget was exceeded |
| 41 | `judge`: Docker is not available or the demo database could not be prepared |

Break-glass recovery. A normal `undo` refuses to restore when the receipt chain
does not verify. If the chain is damaged and production must be restored anyway:

```
justrunme undo <capture_id> --emergency-recovery --reason "<why>" --confirm <capture_id>
```

It is refused while the chain still verifies (`EMERGENCY_NOT_NEEDED`) and for a
capture that is not operator-signed. It restores, always runs the recovery
verification, never touches or repairs the chain, and records a signed,
hash-linked entry with `evidence_status: "unverified"` in a separate journal
under `JUSTRUNME_HOME/emergency/`. Exit 17 even when everything was restored.

### `justrunme judge`

```
node src/cli/index.js judge --text
```

It uses none of your workspace or keys: its own temporary workspace, operator key
and Compose project (`jrm-judge-<id>`), the demo's `postgres:16.3-alpine` image
with the demo-only credentials. Every child process gets only `PATH`, `HOME`,
`TMPDIR`, `LANG` and the `DOCKER_*` settings (the Docker client needs them), a
throwaway `JUSTRUNME_HOME`, and git settings that ignore your git configuration;
database and cloud credentials in your shell are not passed on (a test sets
canary values and checks the output). The Docker daemon is resolved once through
the Docker CLI (so `DOCKER_HOST`, `DOCKER_CONTEXT` and the configured context all
count); anything but a local socket is refused, and every docker process of the
judge then runs with that one socket as `DOCKER_HOST` and no `DOCKER_CONTEXT`. A
local socket that is itself forwarded to another machine cannot be told apart. It takes
no `--repo` or `--mission`, and a test checks that it creates nothing in a
`JUSTRUNME_HOME` you set or in `~/.justrunme`.

At the end, on failure, and on Ctrl-C or SIGTERM it removes the stack and the
rehearsal copies' containers, volumes and networks and its own temporary
directories (a test interrupts a run during a rehearsal and checks this). One
leftover is possible when the run is interrupted mid-rehearsal: the rehearsal's
temporary workspace directory `jrm-rehearsal-*` in the system temp directory.

The 60 s budget covers setup and teardown and is judged only when the image was
already on the machine; the first run that downloads it is timed and reported
(`budget_enforced: false`) but not judged. Undo covers the Postgres database named
in the contract and tracked files; nothing else. JustRunMe is not a sandbox.

Every non-zero exit carries `error.code` (for example `COMPARISON_REQUIRED`,
`PLAN_NOT_SELECTED`, `FIDELITY_MISMATCH`, `BASE_MISMATCH`) in the JSON output.

## What it will do

1. **Rehearse.** Run the agent's plan in a git worktree and a disposable
   Docker Compose copy of the app and Postgres. Report measured impact: file
   diff, failing tests, schema and row changes, and a verdict of `SAFE` or
   `DATA LOSS`.
2. **Run.** Execute only the rehearsed plan. Before the real run, the source
   state is fingerprinted again; any difference blocks the run. During the run,
   a Kiro `PreToolUse` hook (active when `JUSTRUNME_GATE=on`) allows only
   actions that match the rehearsed plan.
3. **Recover.** Capture workspace files, a `pg_dump` and container state
   before the run. One command restores them, then a verification pass checks
   row counts, checksums, schema and `/health`. Any mismatch fails loudly.

Undo covers only: tracked git files, Postgres databases named in the contract,
Docker Compose services, and config files listed in the contract. Network
calls, email, payments and other external effects cannot be undone. They are
flagged as irreversible and need out-of-band approval.

## Acceptance scenarios

- **Demo A.** A dangerous migration is rehearsed, the report says `DATA LOSS`,
  the run is blocked, and the agent replans to a safe migration that rehearses
  as `SAFE`.
- **Demo B.** An intentional failure in a controlled test environment is
  undone, and recovery verification passes on rows, checksums, schema and
  `/health`.

Full criteria are in `.kiro/specs/justrunme-zero/requirements.md` (R13, R14).

## How this relates to Kiro's own features

Kiro has permissions, `PreToolUse` hooks, an optional sandbox, checkpoints and
"Approve for me". Those decide whether a tool call runs, or revert files edited
by Kiro's own file tools. JustRunMe adds a measured rehearsal before the run
and recovery for state those mechanisms do not track, such as Postgres data. It
layers on top of Kiro and replaces none of it. Comparisons will cite Kiro
documentation.

## Development

Requires Node.js 24 or newer.

```sh
npm install
npm test            # all tests under test/
npm run test:demo   # demo integration test (Linux with Docker only)
```

The demo's database credentials are demo-only and live in `demo/.env.example`
and `demo/docker-compose.yml`.

Kiro sessions that wrote this repository are logged in `docs/KIRO_LOG.md`.
Kiro never commits or pushes here.

## License

MIT
