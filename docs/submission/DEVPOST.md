# JustRunMe — Devpost draft (Kiroween, Frankenstein)

## Elevator pitch
An agent's migration quietly deletes orders. JustRunMe catches the loss in a disposable rehearsal, blocks the run, and verifies a safer result. Rehearse. Run. Recover.

## Inspiration
An agent can read a SQL migration, find no obvious `DELETE`, and approve it. But a trigger that lives only in the database can delete orders anyway. In a recorded Kiro-agent run, a migration that looked safe actually reduced `orders` from **3 rows to 2**. JustRunMe measured the loss before the real change and denied that plan. The agent revised its approach; the accepted run kept all 3 orders. [Evidence: recorded live run](../agent-runs/2026-11-20-live2.md).

We wanted a practical way to ask not just *what does the agent intend?* but *what happened when its exact plan was tried on a disposable copy?*

## What it does

JustRunMe fits into a Kiro agent workflow. It rehearses a proposed migration on a disposable PostgreSQL copy, measures row and schema changes, and checks database logic such as triggers. A plan that loses protected data is denied. The agent can revise and rehearse again. Before a real run, JustRunMe checks that the target and selected plan still match the rehearsal. The operator authorizes the selected plan separately; the receipt records the approval channel rather than pretending to identify a person. After execution, JustRunMe compares the result with the rehearsal. It can also restore captured database and workspace state and verify recovery.

A local Console shows the mission's Flight Recorder, impact differences, approvals and signed, hash-linked receipts. Chaos Twin Lite rehearses recovery in a disposable twin by applying changes, killing its database and checking the undo path. Neither the twin nor JustRunMe itself is a sandbox for untrusted host-side commands.

**Try the single-command demonstration** after installing dependencies, with Node.js 24+ and local Docker available:

```sh
npm ci
node src/cli/index.js judge --text
```

The judge command creates temporary demo resources, rehearses a destructive change and a safe alternative, runs and undoes the safe plan, verifies the receipt chain and detects tampering. It does not need your own server, production keys or database credentials. For a separate local evidence view, run `node src/cli/index.js console` and open the tokenized URL it prints.

## How we built it

Kiro was part of the development workflow, not a label added afterward. We used `.kiro/specs/justrunme-zero/` for requirements, design and tasks; `.kiro/steering/` for engineering and operator constraints; `.kiro/agents/` for specialized builder, operator and review configurations; and `.kiro/hooks/` for tool-use checks. The `PreToolUse` hook can deny commands that do not match the contract when `JUSTRUNME_GATE=on`; it is off unless explicitly enabled. Kiro CLI sessions exercised the actual rehearsal-and-repair loop, while Kiro IDE and gate checks were recorded separately with their limits. Session evidence and the work log live in `docs/agent-runs/` and `docs/KIRO_LOG.md`.

We stitched together the Kiro agent loop, an MCP server, a Node.js CLI, Docker Compose and PostgreSQL copies, an operator approval flow, database recovery, signed receipts and a local web Console. That combination is our Frankenstein entry: the pieces are familiar, but the result connects an agent's proposed action to a measured outcome and a verifiable recovery record.

## Challenges we ran into

The hidden-trigger test exposed a gap in our first definition of success. In a preregistered five-run treatment experiment, all five destructive first plans were caught, but **zero of five** completed the intended change while letting the trigger act: some revisions bypassed the trigger temporarily. We reported that limitation and added checks for persistent database logic changes; temporary bypasses and other database mechanisms remain important limitations. We also had to distinguish scripted approvals from human authorization, make missing recovery checks visible rather than counting them as successes, and ensure the judge demonstration cleans up its temporary resources.

## Accomplishments

- A recorded Kiro CLI run caught the hidden trigger's loss of **1 of 3 orders**, rejected a trigger-bypass attempt, and executed a revised plan that matched its rehearsal with all 3 orders retained.
- A clean-tree test report records **571 passed, 0 failed, 0 skipped** on Node.js 24.22.3 at the documented commit. This is a point-in-time result, not a claim about every machine or future commit.
- A reproducible `judge --text` flow exercises rehearsal, denial, safe execution, undo, receipt verification and tamper detection using throwaway resources.
- The Console makes the recorded decisions and gaps inspectable rather than presenting every step as successful.

## What we learned

Outcome checks are necessary but not sufficient: a plan can leave the database looking right while bypassing a business rule during execution. Rehearsal evidence must be tied to the exact baseline and plan, and the report must say when a check was unavailable. A receipt can establish what was recorded and signed; it cannot prove an untrusted shell command was harmless or that a scripted passphrase came from a person.

## What's next

Tighten coverage of temporary database-logic bypasses and other PostgreSQL mechanisms, reduce exposure of production data inside rehearsals, expand recovery and environment testing, and improve the judge onboarding path. This is a research/demo implementation: **do not rely on it to protect real production data yet**.

## Built with

Kiro CLI and IDE, Kiro specs/steering/agents/hooks, Node.js (24+), JavaScript, `@modelcontextprotocol/server`, `yaml`, `zod`, Docker Compose, PostgreSQL 16, Node's built-in HTTP server, Ed25519 signatures, and `fast-check` for development tests. The Console uses no front-end framework.

## Try it out

https://github.com/justrunme/justrunme-zero

<!--
Sources (internal; remove this section before pasting into Devpost):
- Pain, 3 -> 2 rows, trigger-bypass refusal, final 3/3 and recorded Kiro configuration: docs/agent-runs/2026-11-20-live2.md; test/live-evidence.test.js
- Preregistered five-run experiment and limitations: docs/agent-runs/T25-results-v1.md; docs/agent-runs/T25-preregistration.md
- Point-in-time 571/0/0 test result and exact commit: docs/test-report.json
- Judge behavior and prerequisites: src/cli/index.js; test/demo-judge.test.js; README.md
- Rehearsal, approval, recovery, Console and limitations: README.md; src/console/static/; test/console-missions.test.js; test/demo-chaos.test.js
- Kiro features and evidence: .kiro/specs/justrunme-zero/; .kiro/steering/; .kiro/agents/; .kiro/hooks/; docs/agent-runs/; docs/KIRO_LOG.md
- Dependencies: package.json; demo/docker-compose.yml
-->
