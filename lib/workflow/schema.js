/**
 * schema.js — WorkflowDefinition data model + validation.
 *
 * The single source of truth for what a saved workflow looks like. Used by:
 *  - the workflow store (storageDomain) for durable records,
 *  - the generator (对话→工作流) to emit definitions,
 *  - the executor to run steps,
 *  - the panel UI to render/edit definitions.
 *
 * Pure module: no Cordis imports, safe to load anywhere.
 */

/** Version of the workflow definition format. */
export const WORKFLOW_FORMAT_VERSION = 1

/** Recognized step kinds. */
export const STEP_KINDS = [
  'navigate', 'action', 'extract', 'wait', 'ask', 'approve',
  'loop', 'subflow', 'branch'
]

/** Recognized action types for an `action` step. */
export const ACTION_TYPES = ['click', 'type', 'select', 'scroll', 'hover', 'clear']

/** Recognized trigger kinds. */
export const TRIGGER_KINDS = ['manual', 'schedule']

/**
 * Validate one ElementTarget (multi-signature element locator).
 * @returns {string[]} list of problems (empty = valid).
 */
export function validateElementTarget(target, path = 'target') {
  const problems = []
  if (!target || typeof target !== 'object') return [`${path}: must be an object`]
  const keys = Object.keys(target)
  if (keys.length === 0) return [`${path}: must declare at least one locator feature`]
  if (target.semantic !== undefined) {
    if (typeof target.semantic !== 'object' || typeof target.semantic.role !== 'string' || typeof target.semantic.name !== 'string') {
      problems.push(`${path}.semantic: must be { role: string, name: string }`)
    }
  }
  if (target.textAnchor !== undefined && typeof target.textAnchor !== 'string') {
    problems.push(`${path}.textAnchor: must be a string`)
  }
  if (target.relative !== undefined) {
    if (typeof target.relative !== 'object' || !target.relative.anchor || typeof target.relative.position !== 'string') {
      problems.push(`${path}.relative: must be { anchor: ElementTarget, position: string }`)
    } else {
      problems.push(...validateElementTarget(target.relative.anchor, `${path}.relative.anchor`))
    }
  }
  if (target.selector !== undefined && typeof target.selector !== 'string') {
    problems.push(`${path}.selector: must be a string`)
  }
  if (target.indexInViewport !== undefined && typeof target.indexInViewport !== 'number') {
    problems.push(`${path}.indexInViewport: must be a number`)
  }
  return problems
}

/**
 * Validate one WorkflowStep.
 * @returns {string[]} problems.
 */
export function validateStep(step, path = 'step') {
  const problems = []
  if (!step || typeof step !== 'object' || typeof step.kind !== 'string') {
    return [`${path}: must be { kind, ... }`]
  }
  if (!STEP_KINDS.includes(step.kind)) {
    return [`${path}.kind: unknown "${step.kind}" (known: ${STEP_KINDS.join(', ')})`]
  }
  switch (step.kind) {
    case 'navigate':
      if (typeof step.url !== 'string' || step.url.length === 0) problems.push(`${path}.url: required string`)
      break
    case 'action': {
      if (!ACTION_TYPES.includes(step.action)) problems.push(`${path}.action: must be one of ${ACTION_TYPES.join(', ')}`)
      if (step.target) problems.push(...validateElementTarget(step.target, `${path}.target`))
      if (step.value !== undefined && typeof step.value !== 'string' && typeof step.value !== 'object') {
        problems.push(`${path}.value: must be a string or ParameterRef object`)
      }
      break
    }
    case 'extract': {
      if (!Array.isArray(step.fields) || step.fields.length === 0) {
        problems.push(`${path}.fields: required non-empty array`)
      } else {
        step.fields.forEach((f, i) => {
          if (!f || typeof f.name !== 'string') problems.push(`${path}.fields[${i}].name: required string`)
          if (f.selector) problems.push(...validateElementTarget(f.selector, `${path}.fields[${i}].selector`))
        })
      }
      if (step.target && step.target !== 'page') problems.push(...validateElementTarget(step.target, `${path}.target`))
      break
    }
    case 'wait':
      if (!['selector', 'network-idle', 'delay', 'load'].includes(step.condition)) {
        problems.push(`${path}.condition: must be selector|network-idle|delay|load`)
      }
      break
    case 'ask':
      if (typeof step.question !== 'string' || step.question.length === 0) problems.push(`${path}.question: required string`)
      break
    case 'approve':
      if (typeof step.reason !== 'string' || step.reason.length === 0) problems.push(`${path}.reason: required string`)
      break
    case 'loop': {
      if (!step.over || (typeof step.over !== 'string' && typeof step.over !== 'object')) {
        problems.push(`${path}.over: required (list-items | table-rows | ParameterRef)`)
      }
      if (!Array.isArray(step.body) || step.body.length === 0) problems.push(`${path}.body: required non-empty step array`)
      else step.body.forEach((s, i) => problems.push(...validateStep(s, `${path}.body[${i}]`)))
      break
    }
    case 'subflow':
      if (typeof step.ref !== 'string' || step.ref.length === 0) problems.push(`${path}.ref: required string`)
      break
    case 'branch': {
      if (!step.if || typeof step.if !== 'object') problems.push(`${path}.if: required condition object`)
      if (!Array.isArray(step.then)) problems.push(`${path}.then: required step array`)
      else step.then.forEach((s, i) => problems.push(...validateStep(s, `${path}.then[${i}]`)))
      if (step.else) step.else.forEach((s, i) => problems.push(...validateStep(s, `${path}.else[${i}]`)))
      break
    }
  }
  return problems
}

