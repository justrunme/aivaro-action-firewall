# Console readability check — 2026-11-21

**Scope:** current `origin/main`, JustRunMe Console at **1280 × 720 CSS px**; the shipped **Recorded run** source, not a live agent execution. No code or data was changed. This check covers the screens used in the current video shot list, not a full accessibility audit or actual 1080p video export.

## Exact setup and checks

```sh
cd ~/aivaro-work/justrunme-zero
git fetch origin
git switch -c fix/console-readability origin/main
node --version  # v26.13.1 (supported: Node 24+)
node src/cli/index.js console --port 8765
```

Open the tokenized URL printed by the Console **in a fresh browser tab** (do not share or record the token), select **Recorded run** on Home, and set the viewport to **1280 × 720**. Navigate to the hash routes in the table. In the connected browser, each route was visited, the main content and navigation were inspected, and `document.documentElement.scrollWidth > innerWidth` was checked for horizontal overflow. All nine routes returned **false**. The browser's console showed **zero new errors or warnings** after authenticating with the current token.

| Route / shot | Observed at 1280 × 720 | Status and navigation assessment |
| --- | --- | --- |
| `#/missions/mission-t25v2-a/rehearsed` | Flight Recorder, `DATA LOSS DETECTED`, **orders 3 → 2**, SQL panel and trigger evidence; no horizontal page overflow | Correctly distinguishes dangerous rehearsal from executed SAFE run. Back link and Flight nodes present. |
| `#/missions/mission-t25v2-a/denied` | `LOGIC BYPASS DETECTED`, blocked execution, explanation and SQL | Not green; explicitly says nothing reached the real database. |
| `#/missions/mission-t25v2-a/repaired` | `SAFE · MEASURED`, orders **3 → 3**, SQL side-by-side diff | Measured safety is about this revised plan; not a blanket guarantee. No page overflow. |
| `#/missions/mission-t25v2-a/approved` | Approved node and signed chain context; code panel | Explicitly says operator approved this version. No broken navigation observed. |
| `#/missions/mission-t25v2-a/executed` | `completed`, `AS REHEARSED`, signed receipt details | Result is tied to this recorded mission. No horizontal overflow. |
| `#/missions/mission-demo-b` | `RECOVERED · CHECKS UNKNOWN` | **Important:** the legacy recovery check says PASS but does not enumerate which checks ran. The UNKNOWN qualifier is visible; do not crop it from video. |
| `#/recovery` | Recovery/undo, chain verification and explanation of legacy check coverage | Does not claim database privileges were verified in the older receipt. |
| `#/missions/mission-demo-b/verified` | `RECOVERED · CHECKS UNKNOWN`, signed run result | No false green claim of complete recovery coverage. |
| `#/evidence` | `Gate Health · PreToolUse hook: UNKNOWN`, verified receipts and proof debt | Explicitly says UNKNOWN **does not mean commands are blocked**. No page overflow. |

**Readability:** no horizontal page overflow at 1280 × 720 and no text under 12 CSS px found in the sampled Safety Evidence screen. This is a DOM/layout inspection, **not** a claim that all text is legible in the final compressed recording; visually review the actual export at normal playback size. Long SQL panels scroll within the screen; do not try to display all lines at once.

## Authentication caveat observed during the check

A reused browser tab initially held a **stale sessionStorage token** from a prior Console process. It displayed previously loaded data but a new receipt fetch returned **401 Unauthorized**, with “The receipt could not be read; no trigger is shown.” This was **not** a code defect: reloading the URL printed by the current Console process updated the token, `GET /api/missions?source=recorded` returned **200**, and a fresh route pass had **zero** new console errors. Always use the latest tokenized URL and reload the tab when changing Console processes; never show a stale-tab 401 in the video as a missing trigger.

## Result and limitations

No reproducible misleading status, broken navigation, or horizontal overflow was found **after correct authentication**. No `src/` change or Kiro CLI invocation was needed; no tests were skipped or weakened. This does not prove keyboard navigation, color contrast ratios, small-screen responsiveness, full screen-reader behavior, or that the final video will be legible. The recording operator must confirm at actual output resolution, avoid cropping the `Recorded run` provenance and `CHECKS UNKNOWN`, and keep any Console token out of captured footage.
