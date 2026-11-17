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
| MCP server, Kiro Power, `justrunme-operator` agent | Not implemented |
| Judge mode (one command, under 60 s) | Not implemented (T19) |
| Console UI | Not implemented (T18, after Demo A and B work) |
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
  operator inspects it and removes it by its exact hash, which is recorded.
  There is no CLI for these yet; they are library calls (`reanchorChain`,
  `inspectChainLock`, `recoverLock`).
- Each undo keeps the replaced database as `<db>_jrm_prev_<t>`. Nothing
  removes these yet; clean them up by hand until a pruning command exists.
- Rehearsed and authorized code runs as your OS user. JustRunMe binds and
  checks what runs; it does not sandbox it.

Do not rely on this repository to protect real data yet.

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
