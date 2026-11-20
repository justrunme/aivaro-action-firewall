# JustRunMe

**Rehearse. Run. Recover.**

JustRunMe rehearses Kiro agents’ proposed changes on a disposable copy, measures their impact, gates the real run, and verifies recovery with signed evidence.

> The agent says “Just run me.” JustRunMe says “Prove it first.”

![Flight Recorder showing a denied, repaired and verified mission](docs/img/console-flight-recorder.png)

“Zero” in the repository name means **zero unverified execution**, not zero risk.

## The problem

An agent can produce a plausible migration that silently deletes business data through a database trigger.
Code review may miss effects that exist only in the live database.
A successful command is not evidence that the result is safe or recoverable.

## What JustRunMe does

- **Rehearse:** run the proposed plan on a disposable database copy; measure lost rows, schema, database logic and file changes.
- **Check fidelity:** refuse a real run if the target, plan or relevant baseline differs from the rehearsal.
- **Require authorization:** bind an out-of-band operator approval to the selected plan and record its channel; a scripted approval is not proof of a human decision.
- **Run with evidence:** execute the rehearsed plan and compare its outcome with the measured expectation.
- **Recover and prove:** undo the captured database and files, verify recovery, and record signed, hash-linked receipts. Unverifiable checks never count as a pass.

## Try the judge demo

Requires **Node.js 24+**, **Docker** with a local daemon, and the demo's PostgreSQL image. From a fresh checkout:

```sh
npm ci
node src/cli/index.js judge --text
node src/cli/index.js console
```

The judge command uses throwaway demo resources: it rehearses a destructive plan, denies it, rehearses and runs a safe plan, undoes the run, verifies receipts offline and detects a tampered chain. It prints per-step PASS/FAIL evidence; the Docker integration test checks a 60-second budget with the image already cached. The Console prints a local, per-start token URL; open that URL to inspect recorded missions and the Flight Recorder. No production credentials are required for the judge demo. [Exact behavior and cleanup limits](docs/DETAILS.md#justrunme-judge).

## What is proven

| Capability | Evidence |
| --- | --- |
| Full automated suite: **571 passed, 0 failed, 0 skipped** on Node 24.22.3 | [Clean-tree test report](docs/test-report.json) (commit `5c21883`, not this README head) |
| Disposable rehearsal, approval, run and verified undo | [Demo integration tests](test/demo-judge.test.js) and [judge implementation](src/cli/index.js) |
| Real Kiro agent workflow and recorded limits | [Live session 1](docs/agent-runs/2026-11-20-live1.md), [live session 2](docs/agent-runs/2026-11-20-live2.md) |
| Hidden trigger experiment, including failed approaches | [T25 results](docs/agent-runs/T25-results-v1.md) |
| Logic-change detection | [Logic tests](test/logic.test.js) and [Postgres tests](test/demo-hidden.test.js) |
| Flight Recorder, approvals and recovery evidence | [Console tests](test/console-missions.test.js), [ProofDebt tests](test/proofdebt.test.js) |
| Gate activity measured in a Kiro session | [Gate session](docs/agent-runs/2026-11-20-gate.md) and [hook tests](test/gate.test.js) |
| Recovery rehearsal under a database crash | [Chaos integration test](test/demo-chaos.test.js) |

Read the [full technical evidence, assumptions and limitations](docs/DETAILS.md) before applying this to real data.

## Built with Kiro

The project uses [Kiro specifications](.kiro/specs/justrunme-zero/), [steering](.kiro/steering/), [agents](.kiro/agents/) and [hooks](.kiro/hooks/). A `PreToolUse` gate hook can check agent tool calls against the mission contract when `JUSTRUNME_GATE=on`; it is **inactive by default**. [Recorded Kiro CLI and IDE sessions](docs/agent-runs/) and the [Kiro work log](docs/KIRO_LOG.md) document what was actually tried and produced. The [real-agent reports](docs/agent-runs/2026-11-20-live2.md) distinguish measured results from agent claims.

Kiro already has permissions, hooks, an optional sandbox, checkpoints and “Approve for me.” JustRunMe adds measured rehearsal and verified database recovery; it does not replace those controls. Results depend on the recorded Kiro configuration and are not a general success rate.

## Chaos Twin Lite

`justrunme chaos` makes a disposable twin, applies a plan, kills the twin database and runs the same undo and verification path. It reports `RECOVERY PROVEN` only when real divergence was measured, recovery passed and cleanup succeeded; otherwise it reports a non-proven outcome. **This is not a sandbox:** shell steps run on the host as the operator's OS user and can target real resources. [Full test and threat-model details](docs/DETAILS.md).

## Honest limits

- **Do not rely on this repository to protect real data yet.** It is a research/demo implementation, not a production isolation boundary.
- Untrusted Kiro IDE workspaces may skip the hook (fail-open); the hook must be explicitly enabled and its actual session coverage checked. [Gate evidence](docs/agent-runs/2026-11-20-gate.md).
- Agent-authored SQL runs on a copy of real data; error and numeric output can leak information. Host-side shell steps are not isolated. [Security analysis](docs/DETAILS.md).
- A rehearsal cannot guarantee that SQL behaves identically against the real database. Post-run divergence is reported, not automatically undone.
- Undo covers named PostgreSQL data and captured/allowed files, not arbitrary network effects, emails, payments or all container volumes.
- Approval channels are recorded, but an environment variable or stdin can be used by scripts; a channel is not a person's identity.
- Docker integration is exercised in Linux CI; the Console's screen tests use a fake DOM, not a comprehensive browser/layout test.
- The test report is a point-in-time artifact, not proof that every future commit or host passes. [All remaining caveats](docs/DETAILS.md).

## CLI reference

`justrunme` is available through `node src/cli/index.js`; the workspace needs a mission contract and target configuration for real operations. The judge command creates its own disposable environment.

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

See [exit codes, operator-key handling, emergency recovery and complete command semantics](docs/DETAILS.md#cli).

## Architecture

A mission contract and target fingerprint feed a disposable rehearsal; the signed chain binds the measured plan, approval, execution and recovery receipts. The local Console reads the recorded evidence and offers explicit operator actions. [Architecture and threat model](docs/DETAILS.md).

## Development

```sh
npm ci
npm test
npm run test:demo
```

`npm run test:demo` requires Docker on Linux. [Engineering reference](docs/DETAILS.md) · [Kiro log](docs/KIRO_LOG.md).

## License and author

MIT. **Andrey Lesnikov** · [ORCID](https://orcid.org/0009-0004-7583-4314).