/**
 * Validate a complete WorkflowDefinition.
 * @returns {string[]} problems (empty = valid).
 */
export function validateWorkflow(def) {
  const problems = []
  if (!def || typeof def !== 'object') return ['workflow: must be an object']
  if (typeof def.name !== 'string' || def.name.length === 0) problems.push('name: required string')
  if (typeof def.description !== 'string') problems.push('description: required string')
  if (def.trigger) {
    if (!TRIGGER_KINDS.includes(def.trigger.kind)) problems.push(`trigger.kind: must be ${TRIGGER_KINDS.join('|')}`)
    if (def.trigger.schedule && typeof def.trigger.schedule !== 'object') problems.push('trigger.schedule: must be an object')
  }
  if (def.target && typeof def.target.urlPattern !== 'string') problems.push('target.urlPattern: required string when target present')
  if (!Array.isArray(def.steps) || def.steps.length === 0) problems.push('steps: required non-empty array')
  else def.steps.forEach((s, i) => problems.push(...validateStep(s, `steps[${i}]`)))
  if (def.parameters && !Array.isArray(def.parameters)) problems.push('parameters: must be an array')
  return problems
}

/** Create an empty workflow definition with defaults. */
export function createEmptyWorkflow(name = '未命名工作流') {
  return {
    id: null, // assigned at save
    name,
    description: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
    trigger: { kind: 'manual' },
    target: { urlPattern: '*' },
    steps: [],
    parameters: [],
    approval: { confirmOn: ['write', 'batch'], sampleBeforeBatch: true },
    verify: { successCriteria: [], retry: { maxAttempts: 1, onFailure: 'ask-user' } },
    output: { saveScreenshots: false, collectTo: 'workspace' }
  }
}

/**
 * Validate a loop item collection selector.
 * @returns {string[]} problems.
 */
export function validateLoopOver(over) {
  const problems = []
  if (typeof over === 'string') {
    if (!['list-items', 'table-rows'].includes(over)) problems.push(`loop.over: unknown "${over}"`)
  } else if (typeof over === 'object' && over.type === 'parameter') {
    // ParameterRef: { type: 'parameter', name: string }
    if (typeof over.name !== 'string') problems.push('loop.over(parameter).name: required')
  } else {
    problems.push('loop.over: must be list-items | table-rows | { type: "parameter", name }')
  }
  return problems
}

/** Is a value a ParameterRef ({ type: 'parameter', name })? */
export function isParameterRef(value) {
  return value !== null && typeof value === 'object' && value.type === 'parameter' && typeof value.name === 'string'
}
