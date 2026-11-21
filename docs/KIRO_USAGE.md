# Kiro usage and evidence audit

JustRunMe uses Kiro for specification, implementation and live agent checks. This page counts **recorded entries**, not unique model calls, and does not infer authorship from a commit alone.

## Recorded evidence

- [Kiro session log](KIRO_LOG.md): **36 numbered Run headings** (1–5 and 7–37; Run 6 is not recorded). Several headings include multiple attempts or follow-up edits, so 36 is not a count of invocations.
- [Specification and task checkboxes](../.kiro/specs/justrunme-zero/tasks.md): requirements, design and task tracking.
- [Steering](../.kiro/steering/): **4 current files** (product, engineering, scope, operator loop).
- [Agents](../.kiro/agents/): **5 current definitions** (builder, skeptic, operator and two T25 roles).
- [Hooks](../.kiro/hooks/): **3 current definitions**, including the `PreToolUse` gate; it is inactive unless `JUSTRUNME_GATE=on`.
- [Recorded run reports](agent-runs/): **9 top-level Markdown files**, plus nested evidence directories. These are reports, not nine independent sessions.
- [Git history of the log](https://github.com/justrunme/justrunme-zero/commits/main/docs/KIRO_LOG.md): **37 commits touching the log** on `origin/main` at audit time. A commit touching the log is not evidence of a Kiro invocation.

## What was actually exercised

| Feature | Evidence and scope |
| --- | --- |
| Specs | [Run 3](KIRO_LOG.md#run-3--2026-11-16-2002-cet-berlin) and [task specification](../.kiro/specs/justrunme-zero/tasks.md) |
| Steering and custom agents | [Run 3](KIRO_LOG.md), [Run 4](KIRO_LOG.md), [current definitions](../.kiro/agents/) |
| Hooks and gate | [Run 8](KIRO_LOG.md), [gate session](agent-runs/2026-11-20-gate.md) |
| CLI agent run | [Live run 1](agent-runs/2026-11-20-live1.md), [live run 2](agent-runs/2026-11-20-live2.md) |
| IDE hook check | [IDE report](agent-runs/2026-11-20-ide.md): untrusted workspace did not execute the hook; trusted workspace did |
| Security probe | [Probe report](agent-runs/2026-11-20-probe.md): only the recorded tool attempts are covered |
| Measured data-loss experiment | [T25 version 1](agent-runs/T25-results-v1.md), [T25 version 2](agent-runs/T25-results-v2.md) |

## Audit qualifications

- **Run 6 has no heading.** It is *not recorded* under that number; do not invent a session.
- Several entries have no individual spec subtask IDs, model field or per-invocation time. Their aggregate descriptions are not evidence for every checked subtask.
- The current task file has **72 distinct checked subtask IDs** matching `T<number>[.<suffix>]`; **61** do not appear *literally* anywhere in the session log. Many are covered by parent-task references such as T11 or T12, so this is a **traceability gap**, not proof they were not implemented.
- Run 5 has no machine-readable date in its opening metadata; its narrative has dated work. Later entries sometimes document the date but not the time/model. Missing details remain *not recorded* rather than guessed.
- Git commits on `main` establish repository changes, **not who generated each line**. The log's claims about Kiro authorship are not independently provable from Git alone. Earlier closed/superseded branches are not silently counted as mainline work.
- The engineering reference may be under review on another branch; this audit uses only files on `origin/main`.

## Reproduce counts

```sh
grep -Ec '^## Run [0-9]+' docs/KIRO_LOG.md
find .kiro/steering -type f | wc -l
find .kiro/agents -type f | wc -l
find .kiro/hooks -type f | wc -l
find docs/agent-runs -maxdepth 1 -name '*.md' | wc -l
git log origin/main --format='%h' -- docs/KIRO_LOG.md | wc -l
```

For the checked-ID and literal-log-reference comparison, use the Python audit snippet documented in the PR description; counts above are from the same checked-out `origin/main` baseline.
