import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { parseContract } from '../src/contract/parser.js'
import { stringify } from 'yaml'

export const VALID = {
  id: 'mission-2026-001',
  objective: 'Apply a database migration to the demo service',
  allowed_paths: ['demo/migrations/', 'demo/src/'],
  protected_tables: ['orders', 'patches'],
  time_limit_seconds: 300,
  irreversible_actions: ['step-3'],
  plan: [
    { id: 'step-1', tool: 'shell', args: ['node', 'demo/migrations/run.js'], reversibility: true },
    { id: 'step-2', tool: 'shell', args: ['docker', 'compose', 'restart', 'app'], reversibility: true },
    { id: 'step-3', tool: 'web_fetch', args: ['https://api.example.com/notify'], reversibility: false },
  ],
  resources: { databases: ['pumpkin_patch'], config_files: ['demo/.env.example'], compose_services: ['app', 'db'] },
}

const REQUIRED = Object.keys(VALID)
const clone = (v) => JSON.parse(JSON.stringify(v))
const yamlOf = (v) => stringify(v)

describe('contract parser: valid input', () => {
  it('parses a valid contract and returns a stable hash', () => {
    const a = parseContract(yamlOf(VALID))
    const b = parseContract(yamlOf(VALID))
    assert.equal(a.ok, true)
    assert.match(a.hash, /^sha256:[0-9a-f]{64}$/)
    assert.equal(a.hash, b.hash)
  })

  it('hash does not depend on key order in the YAML file', () => {
    const reordered = Object.fromEntries(Object.entries(VALID).reverse())
    assert.equal(parseContract(yamlOf(reordered)).hash, parseContract(yamlOf(VALID)).hash)
  })

  it('hash changes when the plan changes', () => {
    const changed = clone(VALID)
    changed.plan[0].args = ['node', 'demo/migrations/other.js']
    assert.notEqual(parseContract(yamlOf(changed)).hash, parseContract(yamlOf(VALID)).hash)
  })

  it('accepts optional impact_thresholds', () => {
    const c = clone(VALID)
    c.impact_thresholds = { max_rows_deleted: 100, max_external_calls: 0 }
    assert.equal(parseContract(yamlOf(c)).ok, true)
  })
})

describe('contract parser: fail closed (R1.1, R1.2)', () => {
  it('rejects empty and non-mapping documents', () => {
    assert.equal(parseContract('').ok, false)
    assert.equal(parseContract('- a\n- b\n').ok, false)
    assert.equal(parseContract('just text').ok, false)
  })

  it('rejects YAML syntax errors and names a position', () => {
    const r = parseContract('id: [unclosed\nplan: x\n')
    assert.equal(r.ok, false)
    assert.match(r.errors[0].field, /yaml/)
  })

  it('rejects unknown top-level and nested fields', () => {
    const top = clone(VALID)
    top.extra = 1
    const step = clone(VALID)
    step.plan[0].shell = 'rm -rf /'
    assert.ok(parseContract(yamlOf(top)).errors.some((e) => e.field === 'extra'))
    assert.ok(parseContract(yamlOf(step)).errors.some((e) => e.field === 'plan[0].shell'))
  })

  it('rejects YAML aliases', () => {
    const text = yamlOf(VALID).replace('- demo/src/', '- &p demo/src/\n  - *p')
    assert.equal(parseContract(text).ok, false)
    const aliasDoc = 'a: &x [1]\nb: *x\n'
    assert.equal(parseContract(aliasDoc).ok, false)
  })

  it('rejects duplicate keys', () => {
    const text = yamlOf(VALID) + 'objective: second value\n'
    assert.equal(parseContract(text).ok, false)
  })

  it('rejects path traversal and absolute paths in allowed_paths', () => {
    for (const bad of ['../etc', '/etc', '~/x', 'a/../../b', 'C:\\x']) {
      const c = clone(VALID)
      c.allowed_paths = [bad]
      assert.equal(parseContract(yamlOf(c)).ok, false, `accepted ${bad}`)
    }
  })

  it('rejects a time limit that is not a bounded integer', () => {
    for (const bad of [0, -5, 1.5, 100000, '300']) {
      const c = clone(VALID)
      c.time_limit_seconds = bad
      assert.equal(parseContract(yamlOf(c)).ok, false, `accepted ${bad}`)
    }
  })

  it('requires irreversible_actions to match reversibility: false exactly', () => {
    const missing = clone(VALID)
    missing.irreversible_actions = []
    const extra = clone(VALID)
    extra.irreversible_actions = ['step-3', 'step-1']
    const unknown = clone(VALID)
    unknown.irreversible_actions = ['step-3', 'nope']
    for (const c of [missing, extra, unknown]) assert.equal(parseContract(yamlOf(c)).ok, false)
  })

  it('rejects duplicate step ids and an empty plan', () => {
    const dup = clone(VALID)
    dup.plan[1].id = 'step-1'
    const empty = clone(VALID)
    empty.plan = []
    empty.irreversible_actions = []
    assert.equal(parseContract(yamlOf(dup)).ok, false)
    assert.equal(parseContract(yamlOf(empty)).ok, false)
  })
})

describe('contract parser: property tests (R1.1)', () => {
  it('any contract missing a required top-level field returns an error naming that field', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REQUIRED), (field) => {
        const c = clone(VALID)
        delete c[field]
        const r = parseContract(yamlOf(c))
        return r.ok === false && r.errors.some((e) => e.field === field)
      }),
      { numRuns: 100 }
    )
  })

  it('any plan step missing a required field returns an error naming that step field', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), fc.constantFrom('id', 'tool', 'args', 'reversibility'), (i, field) => {
        const c = clone(VALID)
        delete c.plan[i][field]
        const r = parseContract(yamlOf(c))
        return r.ok === false && r.errors.length > 0 && r.errors.some((e) => e.field.startsWith(`plan[${i}]`) || e.field === 'irreversible_actions')
      }),
      { numRuns: 100 }
    )
  })

  it('parsing never throws, whatever the input text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const r = parseContract(text)
        return typeof r.ok === 'boolean'
      }),
      { numRuns: 300 }
    )
  })
})
