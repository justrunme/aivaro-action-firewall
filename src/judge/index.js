/**
 * `justrunme judge` (T19): one command, one throwaway Postgres, a full mission, a
 * PASS/FAIL report. The whole run, setup and teardown included, is timed against the
 * 60 s budget (R8.2) when the images are already on the machine. Cleanup on failure
 * and on Ctrl-C / SIGTERM is owned by the backend (src/judge/env.js).
 */

import { performance } from 'node:perf_hooks'
import { buildReport } from './report.js'
import { runScenario } from './scenario.js'

/**
 * @param {{ create: () => Promise<{ backend: object, missionId: string, imagesCached: boolean, cleanup: () => Promise<void> }> }} deps
 */
export async function runJudge({ create }) {
  const t0 = performance.now()
  const env = await create()
  try {
    const scenario = await runScenario(env.backend)
    await env.cleanup()
    return buildReport({
      stepResults: scenario.stepResults,
      elapsedMs: performance.now() - t0,
      imagesCached: env.imagesCached,
      missionId: env.missionId,
      publicKey: scenario.publicKey,
      receipts: scenario.receipts,
      offline: scenario.offline,
      story: scenario.story,
    })
  } finally {
    await env.cleanup()
  }
}
