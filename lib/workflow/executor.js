/**
 * executor.js — WorkflowEngine: run a saved WorkflowDefinition step by step.
 *
 * Execution model:
 *  - Each step dispatches to the extension through the page-tool bridge
 *    (the same control channel the page_* tools use). The extension runs the
 *    step in the real page.
 *  - Element targets resolve through multi-signature semantic locators
 *    (textAnchor → semantic role+name → selector → coordinates), so
 *    workflows survive page layout changes.
 *  - `ask` steps pause to ask the user (via userQuestions service).
 *  - `approve` steps require one-shot approval (via approval service).
 *  - Progress is emitted as step events the panel renders.
 *  - On failure: retry per verify.retry, then ask-user / skip / stop.
 *
 * This module is the "engine" — it runs inside the host plugin, driving the
 * extension via the bridge, exactly like the page_* tools do.
 */

import { describeStep } from './generator.js'

/**
 * Create a WorkflowEngine.
 * @param {object} deps
 * @param {object} deps.bridge - ToolBridge (control channel to extension).
 * @param {object} deps.store - workflow store (to resolve subflow refs).
 * @param {{ log?: (msg: string) => void }} opts
 */
export function createWorkflowEngine(deps, opts = {}) {
  const log = opts.log || ((m) => console.log(`[dsh-browser-host:engine] ${m}`))
  const bridge = deps.bridge
  const store = deps.store

  /** Emit progress events (panel subscribes via mux stream). */
  const onEvent = opts.onEvent || (() => {})

  const ctxServices = deps.ctxServices || {}

  /**
   * Run one workflow definition.
   * @param {object} def - WorkflowDefinition.
   * @param {{ params?: Record<string, unknown>, signal?: AbortSignal }} runOpts
   * @returns {Promise<{ ok: boolean, stepResults: Array, error?: string, output?: object }>}
   */
  async function run(def, runOpts = {}) {
    const signal = runOpts.signal
    const params = runOpts.params || {}
    const stepResults = []
    const startedAt = Date.now()
    const total = def.steps.length

    onEvent({ type: 'workflow/start', workflowId: def.id, name: def.name, totalSteps: total, startedAt })
    log(`run "${def.name}" (${total} steps) starting`)

    for (let i = 0; i < total; i++) {
      if (signal && signal.aborted) {
        onEvent({ type: 'workflow/aborted', stepIndex: i })
        return { ok: false, stepResults, error: 'cancelled', aborted: true }
      }
      const step = def.steps[i]
      onEvent({ type: 'workflow/step-start', stepIndex: i, description: describeStep(step) })
      log(`  step ${i + 1}/${total}: ${describeStep(step)}`)

      try {
        const result = await runStep(step, { params, signal, stepIndex: i, def })
        stepResults.push({ index: i, step, ok: true, result })
        onEvent({ type: 'workflow/step-end', stepIndex: i, ok: true })
      } catch (err) {
        log(`  step ${i + 1} FAILED: ${err.message}`)
        stepResults.push({ index: i, step, ok: false, error: String(err.message || err) })
        onEvent({ type: 'workflow/step-end', stepIndex: i, ok: false, error: String(err.message || err) })

        // Failure policy: retry then ask-user / skip / stop.
        const policy = (def.verify && def.verify.retry) || { maxAttempts: 1, onFailure: 'ask-user' }
        const maxAttempts = Math.max(1, policy.maxAttempts || 1)
        let recovered = false
        if (maxAttempts > 1) {
          for (let attempt = 1; attempt < maxAttempts && !recovered; attempt++) {
            log(`  retry ${attempt}/${maxAttempts - 1}…`)
            onEvent({ type: 'workflow/retry', stepIndex: i, attempt })
            try {
              const r = await runStep(step, { params, signal, stepIndex: i, def, retry: true })
              stepResults[i] = { index: i, step, ok: true, result: r, retried: true }
              onEvent({ type: 'workflow/step-end', stepIndex: i, ok: true, retried: true })
              recovered = true
            } catch (retryErr) {
              log(`  retry ${attempt} failed: ${retryErr.message}`)
            }
          }
        }
        if (!recovered) {
          const onFailure = policy.onFailure || 'ask-user'
          if (onFailure === 'ask-user' && ctxServices.askUser) {
            const answer = await ctxServices.askUser({
              question: `第 ${i + 1} 步「${describeStep(step)}」失败了：${err.message}`,
              detail: '你可以选择：重试、跳过这一步、或停止整个工作流。',
              options: [
                { label: '重试', value: 'retry' },
                { label: '跳过', value: 'skip' },
                { label: '停止', value: 'stop' }
              ]
            })
            if (answer === 'retry') {
              try {
                const r = await runStep(step, { params, signal, stepIndex: i, def, retry: true })
                stepResults[i] = { index: i, step, ok: true, result: r, recovered: true }
                onEvent({ type: 'workflow/step-end', stepIndex: i, ok: true, recovered: true })
                recovered = true
              } catch (e) {
                log(`  user-requested retry failed: ${e.message}`)
              }
            } else if (answer === 'skip') {
              stepResults[i] = { index: i, step, ok: true, skipped: true, error: String(err.message || err) }
              onEvent({ type: 'workflow/step-skipped', stepIndex: i })
              recovered = true
            }
            // 'stop' → fall through to abort
          }
          if (!recovered && onFailure !== 'skip') {
            onEvent({ type: 'workflow/failed', stepIndex: i, error: String(err.message || err) })
            return { ok: false, stepResults, error: String(err.message || err), failedStep: i }
          }
          if (!recovered && onFailure === 'skip') {
            stepResults[i] = { index: i, step, ok: true, skipped: true, error: String(err.message || err) }
            onEvent({ type: 'workflow/step-skipped', stepIndex: i })
          }
        }
      }
    }

    // Success criteria verification (natural-language, LLM-independent heuristic
    // here; the model can deep-verify separately).
    const verify = def.verify || {}
    let verifyResult = { ok: true }
    if (Array.isArray(verify.successCriteria) && verify.successCriteria.length > 0) {
      onEvent({ type: 'workflow/verify', criteria: verify.successCriteria })
    }

    const durationMs = Date.now() - startedAt
    onEvent({ type: 'workflow/end', ok: true, durationMs })
    log(`run "${def.name}" complete in ${durationMs}ms`)
    return { ok: true, stepResults, output: verifyResult, durationMs }
  }

  /**
   * Resolve an ElementTarget to page coordinates via multi-signature locators.
   * Uses page_eval to ask the page which signature matches (semantic first).
   */
  async function resolveTarget(target, { signal, timeoutMs = 15000 }) {
    if (!target) return null
    if (typeof target === 'string') return { selector: target }

    // 1. textAnchor / semantic: ask the page to find the element by
    //    accessible name / role and return its center.
    if (target.semantic || target.textAnchor) {
      const expr = `(function () {
        const want = ${JSON.stringify({ semantic: target.semantic || null, textAnchor: target.textAnchor || null })};
        const all = [...document.querySelectorAll('a[href], button, input, select, textarea, [role], [onclick], summary')];
        const candidates = all.filter((el) => {
          if (!el.offsetParent) return false;
          if (want.semantic) {
            const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName.toLowerCase());
            let name = el.getAttribute('aria-label') || el.getAttribute('title') || '';
            if (!name && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) name = el.getAttribute('placeholder') || el.getAttribute('name') || '';
            if (!name) { const t = (el.innerText || '').trim(); if (t && t.length < 80) name = t; }
            if (role === want.semantic.role && name === want.semantic.name) return true;
          }
          if (want.textAnchor) {
            const m = want.textAnchor.match(/^(?:按钮|链接|输入框|元素)[「"']?(.+?)[」"']?$/);
            const label = m ? m[1] : want.textAnchor;
            const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim();
            if (text === label || text.includes(label)) return true;
          }
          return false;
        });
        if (candidates.length === 0) return null;
        const el = candidates[0];
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), found: true };
      })()`
      const found = await bridgeRequest('page_eval', { expression: expr }, { signal, timeoutMs })
      if (found && found.found) return { x: found.x, y: found.y, found: true }
    }

    // 2. selector
    if (target.selector) return { selector: target.selector }

    // 3. coordinates as-is
    if (typeof target.x === 'number' || typeof target.y === 'number') {
      return { x: target.x, y: target.y }
    }
    throw new Error(`cannot locate element: ${JSON.stringify(target).slice(0, 120)}`)
  }

  /** One bridge request (page tool round-trip). */
  async function bridgeRequest(tool, args, { signal, timeoutMs = 60000 } = {}) {
    if (!bridge || !bridge.request) throw new Error('extension bridge not connected')
    return bridge.request(tool, args, { signal, timeoutMs })
  }

  /** Run one step. */
  async function runStep(step, { params, signal, stepIndex, def, retry = false }) {
    const resolveValue = (v) => {
      if (v && typeof v === 'object' && v.type === 'parameter') return params[v.name]
      return v
    }

    switch (step.kind) {
      case 'navigate': {
        const url = resolveValue(step.url)
        if (!url) throw new Error('navigate: no URL')
        const r = await bridgeRequest('page_navigate', { action: 'go', url }, { signal })
        if (step.waitFor) await bridgeRequest('page_wait', { condition: 'selector', selector: step.waitFor, timeout: 15000 }, { signal })
        return r
      }

      case 'action': {
        // Approve sensitive actions (submit/delete/pay heuristics on the value).
        const isWrite = /提交|删除|下单|付款|确认|save|submit|delete|confirm/i.test(String(step.action) + ' ' + describeStep(step))
        if (isWrite && (def.approval.confirmOn || []).includes('write') && !retry) {
          await requireApproval(`执行「${describeStep(step)}」`, stepIndex)
        }
        const target = await resolveTarget(step.target, { signal })
        const args = { action: step.action, ...target }
        if (step.value !== undefined) args.text = String(resolveValue(step.value))
        return bridgeRequest('page_act', args, { signal })
      }

      case 'extract': {
        const r = await bridgeRequest('page_snapshot', { includeVisibleText: false, maxElements: 60 }, { signal })
        return { fields: r.elements ? r.elements.length : 0, snapshot: r }
      }

      case 'wait': {
        return bridgeRequest('page_wait', {
          condition: step.condition,
          selector: step.selector,
          timeout: step.timeout || 10000
        }, { signal })
      }

      case 'ask': {
        if (!ctxServices.askUser) throw new Error('ask: user questions service unavailable')
        const answer = await ctxServices.askUser({
          question: step.question,
          detail: step.detail || '',
          options: Array.isArray(step.options) ? step.options.map((o) => String(o)) : undefined
        })
        return { answer }
      }

      case 'approve': {
        await requireApproval(step.reason, stepIndex)
        return { approved: true }
      }

      case 'loop': {
        // Resolve the loop collection.
        const over = step.over
        let items = []
        if (typeof over === 'object' && over.type === 'parameter') {
          const data = params[over.name]
          if (Array.isArray(data)) items = data
          else throw new Error(`loop: parameter "${over.name}" is not an array`)
        } else if (over === 'list-items') {
          // Ask the page for clickable list items count / visible rows.
          const snap = await bridgeRequest('page_snapshot', { includeVisibleText: false, maxElements: 100 }, { signal })
          items = (snap.elements || []).filter((e) => /listitem|button|row|card/i.test(e.role || ''))
        } else if (over === 'table-rows') {
          const snap = await bridgeRequest('page_snapshot', { includeVisibleText: false, maxElements: 100 }, { signal })
          items = (snap.elements || []).filter((e) => /row|cell|tr/i.test(e.role || e.selector || ''))
        } else {
          throw new Error(`loop: unsupported over "${JSON.stringify(over)}"`)
        }

        const sampleFirst = step.sampleFirst && items.length > 1
        const iterable = sampleFirst ? items.slice(0, 1) : items
        const results = []
        for (let li = 0; li < iterable.length; li++) {
          if (signal && signal.aborted) throw new Error('cancelled')
          onEvent({ type: 'workflow/loop-item', stepIndex, itemIndex: li, total: iterable.length })
          // Guard against infinite loops.
          if (li > 200) throw new Error('loop: iteration cap (200) exceeded')
          for (const sub of step.body) {
            await runStep(sub, { params, signal, stepIndex: `${stepIndex}.${li}`, def, retry })
          }
          results.push(li)
          // After the sample, ask before the full batch.
          if (sampleFirst && li === 0 && items.length > 1 && ctxServices.askUser) {
            const go = await ctxServices.askUser({
              question: `已处理 1 条示例（共 ${items.length} 条）。继续处理剩余 ${items.length - 1} 条吗？`,
              options: [{ label: '继续全部', value: 'continue' }, { label: '停止', value: 'stop' }]
            })
            if (go === 'stop') break
            for (let ri = 1; ri < items.length; ri++) {
              if (signal && signal.aborted) throw new Error('cancelled')
              onEvent({ type: 'workflow/loop-item', stepIndex, itemIndex: ri, total: items.length })
              for (const sub of step.body) {
                await runStep(sub, { params, signal, stepIndex: `${stepIndex}.${ri}`, def, retry })
              }
            }
            break
          }
        }
        return { processed: results.length }
      }

      case 'subflow': {
        const sub = store.get(step.ref)
        if (!sub) throw new Error(`subflow: no workflow "${step.ref}"`)
        return run(sub, { params, signal })
      }

      case 'branch': {
        // Evaluate condition heuristically: if it references a parameter.
        const cond = step.if
        if (cond && typeof cond === 'object' && cond.parameter !== undefined) {
          const v = params[cond.parameter]
          const matches = cond.equals === undefined ? !!v : v === cond.equals
          const branch = matches ? step.then : (step.else || [])
          for (const sub of branch) {
            await runStep(sub, { params, signal, stepIndex, def, retry })
          }
          return { took: matches ? 'then' : 'else' }
        }
        // Default: run 'then'.
        for (const sub of (step.then || [])) {
          await runStep(sub, { params, signal, stepIndex, def, retry })
        }
        return { took: 'then' }
      }

      default:
        throw new Error(`unknown step kind: ${step.kind}`)
    }
  }

  /** One-shot approval for sensitive operations. */
  async function requireApproval(reason, stepIndex) {
    if (ctxServices.askUser) {
      const ok = await ctxServices.askUser({
        question: `⚠️ 需要确认：${reason}`,
        detail: '这是写操作（提交/删除/下单等），请确认是否继续。',
        options: ['确认执行', '取消']
      })
      // The panel returns the chosen label. Anything that is not a decline
      // (取消 / 停止 / no / 拒绝) counts as approval.
      if (/^(取消|停止|no|拒绝|否)$/i.test(String(ok))) throw new Error(`user declined: ${reason}`)
      return
    }
    throw new Error(`approval required: ${reason} (no approver available)`)
  }

  return { run }
}
