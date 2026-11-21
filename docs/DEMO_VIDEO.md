# JustRunMe — Kiroween demo video (target 1:35)

**Format:** screen recording, English voice-over, no invented live-agent action. The Console missions are a **signed, read-only recorded export**, not a live Kiro session. The separate Chaos Twin evidence is a recorded local run from 2026-11-20, not part of that export. Do not splice these examples together as if they were one run. Total planned duration: **1:36**, below the official **3-minute limit** ([Kiroween Rules §4](https://kiroween.devpost.com/rules)). Start on the destructive rehearsal result, not on a terminal or architecture diagram.

## Timeline and shot list

| Time | On screen (exact screen / action) | Narration (spoken English) | Sources |
| --- | --- | --- | --- |
| 0:00–0:10 | Recorded Console `#/missions/mission-t25v2-a/rehearsed`: show **DATA LOSS**, the hidden trigger and the measured **3 → 2 orders**. Label **RECORDED EXPORT**. | “A migration silently deletes one of three orders. JustRunMe shows the loss before execution.” | `docs/agent-runs/T25-results-v1.md`; `demo/recorded-run/manifest.json` |
| 0:10–0:23 | Same recorded mission: denied bypass, then repaired **SAFE** rehearsal. | “The unsafe plan is denied. The repaired plan preserves the orders.” | `demo/recorded-run/manifest.json`; `docs/agent-runs/T25-results-v2.md` |
| 0:23–0:32 | Recorded human approval and matching execution in `mission-t25v2-a`. Keep the recorded banner. | “The operator approves the verified plan, then the recorded run matches rehearsal.” | `demo/recorded-run/manifest.json` |
| 0:32–0:40 | Separate `mission-demo-b` recovery and receipt chain. Label **SEPARATE RECORDED EXAMPLE**; if `#/recovery` shows **CHECKS UNKNOWN** for the old report, show that label honestly, not a green substitute. | “This older recovery example has limited verification coverage; the receipt records exactly what was checked.” | `demo/recorded-run/manifest.json`; `src/console/static/screens.js` |
| 0:40–0:54 | Terminal: `node src/cli/index.js judge --text` from repo root, **after `npm ci` on a fresh clone**. Show the start, then a **real completed** result using a visible cut labeled **“edited for time — actual run ~38 s”**. Never fabricate PASS. | “You can run the judge check yourself with Node 24 and a local Docker daemon.” | `src/cli/index.js`; `test/demo-judge.test.js`; `docs/submission/RECORDING_RUNBOOK.md` in [PR #37](https://github.com/justrunme/justrunme-zero/pull/37) (not necessarily on main; measured 38.4 and 37.5 seconds) |
| 0:54–1:08 | Show the **recorded** Kiro CLI transcript denying `rm -rf demo/migrations` with `JUSTRUNME_GATE=on`; label **RECORDED KIRO RUN**. | “A real recorded Kiro hook invocation stopped a destructive command before execution.” | `docs/agent-runs/2026-11-20-live1.md`; `.kiro/hooks/pretooluse.json` |
| 1:08–1:26 | **NEW — RECORDED CHAOS TWIN RUN (2026-11-20)**. Capture the existing `~/aivaro-work/console-d1/chaos-live/chaos.json` and `verify.json` outputs, or a screen recording of those files; clearly label **RECORDED, NOT LIVE**. Show `SIGKILL` after step 2 → undo `RECOVERED` → verification **RECOVERY PROVEN**, **21 checks / 0 failed**, verified receipt chain, **cleanup.clean=true** and **0 leftover containers/volumes/networks**. Do not present a staged rerun as the recorded event. | “In a separate recorded Chaos Twin run, we kill the database container, undo the changes, and verify recovery: twenty-one checks, none failed. The signed receipt chain verifies, and cleanup leaves no twin resources.” | Local, **not committed** evidence: `~/aivaro-work/console-d1/chaos-live/chaos.json` (`fault.crash`, `undo.verification`, `cleanup`) and `verify.json` (`ok=true`, `chain_findings=[]`), recorded **2026-11-20**. These files must remain intact; do not imply the viewer can find them in Git. |
| 1:26–1:36 | Return to recorded **DATA LOSS → SAFE** and end on **JustRunMe — Rehearse. Run. Recover.** | “Rehearse the impact. Run only what you verified. Recover with evidence.” | `demo/recorded-run/manifest.json`; `README.md` |


## Recording setup

1. In a clean terminal at the repo root, check `node --version` (Node 24 or newer) and `docker info` (Docker running, local daemon). Have the `postgres:16.3-alpine` image cached if timing the judge command; the first pull can take longer. Do not imply the recorded Console needs Docker: the signed export is read-only.
2. Run `node src/cli/index.js console --port 8765` on an **available** port. Use the tokenized URL printed by the command; never paste or publish that token in the video. Open the Console and select the **Recorded run** source, not Live. The shipped export is `demo/recorded-run` by default.
3. Navigate via the Console to `#/missions/mission-t25v2-a` and `#/missions/mission-demo-b`. Verify that the node links and Recovery screen display before recording. Browser route fragments work after the token has been consumed by the app. Do not type a bare route into a new unauthenticated tab.
4. Prepare the first frame **already on the DATA LOSS result**. Set browser zoom around 110–125%, terminal font around 18–22 pt, hide personal tabs, notifications, and environment variables. Record at 1080p if possible. Use cuts rather than waiting through Docker startup.
5. On a fresh clone, run `npm ci` before the Console or judge. Separately run `node src/cli/index.js judge --text` before recording to confirm it works on this machine. The command creates temporary resources and cleans up, but inspect its actual exit status. If Docker is unavailable, keep the recorded Console walkthrough and describe the command without pretending it ran successfully.
6. The Chaos Twin shot is **recorded evidence from 2026-11-20**, stored only in `~/aivaro-work/console-d1/chaos-live/`; verify `chaos.json` and `verify.json` still match before capturing. Do not copy, modify or delete the evidence directory. Chaos Twin steps run with the OS user’s rights; **it is not a sandbox for untrusted shell**. The reported health check was **not configured**, and the twin tested the database only, not external effects.
7. Capture the recorded-source banner in the first shot and label the second mission as a separate example. After recording, stop Console with Ctrl+C; confirm no new demo containers remain from your judge run.

## Claims to avoid

- Do **not** call the recorded SQL sequence a live Kiro-agent run. The manifest explicitly says the T25 v3 plans were replayed by a script, and the second mission is a fixed demo migration.
- Do **not** say the approval in `mission-demo-b` was human; it was scripted via CLI. The human Console approval belongs to `mission-t25v2-a`.
- Do **not** claim the two missions are one end-to-end execution/undo. The recovery demonstration is separate.
- Do **not** say the legacy recovery verified database grants; that capture predates privilege coverage.
- Do **not** claim JustRunMe sandboxes untrusted host shell steps, prevents all leaks, guarantees identical behavior on production, or reverses external effects.
- Do **not** say Kiro lacks hooks, permissions, a sandbox or checkpoints. The gate is inactive unless `JUSTRUNME_GATE=on`; an untrusted IDE workspace can skip it.
- Do **not** claim a universal success rate or zero risk. Use only the cited one-of-three order loss as the spoken hard number; do not invent performance, recovery times, blocked-call counts or test counts.

## Reproducibility and editing notes

The first ten seconds must show the bad action's **measured impact**, not a static title card. Keep one narrow scenario: the hidden trigger on the sold-out patch. If the spoken lines exceed their windows, shorten narration rather than speeding up footage. The judge shot is visibly cut with the real ~38-second duration disclosed; do not misrepresent a 14-second clip as a 14-second run. The recorded Kiro hook transcript is **not a live reenactment**. The judge command is a **separate live demonstration** and should be visibly distinguishable from the recorded Console export. No video is uploaded or submitted by this task.
