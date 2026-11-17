/**
 * The rehearsal engine checks, from Docker itself, that the copy's database
 * container cannot reach out before it loads real data or runs a plan step.
 * A fake `docker` answers what `docker inspect` and `docker network inspect` would.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertIsolated, writeNoPortsOverride } from '../src/rehearsal/compose.js'

const SCRIPT = `#!/bin/sh
case "$1" in
  compose) echo abcdef123456 ;;
  inspect) echo "$FAKE_MODE $FAKE_NETS" ;;
  network) for last; do :; done; if [ "$last" = "bridge" ]; then echo false; else echo true; fi ;;
esac
exit 0
`

describe('rehearsal copy isolation (assertIsolated)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jrm-isolation-'))
  before(() => writeFileSync(path.join(dir, 'docker'), SCRIPT, { mode: 0o755 }))
  after(() => rmSync(dir, { recursive: true, force: true }))

  let n = 0
  const target = (mode, nets) => ({
    project: `jrm-iso-test-${(n += 1)}`,
    composeFile: '/x/docker-compose.yml',
    dbService: 'db',
    dbUser: 'u',
    dbName: 'd',
    env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_MODE: mode, FAKE_NETS: nets },
  })

  it('accepts a container that sits only on internal networks', async () => {
    await assertIsolated(target('proj_default', 'proj_default'))
    await assertIsolated(target('proj_default', 'proj_default proj_second'))
  })

  it('refuses a container on a network that is not internal, host or shared network mode', async () => {
    await assert.rejects(assertIsolated(target('bridge', 'bridge')), /not isolated: network bridge is not internal/)
    await assert.rejects(assertIsolated(target('proj_default', 'proj_default bridge')), /network bridge is not internal/)
    await assert.rejects(assertIsolated(target('host', '')), /network mode host/)
    await assert.rejects(assertIsolated(target('container:abc123', '')), /network mode container:abc123/)
  })

  it('the override file the engine writes for a rehearsal copy declares the default network internal; the plain one does not', () => {
    const isolated = readFileSync(writeNoPortsOverride(['db'], { isolate: true }), 'utf8')
    const plain = readFileSync(writeNoPortsOverride(['db']), 'utf8')
    assert.match(isolated, /networks:\n  default:\n    internal: true/)
    assert.doesNotMatch(plain, /internal/)
  })
})
