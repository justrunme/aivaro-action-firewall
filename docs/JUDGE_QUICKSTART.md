# Fresh-clone judge quickstart (Mac, 21 November 2026)

This is a recorded fresh-checkout test of **origin/main at `316625a2cf7b085ae448f17319c795c3884f3d65`**, not a claim that every host or Node version works. The checkout was newly cloned into `/tmp/jrm-judge-fresh-20261121-UDn2Xx` (resolved by macOS to `/private/tmp/jrm-judge-fresh-20261121-UDn2Xx`). It was not the development checkout.

## Prerequisites observed

- macOS arm64; Node.js **v26.13.1**, npm **11.20.0**; Docker CLI and daemon **28.4.0**.
- Docker Desktop/daemon was running and the `postgres:16.3-alpine` image was already available as `linux/arm64`.
- `DOCKER_DEFAULT_PLATFORM` was **unset**; no platform workaround was needed.
- Node 26 is newer than the README's Node 24 minimum, but this run found failing tests on Node 26. Node 24 was **not** exercised in this fresh clone.

## Exact fresh-checkout path

| Step / command | Result | Wall time / evidence |
| --- | --- | --- |
| `git clone --branch main --single-branch https://github.com/justrunme/justrunme-zero.git /tmp/jrm-judge-fresh-20261121-UDn2Xx` | Exit 0, commit `316625a` | About 2 s; new folder |
| `git config user.name "Andrey Lesnikov"` and `git config user.email "52860508+justrunme@users.noreply.github.com"` inside the clone | Exit 0 | Repo-local identity only |
| `npm ci` | Exit 0; 6 packages installed, 0 vulnerabilities reported | **1.62 s** |
| `npm test` | **Exit 1**; 571 tests, 555 pass, 10 fail, 0 skipped (Node test runner also reports nested failures) | **107.48 s** |
| `node src/cli/index.js judge --text` | **Exit 0**; `judge: ok (exit 0)`, `PASS in 37.4 s (budget 60 s, enforced)` | **37.58 s** |
| `node src/cli/index.js console --port 47891` | Started, printed localhost URL with per-start token; root returned HTTP **200** and title `JustRunMe Console` | Local HTTP probe; process stopped afterwards |

`npm ci` is a reproducible lockfile install used for this check; the README on this `main` revision says `npm install` instead. The README does explicitly document `npm test` and `node src/cli/index.js judge --text`; its CLI reference documents `justrunme console [--port n]`. The console port `47891` was free during this test. Never publish or reuse the Console's per-start token.

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

1. **Full test suite fails on this Mac's Node 26.** `npm test` returned exit 1 with **10 failing test entries**, all under `test/live-run.test.js`. One representative failure is `fault at git`: `AssertionError [ERR_ASSERTION]: 'workspace' !== 'git'` at `test/live-run.test.js:336`. Another is `a state marked removing still refuses a directory with another marker`: `1 !== 0` at line 427. This is not a passing fresh-clone test run. The failures are consistent with an early workspace/path check short-circuiting live-run setup; root cause is **not proven** here. See the separate path-robustness task; do not weaken tests to make this green.
2. **README doesn't give a fully linear fresh-start path.** Its Development section suggests `npm install` and `npm test`, while the judge command appears much earlier under the CLI reference. `npm ci` is not prescribed. A judge needs to locate the separate `judge --text` and `console` sections. This document puts them together without changing the README.
3. **Docker is mandatory for judge mode.** This run had a local daemon and cached image, so first-time image pull time and no-Docker error output were **not** measured. The 60-second budget was enforced here because the image was cached.
4. **Node version coverage is limited.** This Mac used Node 26; Node 24 compatibility should be evaluated independently (the repository's CI uses Node 24). The demo passing does not make the full suite green.
5. **No browser UI acceptance test was performed.** HTTP 200 confirms that the Console served HTML, not that its interactive workflows were exercised.

## Cleanup

- The judge command removed its own temporary containers, networks and volumes: no `jrm-judge-*` resources remained in `docker ps -a`, `docker network ls` or `docker volume ls` after the run; no `jrm-rehearsal-*` directory remained under `/tmp`.
- The Console listener on port `47891` was stopped and verified absent with `lsof`.
- Other pre-existing containers (`admiring_chaum`, `confident_lamport`, `jrm-chaoslive-faeb61-db-1`, `jrm-console-13488c-db-1`, `jrm-live-3d05e5-db-1`) were **not** touched.
- The temporary fresh clone was left in place for reproducibility; it is **not** a running container or service. Its Git working tree was clean after the test.

No Kiro CLI credits were used for this documentation/verification task; no entry was added to `docs/KIRO_LOG.md`.
