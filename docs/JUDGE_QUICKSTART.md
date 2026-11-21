# Fresh-clone judge quickstart (Mac, 21 November 2026)

This is a recorded fresh-checkout test of **origin/main at `de256225e4936ad38955c7cbd0b9eb917ce20ea6`**, not a claim that every host or Node version works. The checkout was newly cloned into `/tmp/jrm-judge-refresh-87xMgm` (resolved by macOS to `/private/tmp/jrm-judge-refresh-87xMgm`). It was not the development checkout.

## Prerequisites observed

- macOS arm64; Node.js **v26.13.1**, npm **11.20.0**; Docker CLI and daemon **28.4.0**.
- Docker Desktop/daemon was running and the `postgres:16.3-alpine` image was already available as `linux/arm64`.
- `DOCKER_DEFAULT_PLATFORM` was **unset**; no platform workaround was needed.
- Node 26 is newer than the README's Node 24 minimum, and the full suite passed on Node 26. Node 24.22.3 was also tested separately using npx.

## Exact fresh-checkout path

| Step / command | Result | Wall time / evidence |
| --- | --- | --- |
| `git clone --branch main --single-branch https://github.com/justrunme/justrunme-zero.git /tmp/jrm-judge-refresh-87xMgm` | Exit 0, commit `de25622` | Fresh /tmp folder (path has no spaces) |
| `git config user.name "Andrey Lesnikov"` and `git config user.email "52860508+justrunme@users.noreply.github.com"` inside the clone | Exit 0 | Repo-local identity only |
| `npm install` | Exit 0; 6 packages installed, 0 vulnerabilities reported | **1 s** |
| `npm test` (Node 26.13.1) | **Exit 0**; 573 tests, 573 pass, 0 fail, 0 skipped | **117 s** |
| `node src/cli/index.js judge --text` | **Exit 0**; `judge: ok (exit 0)`, `PASS in 37.4 s (budget 60 s, enforced)` | **38 s** |
| `node src/cli/index.js console --port 47891` | Started, printed localhost URL with per-start token; root returned HTTP **200** and title `JustRunMe Console` | Local HTTP probe; process stopped afterwards |

`npm install` was used as documented in README. A separate `npx --yes node@24 --test test/*.test.js` run on Node 24.22.3 also passed all 573 tests (exit 0, 47 s); this is not the exact npm script invocation. The README does explicitly document `npm test` and `node src/cli/index.js judge --text`; its CLI reference documents `justrunme console [--port n]`. The console port `47891` was free during this test. Never publish or reuse the Console's per-start token.

## Judge demo: expected output

With Docker running and the Postgres image cached, use:

```sh
node src/cli/index.js judge --text
```

Observed output began:

```text
judge: ok (exit 0)
PASS in 37.4 s (budget 60 s, enforced)
```

The step report confirmed a destructive rehearsal denied, a safe alternative rehearsed and authorized, the real run, undo and recovery verification, offline receipt verification, and tamper detection. It ended with:

```text
receipts verified: 8, mismatches: 0, policy violations: 0
```

For the Console, use `node src/cli/index.js console --port 47891` (or omit `--port` for its default). Open the localhost URL printed in its JSON output, including its **private token fragment**. This check verified the HTML HTTP response and title, **not** a full interactive browser walkthrough. Stop it with Ctrl-C when finished.

## Troubleshooting and gaps found

1. **Full test suite now passes on Node 26.** The fresh clone at `de25622` passed 573/573 tests (exit 0, 117 s). The earlier 10 live-run failures recorded against `316625a` are no longer reproduced. This confirms the tested revision and environment, not every platform or future revision.
2. **README doesn't give a fully linear fresh-start path.** Its Development section suggests `npm install` and `npm test`, while the judge command appears much earlier under the CLI reference. `npm ci` is not prescribed. A judge needs to locate the separate `judge --text` and `console` sections. This document puts them together without changing the README.
3. **Docker is mandatory for judge mode.** This run had a local daemon and cached image, so first-time image pull time and no-Docker error output were **not** measured. The 60-second budget was enforced here because the image was cached.
4. **Node version coverage is limited.** Node 26.13.1 passed the full npm test command; Node 24.22.3 passed the equivalent direct Node test invocation. Other versions and platforms were not tested in this fresh clone.
5. **No browser UI acceptance test was performed.** HTTP 200 confirms that the Console served HTML, not that its interactive workflows were exercised.

## Cleanup

- The judge command removed its own temporary containers, networks and volumes: no `jrm-judge-*` resources remained in `docker ps -a`, `docker network ls` or `docker volume ls` after the run; the judge command reported successful cleanup.
- The Console listener on port `47891` was stopped and verified absent with `lsof`.
- No unrelated Docker resources were intentionally modified.
- The temporary fresh clone was left in place for reproducibility; it is **not** a running container or service.

No Kiro CLI credits were used for this documentation/verification task; no entry was added to `docs/KIRO_LOG.md`.
