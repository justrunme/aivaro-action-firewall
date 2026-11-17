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
| Mission contract and PreToolUse hook | Not implemented (T13) |
| Rehearsal, impact report, fidelity gate | Not implemented (T14) |
| Undo and recovery verification | Not implemented (T15) |
| Receipts (Ed25519, hash chain) | Not implemented (T16) |
| MCP server, Kiro Power, `justrunme-operator` agent | Not implemented (T17) |
| Judge mode (one command, under 60 s) | Not implemented (T19) |
| Console UI | Not implemented (T18, after Demo A and B work) |
| Phone passkey approval (WebAuthn) | Deferred to P2 |

The requirements describe intended behavior. No enforcement mechanism exists
yet, so nothing in this repository currently stops a dangerous action.

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
