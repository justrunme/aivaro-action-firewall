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
| Signed run authorization | Implemented: operator Ed25519 key outside the workspace, bound to the fingerprint, single use |
| Undo and recovery verification | Implemented for files under `allowed_paths`, contract config files and the named Postgres database; Demo B (failed real run, undo, verification of schema, row counts, checksums, files, images and `/health`, negative controls) passes against real Docker and Postgres. Containers and volumes are verified, not restored |
| Receipts (Ed25519, hash chain) | Implemented for rehearsal, authorization, run, undo, verification and every hook decision, with a head anchor outside the workspace and ordering rules; a one-byte change anywhere fails verification (property test); 24 parallel hook processes produce one gap-free chain (test) |
| Plan comparison (counterfactual replay) | Implemented as a library: stored rehearsals are compared only with equal `base_hash` (same source state and environment), equal rehearsal conditions, operator signatures and matching rehearsal receipts; a fixed rule picks the plan, names the deciding rule, and the choice is a signed `plan_selected` receipt. A replay checks that the choice follows from the signed measurements; it does not measure the database again. When several plans were rehearsed on the current state, only the selected one can be authorized; a selection made on another state grants nothing. Demo A compares its dangerous and safe plans against real Postgres. No `compare` CLI command yet |
| MCP server (`node src/mcp/server.js`, official SDK, stdio) | In progress. Implemented and tested against real Postgres: `rehearse`, `get_impact_report`, `compare`, `get_receipt`, `replay_mission`. An agent proposes only SQL migration files inside the operator's mission; a denied plan comes back with the measured loss, the constraints a revision must meet and the next action; nothing here says a revision will be safe, only a new rehearsal does. Not yet: `request_approval`, `run_mission`, `undo_mission`, `verify_recovery`, the approver key, the `justrunme-operator` agent, a run with a real Kiro agent |
| Judge mode (`justrunme judge`) | Implemented as a one-command demo: a throwaway Postgres 16 container, a throwaway operator key and workspace; a dangerous plan is rehearsed (rows lost measured), its authorization is denied, the safe plan is rehearsed on the same base, compared, authorized, run and undone, then the receipt chain is verified again with no Docker and an empty `PATH`, and a one-byte change to the chain must be detected. Prints a PASS/FAIL report with counts, per-step results and the signed receipts. The Docker test asserts under 60 s when the Postgres image is already on the machine (about 45 s on the author's Mac). Judge does not take a mission ID; `verify` and `replay` re-check any recorded mission |
| CLI (`justrunme`) | Implemented: JSON output, stable exit codes, every refusal named; the whole mission (rehearse, compare, authorize, run, undo, verify, replay) runs through the CLI against real Docker and Postgres in a test |
| Console UI | Not implemented |
| Phone passkey approval (WebAuthn) | Deferred to P2 |

Limits that matter today:

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
  database copy that has no network route (an `internal` Compose network; a test
  reads the copy's routing table). The SQL runs there as the database superuser
  and can run programs inside that container, nothing outside it. The copy holds
  a dump of the real database, and SQL error text (three lines, 300 characters)
  is returned to the agent, so an agent can read small amounts of real data
  through error messages. A masked or sampled copy would close that; it does not
  exist yet. The agent can also record a signed plan selection with `compare`;
  that steers which plan the operator is asked about and authorizes nothing.
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
```

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
