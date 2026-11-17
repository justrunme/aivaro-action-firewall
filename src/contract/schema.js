/**
 * Mission contract validation (R1.1, R1.2, R1.6).
 *
 * Hand-written strict validator: every object level rejects unknown keys, so
 * aliasing or smuggling extra fields cannot widen a contract. Returns all
 * errors with a field path; it never throws on bad input.
 *
 * @typedef {{ field: string, message: string }} ContractError
 */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const TOP_REQUIRED = [
  'id',
  'objective',
  'allowed_paths',
  'protected_tables',
  'time_limit_seconds',
  'irreversible_actions',
  'plan',
  'resources',
]
const TOP_OPTIONAL = ['impact_thresholds']
const STEP_KEYS = ['id', 'tool', 'args', 'reversibility']
const RESOURCE_KEYS = ['databases', 'config_files', 'compose_services']
const THRESHOLD_KEYS = ['max_rows_deleted', 'max_external_calls']

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A repository-relative path without traversal or absolute prefix. */
function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) return false
  if (p.includes('\0')) return false
  return !p.split(/[\\/]/).includes('..')
}

function stringArray(value, field, errors, { min = 0, item } = {}) {
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be an array' })
    return false
  }
  if (value.length < min) errors.push({ field, message: `must contain at least ${min} item(s)` })
  value.forEach((v, i) => {
    if (typeof v !== 'string' || v.length === 0) {
      errors.push({ field: `${field}[${i}]`, message: 'must be a non-empty string' })
    } else if (item && !item(v)) {
      errors.push({ field: `${field}[${i}]`, message: 'has an invalid value' })
    }
  })
  return true
}

function rejectUnknown(obj, allowed, base, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push({ field: base ? `${base}.${key}` : key, message: 'unknown field' })
    }
  }
}

/**
 * @param {unknown} doc parsed YAML value
 * @returns {ContractError[]} empty when the contract is valid
 */
export function validateContract(doc) {
  const errors = []
  if (!isObject(doc)) return [{ field: '(document)', message: 'must be a mapping' }]

  rejectUnknown(doc, [...TOP_REQUIRED, ...TOP_OPTIONAL], '', errors)
  for (const key of TOP_REQUIRED) {
    if (!(key in doc)) errors.push({ field: key, message: 'required field is missing' })
  }

  if ('id' in doc && !(typeof doc.id === 'string' && ID_RE.test(doc.id))) {
    errors.push({ field: 'id', message: 'must match [A-Za-z0-9][A-Za-z0-9._-]{2,63}' })
  }
  if ('objective' in doc && !(typeof doc.objective === 'string' && doc.objective.trim().length > 0 && doc.objective.length <= 500)) {
    errors.push({ field: 'objective', message: 'must be a non-empty string up to 500 characters' })
  }
  if ('allowed_paths' in doc) {
    stringArray(doc.allowed_paths, 'allowed_paths', errors, { min: 1, item: isSafeRelativePath })
  }
  if ('protected_tables' in doc) stringArray(doc.protected_tables, 'protected_tables', errors)
  if ('time_limit_seconds' in doc) {
    const t = doc.time_limit_seconds
    if (!(Number.isInteger(t) && t >= 1 && t <= 86400)) {
      errors.push({ field: 'time_limit_seconds', message: 'must be an integer from 1 to 86400' })
    }
  }
  if ('irreversible_actions' in doc) stringArray(doc.irreversible_actions, 'irreversible_actions', errors)

  const stepIds = new Set()
  const stepReversibility = new Map()
  if ('plan' in doc) {
    if (!Array.isArray(doc.plan) || doc.plan.length === 0) {
      errors.push({ field: 'plan', message: 'must be a non-empty array' })
    } else {
      doc.plan.forEach((step, i) => {
        const base = `plan[${i}]`
        if (!isObject(step)) {
          errors.push({ field: base, message: 'must be a mapping' })
          return
        }
        rejectUnknown(step, STEP_KEYS, base, errors)
        for (const key of STEP_KEYS) {
          if (!(key in step)) errors.push({ field: `${base}.${key}`, message: 'required field is missing' })
        }
        if ('id' in step) {
          if (!(typeof step.id === 'string' && STEP_ID_RE.test(step.id))) {
            errors.push({ field: `${base}.id`, message: 'must be a short identifier' })
          } else if (stepIds.has(step.id)) {
            errors.push({ field: `${base}.id`, message: 'duplicate step id' })
          } else {
            stepIds.add(step.id)
            stepReversibility.set(step.id, step.reversibility)
          }
        }
        if ('tool' in step && !(typeof step.tool === 'string' && step.tool.length > 0)) {
          errors.push({ field: `${base}.tool`, message: 'must be a non-empty string' })
        }
        if ('args' in step) stringArray(step.args, `${base}.args`, errors)
        if ('reversibility' in step && typeof step.reversibility !== 'boolean') {
          errors.push({ field: `${base}.reversibility`, message: 'must be true or false' })
        }
      })
    }
  }

  // irreversible_actions must name plan steps, and must match reversibility: false exactly.
  if (Array.isArray(doc.irreversible_actions)) {
    const listed = new Set(doc.irreversible_actions)
    doc.irreversible_actions.forEach((id, i) => {
      if (typeof id === 'string' && !stepIds.has(id)) {
        errors.push({ field: `irreversible_actions[${i}]`, message: 'does not name a plan step' })
      }
    })
    for (const [id, reversible] of stepReversibility) {
      if (reversible === false && !listed.has(id)) {
        errors.push({ field: 'irreversible_actions', message: `step ${id} has reversibility false but is not listed` })
      }
      if (reversible === true && listed.has(id)) {
        errors.push({ field: 'irreversible_actions', message: `step ${id} is listed but has reversibility true` })
      }
    }
  }

  if ('resources' in doc) {
    if (!isObject(doc.resources)) {
      errors.push({ field: 'resources', message: 'must be a mapping' })
    } else {
      rejectUnknown(doc.resources, RESOURCE_KEYS, 'resources', errors)
      for (const key of RESOURCE_KEYS) {
        if (!(key in doc.resources)) {
          errors.push({ field: `resources.${key}`, message: 'required field is missing' })
        } else {
          stringArray(doc.resources[key], `resources.${key}`, errors, key === 'config_files' ? { item: isSafeRelativePath } : {})
        }
      }
    }
  }

  if ('impact_thresholds' in doc) {
    const th = doc.impact_thresholds
    if (!isObject(th)) {
      errors.push({ field: 'impact_thresholds', message: 'must be a mapping' })
    } else {
      rejectUnknown(th, THRESHOLD_KEYS, 'impact_thresholds', errors)
      for (const key of THRESHOLD_KEYS) {
        if (key in th && !(Number.isInteger(th[key]) && th[key] >= 0)) {
          errors.push({ field: `impact_thresholds.${key}`, message: 'must be a non-negative integer' })
        }
      }
    }
  }

  return errors
}
