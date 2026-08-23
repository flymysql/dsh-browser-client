/**
 * explorer.js — 探索式工作流生成（Explore Mode）。
 *
 * 复杂需求下，LLM 往往无法一次给出完整方案。探索模式让 LLM：
 *  1. explore_start    — 开启一次探索会话（记录操作轨迹）
 *  2. explore_act      — 执行一次页面操作，结果（成功/失败）记入轨迹
 *  3. explore_extract  — 读取页面数据（也记入轨迹作为"目标达成证据"）
 *  4. explore_ask      — 探索中向用户求助（"需要你输验证码" / "这步对吗？"）
 *  5. explore_check    — 校验一个目标条件是否达成（如"购物车里有商品了吗"）
 *  6. explore_finish   — 结束探索，把轨迹中验证通过的步骤提炼为工作流定义
 *
 * 提炼逻辑：轨迹里每一步都带 success 标记；提炼时只保留 success 的步骤，
 * 把"尝试-失败-换方式"的中间过程丢弃，生成干净的可重跑工作流。
 */

import { validateWorkflow } from './schema.js'
import { describeStep } from './generator.js'

/** 创建探索模式工具集。 */
export function createExploreTools(store, deps = {}) {
  const bridge = deps.bridge
  const ctxServices = deps.ctxServices || {}
  const log = deps.log || ((m) => console.log(`[dsh-browser-host:explore] ${m}`))

  // 当前探索会话状态（单会话即可，产品形态是单用户浮窗）。
  const session = {
    active: false,
    goal: null,          // 用户目标（口语化）
    startedAt: 0,
    steps: [],           // [{ seq, type, target, action, value, result, success, note }]
    verified: [],        // 已确认达成的目标条件
    history: []          // 原始尝试历史（含失败的，供 LLM 参考）
  }

  /** 一次 bridge 请求。 */
  async function bridgeRequest(tool, args, { signal, timeoutMs = 60000 } = {}) {
    if (!bridge || !bridge.request) throw new Error('extension bridge not connected')
    return bridge.request(tool, args, { signal, timeoutMs })
  }

  /** 记录一步到轨迹。 */
  function recordStep(entry) {
    const seq = session.history.length + 1
    const rec = { seq, ts: Date.now() - session.startedAt, ...entry }
    session.history.push(rec)
    if (entry.success) session.steps.push(rec)
    return rec
  }

  /** 从 URL 提取域名（用于站点记忆）。 */
  function domainOf(url) {
    try { return new URL(url).hostname } catch { return null }
  }

  /**
   * 站点记忆：从已保存的工作流里找同域名（urlPattern 匹配）的，作为
   * 探索起点提示。返回 [{ name, steps, id }]。
   */
  function memoryForDomain(host) {
    if (!host) return []
    const out = []
    for (const w of store.list()) {
      const pat = w.target && w.target.urlPattern
      if (pat && typeof pat === 'string' && pat.includes(host)) {
        out.push({ id: w.id, name: w.name, stepCount: w.steps.length, steps: w.steps.slice(0, 5).map((s) => describeStep(s)) })
      }
    }
    return out.slice(0, 3)
  }

  /** 把一次页面操作参数化为可重放的步骤（语义定位优先）。 */
  function normalizeAction(args) {
    const step = { type: 'action', action: args.action }
    if (args.textAnchor) step.target = { textAnchor: args.textAnchor }
    else if (args.semantic) step.target = { semantic: args.semantic }
    else if (args.selector) step.target = { selector: args.selector }
    else if (args.x !== undefined || args.y !== undefined) step.target = { x: args.x, y: args.y }
    if (args.text !== undefined) step.value = args.text
    return step
  }

  const tools = [
    {
      name: 'explore_start',
      description: [
        'Start an exploratory session to figure out how to accomplish a complex',
        'task on the current page through trial and error. Use this when the',
        'user\'s goal is too complex to plan in one shot — you will explore,',
        'observe results, correct course, and finally extract the working path',
        'into a saved workflow with explore_finish.',
        'Pass the user\'s goal in plain words so the session is goal-directed.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The user\'s goal in plain language.' }
        },
        required: ['goal'],
        additionalProperties: false
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        session.active = true
        session.goal = String(args.goal || '')
        session.startedAt = Date.now()
        session.steps = []
        session.verified = []
        session.history = []
        // 站点记忆：如果当前页面域名已有验证过的工作流，提示 LLM 作为起点，
        // 避免重复探索同一个站点的常见路径。
        let memory = []
        try {
          const current = await bridgeRequest('page_eval', { expression: 'location.hostname' })
          const host = typeof current === 'string' ? current : null
          memory = memoryForDomain(host || domainOf(args.url || ''))
          if (memory.length > 0) {
            log(`explore started with ${memory.length} known path(s) for ${host}`)
          }
        } catch { /* page may not be loaded yet; memory stays empty */ }
        session.memory = memory
        return {
          ok: true,
          goal: session.goal,
          memory,
          message: memory.length > 0
            ? `探索开始：这个站点已有 ${memory.length} 个验证过的工作流，可参考：${memory.map((m) => m.name).join('、')}。也可以重新探索。`
            : '探索开始：请像平时一样操作页面，或让我尝试。'
        }
      }
    },

    {
      name: 'explore_act',
      description: [
        'Perform one page action during exploration and record its outcome.',
        'Supports: click, type, scroll, hover, clear, select, navigate. Target by',
        'textAnchor ("按钮「提交」"), semantic role+name, CSS selector, or coordinates.',
        'After the action the result includes a page snapshot so you can VERIFY',
        'the effect objectively (did a new element appear? did the URL change?).',
        'Then set success=true only if the observed outcome matches what you',
        'intended. If it did not, set success=false and use explore_undo to back',
        'out before trying a different approach.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'type', 'scroll', 'hover', 'clear', 'select', 'navigate'], description: 'The action. navigate = go to a URL.' },
          textAnchor: { type: 'string', description: 'Semantic text locator, e.g. 按钮「提交」.' },
          semantic: { type: 'object', description: '{ role, name } a11y locator.' },
          selector: { type: 'string', description: 'CSS selector.' },
          x: { type: 'number', description: 'Viewport x.' },
          y: { type: 'number', description: 'Viewport y.' },
          text: { type: 'string', description: 'Text to type, option to select, or URL when action=navigate.' },
          note: { type: 'string', description: 'What you intended with this step (used for the final workflow).' },
          success: { type: 'boolean', description: 'Whether this step achieved its intent. Default true.' }
        },
        required: ['action'],
        additionalProperties: false
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        if (!session.active) throw new Error('explore_act: no active explore session — call explore_start first')
        // navigate is recorded as a navigate-type step (needed for path distillation).
        if (args.action === 'navigate') {
          const url = String(args.text || args.selector || '')
          if (!url) throw new Error('explore_act: navigate requires text=URL')
          try {
            const result = await bridgeRequest('page_navigate', { action: 'go', url })
            const rec = recordStep({ type: 'navigate', url, note: args.note || '', success: true, result })
            return { ok: true, seq: rec.seq, success: true, url, result }
          } catch (err) {
            const rec = recordStep({ type: 'navigate', url, note: args.note || '', success: false, error: String(err.message || err) })
            return { ok: false, seq: rec.seq, success: false, error: rec.error }
          }
        }
        const step = normalizeAction(args)
        try {
          const result = await bridgeRequest('page_act', { action: args.action, ...(step.target || {}), ...(args.text !== undefined ? { text: args.text } : {}) })
          const rec = recordStep({ ...step, note: args.note || '', success: args.success !== false, result })
          return { ok: true, seq: rec.seq, success: rec.success, snapshot: result }
        } catch (err) {
          const rec = recordStep({ ...step, note: args.note || '', success: false, error: String(err.message || err) })
          return { ok: false, seq: rec.seq, success: false, error: rec.error, message: `这一步失败了：${rec.error}` }
        }
      }
    },

    {
      name: 'explore_extract',
      description: [
        'Read data from the page during exploration (snapshot or arbitrary JS via',
        'expression). The extracted data is recorded as evidence toward the goal.',
        'Use explore_check to verify whether the goal condition is met.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Optional JS expression to evaluate (MAIN world).' },
          note: { type: 'string', description: 'What data you are looking for.' }
        },
        additionalProperties: false
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        if (!session.active) throw new Error('explore_extract: no active explore session')
        let data
        if (args.expression) {
          data = await bridgeRequest('page_eval', { expression: args.expression })
        } else {
          data = await bridgeRequest('page_snapshot', { includeVisibleText: false, maxElements: 60 })
        }
        const rec = recordStep({ type: 'extract', note: args.note || '', success: true, data })
        return { ok: true, seq: rec.seq, data }
      }
    },

    {
      name: 'explore_ask',
      description: [
        'Ask the user something during exploration: for a value (verification',
        'code, account info), for confirmation of a step ("这步对吗？"), or for',
        'guidance when stuck. The answer is recorded.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question for the user.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional answer choices.' }
        },
        required: ['question'],
        additionalProperties: false
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        if (!session.active) throw new Error('explore_ask: no active explore session')
        if (!ctxServices.askUser) throw new Error('explore_ask: user questions service unavailable')
        const answer = await ctxServices.askUser({
          question: args.question,
          options: Array.isArray(args.options) ? args.options.map((o) => String(o)) : undefined
        })
        recordStep({ type: 'ask', note: args.question, success: true, answer })
        return { ok: true, answer }
      }
    },

    {
      name: 'explore_check',
      description: [
        'Verify whether a goal condition is currently met on the page (e.g.',
        '"购物车里已经有商品了吗", "登录成功了吗", "第 2 页加载出来了吗").',
        'Runs a JS expression that returns true/false. Records the check as a',
        'verification milestone; only pass verified=true when the condition truly holds.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          condition: { type: 'string', description: 'Natural-language description of what to verify.' },
          expression: { type: 'string', description: 'JS expression returning a truthy/falsy value.' },
          verified: { type: 'boolean', description: 'Your judgment whether the condition is met (after evaluating).' }
        },
        required: ['condition', 'expression'],
        additionalProperties: false
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        if (!session.active) throw new Error('explore_check: no active explore session')
        let value = null
        try {
          value = await bridgeRequest('page_eval', { expression: args.expression })
        } catch (err) {
          value = { error: String(err.message || err) }
        }
        const isMet = args.verified === true
        recordStep({ type: 'check', condition: args.condition, success: true, verified: isMet, value })
        if (isMet) session.verified.push({ condition: args.condition, seq: session.history.length })
        return { ok: true, condition: args.condition, verified: isMet, value }
      }
    },

    {
      name: 'explore_undo',
      description: [
        'Undo the last exploration step when you took a wrong path: removes the',
        'last recorded step and, if a navigation happened earlier, navigates',
        'back to the page state before the undone step (via history.back or a',
        'target URL). Use this to recover from mistakes instead of piling more',
        'actions on top of a wrong path.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why you are undoing (for the record).' }
        },
        additionalProperties: false
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        if (!session.active) throw new Error('explore_undo: no active explore session')
        const last = session.history.pop()
        // Also drop from the success list if present.
        const i = session.steps.findIndex((s) => s.seq === (last && last.seq))
        if (i !== -1) session.steps.splice(i, 1)
        // Try to navigate back so the page matches the pre-undo state.
        let reverted = false
        if (last && last.type === 'navigate' && last.url) {
          try { await bridgeRequest('page_navigate', { action: 'back' }); reverted = true } catch {}
        } else if (last && last.type === 'action') {
          try { await bridgeRequest('page_navigate', { action: 'back' }); reverted = true } catch {}
        }
        return {
          ok: true,
          undone: last ? last.seq : null,
          reason: args.reason || '',
          reverted,
          remaining: session.history.length
        }
      }
    },

    {
      name: 'explore_finish',
      description: [
        'End the exploratory session and distill the verified successful path',
        'into a saved WorkflowDefinition. Only steps recorded with success=true',
        'are kept; failed attempts are dropped. You may add a final name/',
        'description and success criteria. Returns the saved workflow.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name, e.g. 每日订单导出.' },
          description: { type: 'string', description: 'One-line user-facing description.' },
          successCriteria: { type: 'array', items: { type: 'string' }, description: 'Natural-language success conditions.' },
          parameters: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Declared parameters.' },
          confirmOn: { type: 'array', items: { type: 'string' }, description: 'Approval triggers: write/batch/navigate-external.' },
          scheduleEverySeconds: { type: 'number', description: 'Optional periodic run.' }
        },
        required: ['name'],
        additionalProperties: false
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        if (!session.active) throw new Error('explore_finish: no active explore session')
        const clean = session.steps.filter((s) => s.type === 'action')
        if (clean.length === 0) {
          return { ok: false, error: '探索中没有记录到成功的操作步骤', message: '请先用 explore_act 记录至少一步成功操作，或说明卡在哪里。' }
        }

        // 自动补全：如果探索中途发生过导航，重跑工作流必须从起始 URL 开始，
        // 并在页面切换处插入 navigate + wait 步骤，否则重跑会从错误页面开始。
        const steps = []
        const navs = session.history.filter((h) => h.type === 'navigate')
        const startUrl = navs.length > 0 ? navs[0].url : (args.startUrl || '*')
        if (startUrl && startUrl !== '*') {
          steps.push({ kind: 'navigate', url: startUrl })
          steps.push({ kind: 'wait', condition: 'load', timeout: 10000 })
        }
        // 在每次导航之后跟随的 action 前，若页面 URL 变了则补 navigate。
        let lastNavUrl = startUrl
        for (const s of session.steps) {
          if (s.type === 'navigate') {
            lastNavUrl = s.url
            steps.push({ kind: 'navigate', url: s.url })
            steps.push({ kind: 'wait', condition: 'load', timeout: 10000 })
            continue
          }
          if (s.type === 'action') {
            steps.push({
              kind: 'action',
              action: s.action,
              target: s.target,
              ...(s.value !== undefined ? { value: s.value } : {}),
              note: s.note || ''
            })
            // 敏感动作后插入 wait，让页面有时间响应。
            if (/submit|save|delete|确认|提交|保存/.test(String(s.action) + ' ' + (s.note || ''))) {
              steps.push({ kind: 'wait', condition: 'network-idle', timeout: 5000 })
            }
          }
        }

        const def = {
          name: String(args.name || '探索生成的工作流'),
          description: String(args.description || session.goal || ''),
          trigger: args.scheduleEverySeconds
            ? { kind: 'schedule', schedule: { everySeconds: Math.max(300, args.scheduleEverySeconds) } }
            : { kind: 'manual' },
          target: { urlPattern: startUrl && startUrl !== '*' ? startUrl.replace(/^(https?:\/\/[^/]+).*$/, '$1*') : '*' },
          steps,
          parameters: Array.isArray(args.parameters) ? args.parameters : [],
          approval: {
            confirmOn: Array.isArray(args.confirmOn) ? args.confirmOn : ['write', 'batch'],
            sampleBeforeBatch: true
          },
          verify: {
            successCriteria: Array.isArray(args.successCriteria) ? args.successCriteria : session.verified.map((v) => v.condition),
            retry: { maxAttempts: 2, onFailure: 'ask-user' }
          },
          output: { saveScreenshots: false, collectTo: 'workspace' }
        }

        const problems = validateWorkflow(def)
        if (problems.length > 0) {
          return { ok: false, error: `invalid workflow: ${problems.join('; ')}`, message: '生成的工作流不合法，请修正后重试。' }
        }

        const saved = await store.save(def)
        const explored = session.history.length
        const distilled = session.steps.length
        session.active = false
        log(`explore finished: ${explored} attempts → ${distilled} verified steps → workflow "${saved.name}"`)

        return {
          ok: true,
          workflowId: saved.id,
          name: saved.name,
          stepCount: saved.steps.length,
          exploredAttempts: explored,
          distilledSteps: distilled,
          summary: [
            `工作流「${saved.name}」已保存 (${saved.id.slice(0, 8)})`,
            `探索 ${explored} 次操作，提炼 ${distilled} 步有效路径`,
            ...saved.steps.map((s, i) => `${i + 1}. ${describeStep(s)}${s.note ? `（${s.note}）` : ''}`),
            saved.verify.successCriteria.length ? `成功标准：${saved.verify.successCriteria.join('；')}` : ''
          ].filter(Boolean).join('\n')
        }
      }
    }
  ]

  return { tools, session }
}
