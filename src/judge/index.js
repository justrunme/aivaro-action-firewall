/**
 * `justrunme judge` (T19): one command, one throwaway Postgres, a full mission, a
 * PASS/FAIL report. The whole run, setup and teardown included, is timed against the
 * 60 s budget (R8.2) when the images are already on the machine.
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
  // Ctrl-C must not leave a database container behind.
  const onSignal = (sig) => () => env.cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143))
  const handlers = ['SIGINT', 'SIGTERM'].map((s) => [s, onSignal(s)])
  for (const [s, h] of handlers) process.once(s, h)
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
    for (const [s, h] of handlers) process.removeListener(s, h)
    await env.cleanup()
  }
}
