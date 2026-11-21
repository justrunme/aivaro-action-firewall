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
 * Cleanup runs once; its status is kept. A failing cleanup never throws out of here:
 * it becomes an unverified status, which the report turns into FAIL.
 */
const once = (cleanup) => {
  let pending = null
  return () => (pending ??= Promise.resolve().then(cleanup).catch(() => ({ ok: false, status: 'unverified', leftovers: [], errors: ['cleanup_failed'] })))
}

/**
 * @param {{ create: () => Promise<{ backend: object, missionId: string, imagesCached: boolean, cleanup: () => Promise<object> }> }} deps
 */
export async function runJudge({ create }) {
  const t0 = performance.now()
  const env = await create()
  const cleanup = once(env.cleanup)
  try {
    const scenario = await runScenario(env.backend)
    const cleanupStatus = await cleanup()
    return buildReport({
      stepResults: scenario.stepResults,
      elapsedMs: performance.now() - t0,
      imagesCached: env.imagesCached,
      missionId: env.missionId,
      publicKey: scenario.publicKey,
      receipts: scenario.receipts,
      offline: scenario.offline,
      story: scenario.story,
      cleanup: cleanupStatus,
    })
  } finally {
    await cleanup()
  }
}
