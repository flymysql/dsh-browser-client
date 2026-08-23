/**
 * index.js — workflow subsystem: durable store + host RPC methods + commands.
 *
 * Wires the WorkflowDefinition store into the plugin:
 *  - opens the storageDomain-backed store (falls back to in-memory when the
 *    service is unavailable, so the plugin still boots);
 *  - exposes harness RPC methods the panel calls:
 *      workflow.list / workflow.get / workflow.save / workflow.remove
 *      workflow.run  (start executing a saved workflow)
 *  - registers slash commands (/workflows, /run) through ctx.commands when
 *    the service exists.
 */

import { openWorkflowStore } from './store.js'
import { validateWorkflow, createEmptyWorkflow } from './schema.js'
import { SCENARIO_TEMPLATES, findTemplate, templateSummaries } from './templates.js'
import { createWorkflowGenerateTool, describeStep } from './generator.js'

/**
 * Mount the workflow subsystem.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ harness?: object, log?: (msg: string) => void }} opts
 * @returns {Promise<{ dispose: () => void, store: object }>}
 */
export async function mountWorkflows(ctx, opts = {}) {
  const log = opts.log || ((m) => console.log(`[dsh-browser-host] ${m}`))
  const harness = opts.harness
  const disposers = []

  // ── non-technical user guidance (system prompt section) ─────────────────────
  // 面向非研发人员：LLM 与用户对话时要用大白话、主动引导、不甩术语。
  // Registers a prompt section the model sees; it shapes every conversation
  // in sessions where this plugin is mounted.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    try {
      const d = systemPrompt.section({
        name: 'dsh-browser-nontechnical',
        order: 99,
        text: [
          '## 面向普通用户（非技术人员）的沟通规范',
          '',
          '这个会话的用户很可能是非研发人员（运营、客服、业务同学），他们在描述需求时：',
          '- 可能用口语、不完整句子，甚至只有几个关键词（"每天导订单"、"把那个表填了"）',
          '- 不知道 HTML/选择器/API 这些概念，也不关心',
          '- 希望听到"能/不能、怎么做、现在到哪一步了"这样的大白话',
          '',
          '沟通要求：',
          '1. 理解口语需求：先用自己的话复述确认（"你是想每天自动把后台订单导到表格里，对吗？"），再动手',
          '2. 不用术语：不要提"选择器/脚本/DOM/接口"，用"页面上的这个按钮/这个输入框"',
          '3. 主动引导：需求不完整时，用具体问题补全（"订单从哪个后台导？导到哪？每天几点？"）',
          '4. 失败说人话：操作失败时不要报错原文，要说"页面没找到这个按钮，可能位置变了"，并主动给选项',
          '5. 探索时透明：正在尝试/卡住/需要用户帮忙（如输验证码）时，实时用大白话说明',
          '6. 进度可见：告诉用户"正在做第几步 / 共几步"，做完说结果'
        ].join('\n')
      })
      disposers.push(d)
      log('registered non-technical user guidance prompt section')
    } catch (err) {
      log(`prompt section failed to register: ${err.message}`)
    }
  }

  // ── store (durable via storageDomain; in-memory fallback) ──────────────────
  let store
  let inMemory = false
  try {
    store = await openWorkflowStore(ctx)
    log(`workflow store opened (${store.size} saved)`)
  } catch (err) {
    log(`workflow store unavailable (${err.message}); using in-memory fallback`)
    inMemory = true
    const mem = new Map()
    store = {
      list: () => [...mem.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      get: (id) => mem.get(id),
      async save(def) {
        const now = Date.now()
        const existing = def.id ? mem.get(def.id) : undefined
        const record = {
          ...(existing || {}), ...def,
          id: def.id || crypto.randomUUID(),
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now,
          version: existing ? (existing.version || 0) + 1 : 1
        }
        mem.set(record.id, record)
        return record
      },
      async remove(id) { return mem.delete(id) },
      get size() { return mem.size },
      close: async () => {}
    }
  }

  // ── model tool: workflow_generate (LLM creates + saves workflows) ───────────
  const toolsService = opts.tools
  let exploreApi = null // set when explore tools mount
  if (toolsService !== undefined && typeof toolsService.register === 'function') {
    try {
      const tool = createWorkflowGenerateTool(store, { timeoutMs: opts.toolTimeoutMs || 60000 })
      const d = toolsService.register(tool)
      disposers.push(d)
      log('registered tool workflow_generate')
    } catch (err) {
      log(`workflow_generate tool failed to register: ${err.message}`)
    }

    // ── explore-mode tools (探索式工作流生成) ──────────────────────────────
    // For complex tasks the LLM cannot plan in one shot: explore → verify →
    // distill the working path into a saved workflow.
    try {
      const { createExploreTools } = await import('./explorer.js')
      const explorer = createExploreTools(store, {
        bridge: opts.bridge,
        ctxServices: opts.ctxServices || {},
        log
      })
      for (const t of explorer.tools) {
        try {
          const d = toolsService.register(t)
          disposers.push(d)
          log(`registered tool ${t.name}`)
        } catch (err) {
          log(`explore tool ${t.name} failed to register: ${err.message}`)
        }
      }
      // Expose the live explore session via the returned api.
      exploreApi = explorer
    } catch (err) {
      log(`explore tools failed to mount: ${err.message}`)
    }
  }

  // ── skill sync: register each saved workflow as a runtime skill ─────────────
  // So the model can discover and load a saved workflow as a skill in any
  // session (workflow = reusable instructions the agent can follow).
  const skillsService = opts.skills
  const skillDisposers = new Map() // workflowId -> disposer

  const syncSkill = (w) => {
    if (!skillsService || typeof skillsService.register !== 'function') return
    try {
      const old = skillDisposers.get(w.id)
      if (old) { try { old() } catch {} skillDisposers.delete(w.id) }
      const body = [
        `# 工作流：${w.name}`,
        '',
        w.description || '',
        '',
        '## 执行步骤',
        ...w.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`),
        '',
        w.parameters.length ? `## 参数\n${w.parameters.map((p) => `- ${p.name}: ${p.label}`).join('\n')}` : '',
        '',
        `## 运行\n保存的工作流 ID: ${w.id}。可通过 /run ${w.name} 或 workflow.run 运行。`
      ].join('\n')
      const d = skillsService.register({
        name: `workflow-${w.id.slice(0, 8)}`,
        description: `已保存的网页自动化工作流「${w.name}」：${w.description || w.name}`,
        body
      })
      if (d) skillDisposers.set(w.id, d)
    } catch (err) {
      log(`skill sync for "${w.name}" failed: ${err.message}`)
    }
  }

  // initial sync of existing workflows
  for (const w of store.list()) syncSkill(w)
  if (skillDisposers.size > 0) log(`synced ${skillDisposers.size} workflows as skills`)

  // ── RPC methods (panel calls these through /ext-api/<method>) ──────────────
  if (harness && typeof harness.handle === 'function') {
    const handle = harness.handle

    // Expose explore tools as local RPC too (panel driving / tests).
    if (exploreApi) {
      const exploreTools = new Map(exploreApi.tools.map((t) => [t.name, t]))
      for (const [name, tool] of exploreTools) {
        handle(`workflow.explore.${name.replace('explore_', '')}`, async (args) => {
          return tool.execute(args || {})
        })
      }
    }

    handle('workflow.list', async () => ({ items: store.list() }))

    handle('workflow.get', async (args) => {
      const def = store.get(String(args && args.id || ''))
      return def ? { workflow: def } : { workflow: null }
    })

    handle('workflow.save', async (args) => {
      const def = args && args.workflow
      if (!def || typeof def !== 'object') throw new Error('workflow.save: missing workflow')
      const problems = validateWorkflow(def)
      if (problems.length > 0) throw new Error(`workflow.save: invalid: ${problems.join('; ')}`)
      const saved = await store.save(def)
      syncSkill(saved)
      return { workflow: saved }
    })

    handle('workflow.remove', async (args) => {
      const id = String(args && args.id || '')
      await store.remove(id)
      const d = skillDisposers.get(id)
      if (d) { try { d() } catch {} skillDisposers.delete(id) }
      return { ok: true }
    })

    handle('workflow.empty', async () => ({ workflow: createEmptyWorkflow() }))

    handle('workflow.templates', async () => ({ items: templateSummaries() }))

    handle('workflow.template', async (args) => {
      const tpl = findTemplate(String(args && args.id || ''))
      return tpl ? { template: tpl } : { template: null }
    })

    // Export a workflow as a shareable, parameterized template (JSON string).
    handle('workflow.export', async (args) => {
      const id = String(args && args.id || '')
      const def = store.get(id)
      if (!def) throw new Error(`workflow.export: no workflow "${id}"`)
      const exported = {
        format: 'dsh-workflow',
        formatVersion: 1,
        exportedAt: Date.now(),
        workflow: {
          name: def.name,
          description: def.description,
          trigger: def.trigger,
          target: def.target,
          steps: def.steps,
          parameters: def.parameters,
          approval: def.approval,
          verify: def.verify,
          output: def.output
        }
      }
      return { json: JSON.stringify(exported, null, 2) }
    })

    // Import a shared workflow template (JSON string from workflow.export).
    handle('workflow.import', async (args) => {
      const json = String(args && args.json || '')
      let parsed
      try { parsed = JSON.parse(json) } catch { throw new Error('workflow.import: invalid JSON') }
      const w = parsed && parsed.format === 'dsh-workflow' ? parsed.workflow : parsed
      if (!w || typeof w !== 'object' || !Array.isArray(w.steps)) throw new Error('workflow.import: not a workflow definition')
      const saved = await store.save({
        ...w,
        name: String(args && args.name || w.name || '导入的工作流'),
        description: String(w.description || ''),
        trigger: w.trigger || { kind: 'manual' },
        target: w.target || { urlPattern: '*' },
        parameters: w.parameters || [],
        approval: w.approval || { confirmOn: ['write', 'batch'], sampleBeforeBatch: true },
        verify: w.verify || { successCriteria: [], retry: { maxAttempts: 1, onFailure: 'ask-user' } },
        output: w.output || { saveScreenshots: false, collectTo: 'workspace' }
      })
      syncSkill(saved)
      return { workflow: saved }
    })

    handle('workflow.run', async (args) => {
      // Executor is mounted separately (executor.js); this method is the
      // entry point the panel calls. The executor registers itself with the
      // run coordinator when it mounts; here we dispatch through it.
      const runner = runCoordinator
      if (!runner) throw new Error('workflow.run: executor not mounted')
      const id = String(args && args.id || '')
      const def = store.get(id)
      if (!def) throw new Error(`workflow.run: no workflow "${id}"`)
      return runner(def, args || {})
    })

    disposers.push(() => {
      for (const m of ['workflow.list', 'workflow.get', 'workflow.save', 'workflow.remove', 'workflow.empty', 'workflow.run', 'workflow.templates', 'workflow.template', 'workflow.export', 'workflow.import', 'workflow.explore.start', 'workflow.explore.act', 'workflow.explore.extract', 'workflow.explore.ask', 'workflow.explore.check', 'workflow.explore.finish']) {
        try { harness.unhandle(m) } catch { /* ignore */ }
      }
    })
  }

  // ── slash commands (/workflows, /run <name>) ───────────────────────────────
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    try {
      const d1 = commands.register({
        name: 'workflows',
        description: 'List saved workflows',
        handler: async (agent) => {
          const list = store.list()
          const text = list.length === 0
            ? '还没有保存的工作流。'
            : list.map((w) => `- ${w.name} (${w.id.slice(0, 8)})${w.steps.length ? `, ${w.steps.length} 步` : ''}`).join('\n')
          return { success: true, text }
        }
      })
      disposers.push(d1)
    } catch (err) {
      log(`workflow command /workflows failed to register: ${err.message}`)
    }

    // /run <name-or-id> — run a saved workflow by name or id.
    try {
      const d2 = commands.register({
        name: 'run',
        description: 'Run a saved workflow by name or id. Usage: /run <工作流名>',
        input: { hint: '<工作流名或ID>' },
        handler: async (agent, line) => {
          const query = (line || '').trim()
          const list = store.list()
          const match = query
            ? list.find((w) => w.name === query || w.id === query || w.id.startsWith(query))
            : list[0]
          if (!match) {
            return { success: false, text: query ? `没有找到工作流「${query}」。用 /workflows 查看。` : '还没有工作流。' }
          }
          if (!runCoordinator) return { success: false, text: '工作流执行器未挂载' }
          try {
            const r = await runCoordinator(match, { params: {} })
            const steps = (r.stepResults || []).length
            return { success: r.ok === true, text: r.ok === true ? `✓ 工作流「${match.name}」运行完成（${steps} 步）` : `✗ 失败：${r.error || 'unknown'}` }
          } catch (err) {
            return { success: false, text: `运行失败：${err.message}` }
          }
        }
      })
      disposers.push(d2)
    } catch (err) {
      log(`workflow command /run failed to register: ${err.message}`)
    }
  }

  // ── run coordinator (executor mounts itself here) ──────────────────────────
  let runCoordinator = null
  let executor = null

  // Mount the executor when a bridge is provided (opts.bridge).
  if (opts.bridge) {
    const { createWorkflowEngine } = await import('./executor.js')
    executor = createWorkflowEngine(
      { bridge: opts.bridge, store, ctxServices: opts.ctxServices || {} },
      { log, onEvent: (ev) => { try { opts.onEvent && opts.onEvent(ev) } catch {} } }
    )
    runCoordinator = (def, args) => executor.run(def, args)
    log('workflow executor mounted')
  }

  const api = {
    /** Executor registers its run dispatcher. */
    setRunner(fn) { runCoordinator = fn },
    getRunner() { return runCoordinator },
    getExecutor() { return executor },
    getExploreSession: () => (exploreApi ? exploreApi.session : null),
    store,
    isInMemory: inMemory
  }

  // ── lightweight scheduler for trigger.kind === 'schedule' ───────────────────
  // Polls every 30s for scheduled workflows whose interval has elapsed since
  // the last run, and dispatches them through the executor. (The DSH `schedule`
  // service is session-local; this in-plugin timer gives real periodic runs.)
  const lastRunAt = new Map() // workflowId -> last run ts
  let schedulerDispose = null
  if (executor) {
    const timer = ctx.get('timer')
    if (timer !== undefined && typeof timer.interval === 'function') {
      schedulerDispose = timer.interval(() => {
        const now = Date.now()
        for (const w of store.list()) {
          const trig = w.trigger
          if (!trig || trig.kind !== 'schedule') continue
          const every = trig.schedule && trig.schedule.everySeconds
          if (!every || every < 60) continue
          const last = lastRunAt.get(w.id) || w.updatedAt || 0
          if (now - last >= every * 1000) {
            lastRunAt.set(w.id, now)
            log(`scheduled run: "${w.name}" (every ${every}s)`)
            if (runCoordinator) {
              runCoordinator(w, { params: {}, scheduled: true })
                .catch((err) => log(`scheduled run "${w.name}" failed: ${err.message}`))
            }
          }
        }
      }, 30000)
      log('workflow scheduler active (30s tick)')
    }
  }

  disposers.push(() => {
    if (schedulerDispose) { try { schedulerDispose() } catch { /* already disposed */ } }
    for (const d of skillDisposers.values()) { try { d() } catch { /* already disposed */ } }
    skillDisposers.clear()
    try { store.close() } catch { /* already closed */ }
  })

  return { dispose: () => { for (const d of disposers) { try { d() } catch {} } }, ...api }
}
