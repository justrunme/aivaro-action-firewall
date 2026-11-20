# JustRunMe — Kiroween demo video (target 1:30)

**Format:** screen recording, English voice-over, no invented live-agent action. The two missions below are a **signed, read-only recorded export**, not a live Kiro session. Use a short cut to a second mission for recovery; do not splice the two together as if they were one run. Total planned duration: **1:32**, safely below 2:00. Start on the destructive rehearsal result, not on a terminal or architecture diagram.

## Timeline and shot list

| Time | On screen (exact screen / action) | Narration (spoken English) | Sources |
| --- | --- | --- | --- |
| 0:00–0:08 | Console, recorded source, `#/missions/mission-t25v2-a/rehearsed`; zoom in on **DATA LOSS**, then the SQL and row impact. Add a plain on-screen title: “An agent migration can delete an order.” | “This migration looks harmless. But a hidden database trigger deletes an order. JustRunMe catches it before the real run.” | `demo/recorded-run/manifest.json` (`mission-t25v2-a`), `src/console/static/screens.js` (Flight Recorder route) |
| 0:08–0:20 | Same mission: `#/missions/mission-t25v2-a/denied`, then `#/missions/mission-t25v2-a/repaired`. Show the denied trigger-bypass attempt and the repaired plan. | “The first plan loses data. A second plan tries to bypass the trigger and is denied too. The revised plan keeps the orders and rehearses SAFE.” | `demo/recorded-run/manifest.json`; `docs/agent-runs/T25-results-v2.md`; `src/console/static/screens.js` |
| 0:20–0:30 | `#/missions/mission-t25v2-a/approved`, then `#/missions/mission-t25v2-a/executed`. Keep the recorded-source banner visible. | “A person approved the final plan in the Console. The recorded execution matched the rehearsal. Approval is separate from the agent.” | `demo/recorded-run/manifest.json` (human Console approval and scripted replay provenance); `src/console/static/screens.js` |
| 0:30–0:41 | Switch to the **different** recorded mission `#/missions/mission-demo-b`; open `#/recovery`. Show the undo result and recovery verification. Add “Separate recovery example” on screen. | “In this separate demo, a safe migration runs, then undo restores the captured state. Recovery checks compare rows, checksums, schema and files.” | `demo/recorded-run/manifest.json` (`mission-demo-b`, including missing legacy grant coverage); `src/console/static/screens.js` |
| 0:41–0:51 | `#/missions/mission-demo-b/verified`, then `#/recovery` receipt chain. Highlight signature state and a receipt hash. | “The Flight Recorder shows what happened. Signed receipts let us verify the recorded sequence, including recovery.” | `demo/recorded-run/manifest.json`; `src/console/static/screens.js`; `test/live-evidence.test.js` |
| 0:51–1:04 | Terminal, from repo root: `node src/cli/index.js judge --text`. Show the resulting PASS/FAIL report **only after the command actually finishes**. If it fails, show the failure or cut this shot; never overlay a fake PASS. | “You can try the whole safety loop with one command. It uses a throwaway database and key, and checks that a tampered receipt chain is detected.” | `src/cli/index.js` (judge command); `test/demo-judge.test.js`; `README.md` |
| 1:04–1:18 | Repo tree: `.kiro/specs/justrunme-zero/`, `.kiro/steering/`, `.kiro/hooks/pretooluse.json`, `docs/KIRO_LOG.md`; briefly show the hook configuration. | “Kiro helped build this through specs, steering, agents and hooks. The PreToolUse gate checks tool calls when explicitly enabled. Kiro's existing controls still matter.” | `.kiro/specs/justrunme-zero/tasks.md`; `.kiro/steering/`; `.kiro/hooks/pretooluse.json`; `docs/KIRO_LOG.md` |
| 1:18–1:32 | Return to `#/missions/mission-t25v2-a`; show **DATA LOSS → SAFE** contrast and end on the product name. | “It is not a sandbox, and it does not undo external effects. But it makes the database impact visible before execution. JustRunMe. Rehearse. Run. Recover.” | `demo/recorded-run/manifest.json`; `README.md` and its security limits |

## Recording setup

1. In a clean terminal at the repo root, check `node --version` (Node 24 or newer) and `docker info` (Docker running, local daemon). Have the `postgres:16.3-alpine` image cached if timing the judge command; the first pull can take longer. Do not imply the recorded Console needs Docker: the signed export is read-only.
2. Run `node src/cli/index.js console --port 8765` on an **available** port. Use the tokenized URL printed by the command; never paste or publish that token in the video. Open the Console and select the **Recorded run** source, not Live. The shipped export is `demo/recorded-run` by default.
3. Navigate via the Console to `#/missions/mission-t25v2-a` and `#/missions/mission-demo-b`. Verify that the node links and Recovery screen display before recording. Browser route fragments work after the token has been consumed by the app. Do not type a bare route into a new unauthenticated tab.
4. Prepare the first frame **already on the DATA LOSS result**. Set browser zoom around 110–125%, terminal font around 18–22 pt, hide personal tabs, notifications, and environment variables. Record at 1080p if possible. Use cuts rather than waiting through Docker startup.
5. Separately run `node src/cli/index.js judge --text` before recording to confirm it works on this machine. The command creates temporary resources and cleans up, but inspect its actual exit status. If Docker is unavailable, keep the recorded Console walkthrough and describe the command without pretending it ran successfully.
6. Capture the recorded-source banner in the first shot and label the second mission as a separate example. After recording, stop Console with Ctrl+C; confirm no new demo containers remain from your judge run.

## Claims to avoid

- Do **not** call the recorded SQL sequence a live Kiro-agent run. The manifest explicitly says the T25 v3 plans were replayed by a script, and the second mission is a fixed demo migration.
- Do **not** say the approval in `mission-demo-b` was human; it was scripted via CLI. The human Console approval belongs to `mission-t25v2-a`.
- Do **not** claim the two missions are one end-to-end execution/undo. The recovery demonstration is separate.
- Do **not** say the legacy recovery verified database grants; that capture predates privilege coverage.
- Do **not** claim JustRunMe sandboxes untrusted host shell steps, prevents all leaks, guarantees identical behavior on production, or reverses external effects.
- Do **not** say Kiro lacks hooks, permissions, a sandbox or checkpoints. The gate is inactive unless `JUSTRUNME_GATE=on`; an untrusted IDE workspace can skip it.
- Do **not** claim a universal success rate or zero risk. No invented performance, recovery time, blocked-call count or test count is needed for this video.

## Reproducibility and editing notes

The first ten seconds must show the bad action's **measured impact**, not a static title card. Keep one narrow scenario: the hidden trigger on the sold-out patch. If the spoken lines exceed their windows, shorten narration rather than speeding up footage. The judge command is a **separate live demonstration** and should be visibly distinguishable from the recorded Console export. No video is uploaded or submitted by this task.
