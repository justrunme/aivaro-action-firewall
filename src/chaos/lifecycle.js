/**
 * Owned resources of a recovery rehearsal and their release. Every resource is registered
 * the moment it exists; release runs every registered step in reverse order, each on its
 * own, so that one failing step (a `docker compose down` that errors) never skips the
 * others. Release errors are returned, never thrown, so the failure that ended the
 * rehearsal stays the one reported.
 */
import { errorSummary } from '../privacy/redact.js'

export function createLifecycle() {
  const owned = []
  return {
    /** @param {string} name what it is (for the report) @param {() => unknown} release */
    own(name, release) {
      owned.push({ name, release })
    },
    /** @returns {Promise<{ resource: string, released: boolean, error?: string }[]>} */
    async releaseAll() {
      const results = []
      for (const r of owned.splice(0).reverse()) {
        try {
          await r.release()
          results.push({ resource: r.name, released: true })
        } catch (err) {
          results.push({ resource: r.name, released: false, error: errorSummary(String(err?.message ?? err)) })
        }
      }
      return results
    },
  }
}
