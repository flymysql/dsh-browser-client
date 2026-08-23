/**
 * generator.js — 对话→工作流生成器。
 *
 * Provides the model-facing `workflow_generate` tool: given a user's
 * natural-language description of a repetitive web task (plus optional
 * recorded page actions), the LLM emits a structured, validated
 * WorkflowDefinition that can be saved and replayed.
 *
 * The tool is a relay like page_*: the model calls it, we hand the context to
 * the model itself (the tool body runs inside the agent loop, so it just
 * validates + stores what the model passes). The heavy lifting — clarifying
 * questions, slot-filling from templates, abstracting recorded actions — is
 * the model's job, guided by the tool's description and the template library.
 */

import { validateWorkflow } from './schema.js'
import { SCENARIO_TEMPLATES, findTemplate } from './templates.js'

/**
 * Create the workflow_generate tool definition.
 * @param {object} store - workflow store (from mountWorkflows).
 * @param {{ timeoutMs?: number }} opts
 */
export function createWorkflowGenerateTool(store, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000

  return {
    name: 'workflow_generate',
    description: [
      'Create a saved, replayable web-automation workflow from the user\'s',
      'description of a repetitive task. Use this after understanding the task',
      'and optionally after recording the user demonstrating it (page_record).',
      '',
      'The workflow has typed steps: navigate (go to URL), action (click/type/',
      'select/scroll on an element by semantic role+name, text anchor like',
      '"按钮「提交」", or CSS selector), extract (read fields from an element or',
      'page), wait (for selector/network-idle/delay), ask (pause to ask the',
      'user), approve (require confirmation for sensitive actions), loop (over',
      'list items / table rows / parameter data), subflow (call another saved',
      'workflow), branch (conditional).',
      '',
      'Element targets should prefer SEMANTIC locators (role+name or text',
      'anchor) over CSS selectors — the page may change, and semantic locators',
      'survive layout changes. Always include a human-readable textAnchor.',
      '',
      'Parameters: declare any user-supplied values (dates, URLs, account',
      'names) as parameters so the workflow can be templated and shared.',
      '',
      'approval.confirmOn should include "write" for workflows that submit,',
      'delete, or pay. verify.successCriteria should be natural-language',
      'conditions checked after the workflow runs.'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short workflow name, e.g. "每日订单导出".' },
        description: { type: 'string', description: 'One-line user-facing description of what it does.' },
        urlPattern: { type: 'string', description: 'Glob of the target page(s), e.g. "*.taobao.com/*". Default "*".' },
        steps: {
          type: 'array',
          description: 'Ordered workflow steps.',
          items: { type: 'object', additionalProperties: true }
        },
        parameters: {
          type: 'array',
          description: 'Declared parameters: [{ name, label, type: text|boolean, required }].',
          items: { type: 'object', additionalProperties: true }
        },
        confirmOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Approval triggers: "write", "batch", "navigate-external".'
        },
        successCriteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Natural-language success conditions to verify after running.'
        },
        scheduleEverySeconds: {
          type: 'number',
          description: 'Optional: run this workflow periodically (seconds, min 300).'
        },
        templateId: {
          type: 'string',
          description: 'Optional scenario template id to base the workflow on (e.g. "batch-form-fill").'
        },
        save: {
          type: 'boolean',
          description: 'Whether to persist the workflow now (default true).'
        }
      },
      required: ['name', 'description', 'steps'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const name = String(args.name || '').trim()
      const description = String(args.description || '').trim()
      const steps = Array.isArray(args.steps) ? args.steps : []

      if (!name) throw new Error('workflow_generate: name is required')
      if (steps.length === 0) throw new Error('workflow_generate: at least one step is required')

      const def = {
        name,
        description,
        trigger: args.scheduleEverySeconds
          ? { kind: 'schedule', schedule: { everySeconds: Math.max(300, args.scheduleEverySeconds) } }
          : { kind: 'manual' },
        target: { urlPattern: args.urlPattern || '*', titlePattern: undefined },
        steps,
        parameters: Array.isArray(args.parameters) ? args.parameters : [],
        approval: {
          confirmOn: Array.isArray(args.confirmOn) ? args.confirmOn : ['write', 'batch'],
          sampleBeforeBatch: true
        },
        verify: {
          successCriteria: Array.isArray(args.successCriteria) ? args.successCriteria : [],
          retry: { maxAttempts: 2, onFailure: 'ask-user' }
        },
        output: { saveScreenshots: false, collectTo: 'workspace' }
      }

      // Validate before persisting (fail loud with actionable problems).
      const problems = validateWorkflow(def)
      if (problems.length > 0) {
        throw new Error(`workflow_generate: invalid workflow: ${problems.join('; ')}`)
      }

      const saved = args.save === false ? def : await store.save(def)
      return {
        ok: true,
        saved: args.save !== false,
        workflowId: saved.id,
        name: saved.name,
        stepCount: saved.steps.length,
        summary: [
          `工作流「${saved.name}」${saved.id ? `(${saved.id.slice(0, 8)})` : ''}`,
          `${saved.steps.length} 步：`,
          ...saved.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`),
          saved.parameters.length ? `参数：${saved.parameters.map((p) => p.name).join(', ')}` : '',
          saved.trigger.kind === 'schedule' ? '⏰ 定时执行' : '🖐 手动执行',
          `审批：${saved.approval.confirmOn.join(', ')}`
        ].filter(Boolean).join('\n')
      }
    }
  }
}

/** Human-readable one-line description of a step. */
export function describeStep(step) {
  switch (step.kind) {
    case 'navigate': return `打开 ${step.url}`
    case 'action': return `${actionWord(step.action)} ${describeTarget(step.target)}${step.value ? `：${typeof step.value === 'string' ? step.value : step.value.name || ''}` : ''}`
    case 'extract': return `采集 ${step.fields ? step.fields.map((f) => f.name).join('、') : '页面数据'}`
    case 'wait': return `等待${step.condition === 'delay' ? ` ${step.timeout || 0}ms` : step.condition}`
    case 'ask': return `询问：${step.question}`
    case 'approve': return `确认：${step.reason}`
    case 'loop': return `循环处理 ${typeof step.over === 'string' ? step.over : '数据'}`
    case 'subflow': return `调用子工作流 ${step.ref}`
    case 'branch': return '条件分支'
    default: return step.kind
  }
}

function actionWord(a) {
  return { click: '点击', type: '输入', select: '选择', scroll: '滚动到', hover: '悬停', clear: '清空' }[a] || a
}

function describeTarget(t) {
  if (!t) return ''
  if (typeof t === 'string') return t
  if (t.textAnchor) return t.textAnchor
  if (t.semantic) return `${t.semantic.role}「${t.semantic.name}」`
  if (t.selector) return t.selector
  return '页面元素'
}

/** Scenario template summaries for the panel. */
export function templateList() {
  return SCENARIO_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, slots: t.slots.map((s) => s.name) }))
}

export function templateById(id) {
  return findTemplate(id) || null
}
