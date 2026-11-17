import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { captureFiles, restoreFiles, verifyFiles, captureRoots } from '../src/capture/files.js'

const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = (p) => {
  const d = mkdtempSync(path.join(os.tmpdir(), p))
  dirs.push(d)
  return d
}
const contract = { allowed_paths: ['demo/migrations/'], resources: { config_files: ['demo/app.config.json'] } }

function workspace() {
  const repo = tmp('jrm-files-')
  mkdirSync(path.join(repo, 'demo/migrations/sub'), { recursive: true })
  writeFileSync(path.join(repo, 'demo/migrations/001.sql'), 'create table a();\n')
  writeFileSync(path.join(repo, 'demo/migrations/sub/002.sql'), 'create table b();\n')
  writeFileSync(path.join(repo, 'demo/app.config.json'), '{"feature":"off"}\n')
  writeFileSync(path.join(repo, 'demo/outside.txt'), 'not captured\n')
  return repo
}

describe('file capture and restore (R4.1, R4.3, R5.1)', () => {
  it('roots are allowed_paths plus config files, normalized', () => {
    assert.deepEqual(captureRoots(contract), ['demo/app.config.json', 'demo/migrations'])
  })

  it('restores modified and deleted files, removes new ones, leaves other paths alone', () => {
    const repo = workspace()
    const cap = tmp('jrm-cap-')
    const captured = captureFiles(repo, contract, cap)
    assert.deepEqual(captured.files.map((f) => f.path), ['demo/app.config.json', 'demo/migrations/001.sql', 'demo/migrations/sub/002.sql'])

    writeFileSync(path.join(repo, 'demo/migrations/001.sql'), 'drop table a;\n')
    rmSync(path.join(repo, 'demo/migrations/sub/002.sql'))
    writeFileSync(path.join(repo, 'demo/migrations/003.sql'), 'new\n')
    writeFileSync(path.join(repo, 'demo/app.config.json'), '{"feature":"on"}\n')
    writeFileSync(path.join(repo, 'demo/outside.txt'), 'changed outside scope\n')
    assert.ok(verifyFiles(repo, captured).some((c) => !c.ok))

    const r = restoreFiles(repo, captured, cap)
    assert.deepEqual(r.restored.sort(), ['demo/app.config.json', 'demo/migrations/001.sql', 'demo/migrations/sub/002.sql'])
    assert.deepEqual(r.removed, ['demo/migrations/003.sql'])
    assert.ok(verifyFiles(repo, captured).every((c) => c.ok))
    assert.equal(readFileSync(path.join(repo, 'demo/outside.txt'), 'utf8'), 'changed outside scope\n') // not in scope, not claimed
  })

  it('refuses to restore from a captured copy that no longer matches its checksum', () => {
    const repo = workspace()
    const cap = tmp('jrm-cap-')
    const captured = captureFiles(repo, contract, cap)
    writeFileSync(path.join(repo, 'demo/migrations/001.sql'), 'changed\n')
    writeFileSync(path.join(cap, 'files/demo/migrations/001.sql'), 'tampered capture\n')
    assert.throws(() => restoreFiles(repo, captured, cap), /does not match its checksum/)
    assert.equal(readFileSync(path.join(repo, 'demo/migrations/001.sql'), 'utf8'), 'changed\n')
  })

  it('does not follow symbolic links out of the captured roots', () => {
    const repo = workspace()
    const outside = tmp('jrm-out-')
    writeFileSync(path.join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, path.join(repo, 'demo/migrations/link'))
    const captured = captureFiles(repo, contract, tmp('jrm-cap-'))
    assert.deepEqual(captured.skipped, ['demo/migrations/link'])
    assert.ok(!captured.files.some((f) => f.path.includes('secret')))
  })

  it('property: any sequence of edits inside the roots is fully undone, and undo twice is the same', () => {
    const op = fc.record({
      kind: fc.constantFrom('write', 'delete', 'create'),
      file: fc.constantFrom('demo/migrations/001.sql', 'demo/migrations/sub/002.sql', 'demo/app.config.json', 'demo/migrations/new.sql', 'demo/migrations/sub/deep/x.sql'),
      text: fc.string({ maxLength: 20 }),
    })
    fc.assert(
      fc.property(fc.array(op, { maxLength: 8 }), (ops) => {
        const repo = workspace()
        const cap = tmp('jrm-cap-')
        const captured = captureFiles(repo, contract, cap)
        for (const o of ops) {
          const abs = path.join(repo, o.file)
          if (o.kind === 'delete') rmSync(abs, { force: true })
          else {
            mkdirSync(path.dirname(abs), { recursive: true })
            writeFileSync(abs, o.text)
          }
        }
        restoreFiles(repo, captured, cap)
        const once = verifyFiles(repo, captured).every((c) => c.ok)
        const second = restoreFiles(repo, captured, cap)
        const twice = verifyFiles(repo, captured).every((c) => c.ok)
        return once && twice && second.restored.length === 0 && second.removed.length === 0 && existsSync(path.join(repo, 'demo/outside.txt'))
      }),
      { numRuns: 60 }
    )
  })
})
