/**
 * panel.js — the DSH Browser Client chat panel.
 *
 * Runs inside the extension's panel.html iframe (chrome-extension:// origin).
 * Talks to the host through DshClient (common/dsh-client.js), and to the
 * page's content script via postMessage (page URL sync).
 *
 * Core flow:
 *  1. Load config (baseUrl, token, current page dir) from background.
 *  2. Health-check the host; connect the mux event stream.
 *  3. Auto-bind the current page's directory as the workspace:
 *       workspace.create({path}) → session.create({workspaceId}) →
 *       load history → subscribe events.
 *  4. Render sessions + messages; send prompts; fold tool events.
 */
(function () {
  'use strict'

  // ── element refs ──
  const $ = (id) => document.getElementById(id)
  const els = {
    connStatus: $('conn-status'),
    wsPath: $('ws-path'),
    btnBind: $('btn-bind'),
    sessionList: $('session-list'),
    btnNewSession: $('btn-new-session'),
    messages: $('messages'),
    input: $('input'),
    btnSend: $('btn-send'),
    btnCancel: $('btn-cancel'),
    settings: $('settings'),
    setBase: $('set-base'),
    setToken: $('set-token'),
    setDir: $('set-dir'),
    btnSave: $('btn-save'),
    btnCloseSettings: $('btn-close-settings'),
    btnSettings: $('btn-settings'),
    btnCollapse: $('btn-collapse'),
    // workflow view
    tabs: $('tabs'),
    tabChat: $('tab-chat'),
    tabWorkflows: $('tab-workflows'),
    main: $('main'),
    workflowsView: $('workflows-view'),
    wfList: $('wf-list'),
    wfTemplates: $('wf-templates'),
    btnWfRefresh: $('btn-wf-refresh'),
    btnWfTemplate: $('btn-wf-template'),
    wfProgress: $('wf-progress')
  }

  // ── state ──
  const state = {
    client: null,
    config: null,
    pageUrl: null,
    pageTitle: '',
    workspace: null,     // { workspaceId, path, title }
    sessionId: null,     // active session id
    sessions: [],        // [{sessionId, cwd, title, updatedAt, running}]
    messages: [],        // rendered messages [{role, text, time, ...}]
    busy: false,
    wsStream: null,      // mux unsubscribe fn
    pendingApprovals: new Map(),
    workflows: [],       // saved workflows
    wfTemplates: [],     // scenario templates
    wfRunning: null      // current run status
  }

  // ── boot ──
  async function boot() {
    bindEvents()
    listenPageUrl()
    await loadConfig()
  }

  function bindEvents() {
    els.btnSend.addEventListener('click', sendPrompt)
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendPrompt()
      }
    })
    els.btnCancel.addEventListener('click', cancelTurn)
    els.btnNewSession.addEventListener('click', createNewSession)
    els.btnBind.addEventListener('click', bindWorkspace)
    els.btnSettings.addEventListener('click', () => { fillSettings(); els.settings.hidden = false })
    els.btnCloseSettings.addEventListener('click', () => { els.settings.hidden = true })
    els.btnSave.addEventListener('click', saveSettings)
    els.btnCollapse.addEventListener('click', () => {
      // Tell content script to collapse via postMessage → it closes the panel
      parent.postMessage({ type: 'dsh:collapse' }, '*')
    })
    // Enter on settings inputs
    ;[els.setBase, els.setToken, els.setDir].forEach((el) => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings() })
    })
    // workflow view
    els.tabChat.addEventListener('click', () => switchTab('chat'))
    els.tabWorkflows.addEventListener('click', () => switchTab('workflows'))
    els.btnWfRefresh.addEventListener('click', refreshWorkflows)
    els.btnWfTemplate.addEventListener('click', () => showTemplatePicker())
  }

  // ── workflow view ───────────────────────────────────────────────────────────
  function switchTab(which) {
    const isWf = which === 'workflows'
    els.tabChat.classList.toggle('active', !isWf)
    els.tabWorkflows.classList.toggle('active', isWf)
    els.main.hidden = isWf
    els.workflowsView.hidden = !isWf
    if (isWf) {
      refreshWorkflows()
      refreshTemplates()
    }
  }

  async function refreshWorkflows() {
    if (!state.client) return
    try {
      const r = await state.client.call('workflow.list', {})
      state.workflows = (r && r.items) || []
      renderWorkflowList()
    } catch (err) {
      setStatus('加载工作流失败: ' + err.message, true)
    }
  }

  function renderWorkflowList() {
    els.wfList.innerHTML = ''
    if (state.workflows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'wf-empty'
      empty.textContent = '还没有保存的工作流。用对话创建，或从下面的场景模板开始。'
      els.wfList.appendChild(empty)
      return
    }
    for (const w of state.workflows) {
      const item = document.createElement('div')
      item.className = 'wf-item'
      const head = document.createElement('div')
      head.className = 'wf-item-head'
      const title = document.createElement('span')
      title.className = 'wf-title'
      title.textContent = w.name
      const meta = document.createElement('span')
      meta.className = 'wf-meta'
      meta.textContent = `${w.steps.length} 步 · ${w.trigger.kind === 'schedule' ? '定时' : '手动'}`
      head.appendChild(title)
      head.appendChild(meta)
      const desc = document.createElement('div')
      desc.className = 'wf-desc'
      desc.textContent = w.description || ''
      const actions = document.createElement('div')
      actions.className = 'wf-actions'
      const runBtn = document.createElement('button')
      runBtn.className = 'wf-run'
      runBtn.textContent = '▶ 运行'
      runBtn.addEventListener('click', () => runWorkflow(w.id))
      const delBtn = document.createElement('button')
      delBtn.className = 'wf-del'
      delBtn.textContent = '删除'
      delBtn.addEventListener('click', async () => {
        await state.client.call('workflow.remove', { id: w.id })
        refreshWorkflows()
      })
      actions.appendChild(runBtn)
      actions.appendChild(delBtn)
      item.appendChild(head)
      item.appendChild(desc)
      item.appendChild(actions)
      els.wfList.appendChild(item)
    }
  }

  async function refreshTemplates() {
    if (!state.client) return
    try {
      const r = await state.client.call('workflow.templates', {})
      state.wfTemplates = (r && r.items) || []
      renderTemplates()
    } catch { /* templates optional */ }
  }

  function renderTemplates() {
    els.wfTemplates.innerHTML = ''
    for (const t of state.wfTemplates) {
      const item = document.createElement('div')
      item.className = 'wf-tpl'
      const name = document.createElement('div')
      name.className = 'wf-tpl-name'
      name.textContent = t.name
      const desc = document.createElement('div')
      desc.className = 'wf-tpl-desc'
      desc.textContent = t.description
      const use = document.createElement('button')
      use.className = 'wf-tpl-use'
      use.textContent = '使用'
      use.addEventListener('click', () => useTemplate(t.id))
      item.appendChild(name)
      item.appendChild(desc)
      item.appendChild(use)
      els.wfTemplates.appendChild(item)
    }
  }

  async function useTemplate(id) {
    if (!state.client) return
    try {
      const r = await state.client.call('workflow.template', { id })
      const tpl = r && r.template
      if (!tpl) throw new Error('template not found')
      // Ask the user to fill in the slots via a dialog.
      const answers = {}
      for (const slot of tpl.slots) {
        const answer = await showAskDialog(slot.name, slot.hint || '', slot.type === 'select' ? (slot.options || []) : [])
        answers[slot.name] = answer
      }
      setStatus(`模板「${tpl.name}」已选，请告诉 LLM 生成工作流`, false)
      // Switch to chat and prefill a prompt describing the template use.
      switchTab('chat')
      els.input.value = `帮我创建一个「${tpl.name}」工作流。需求：${Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join('；')}。请用 workflow_generate 工具生成并保存。`
      els.input.focus()
    } catch (err) {
      setStatus('模板使用失败: ' + err.message, true)
    }
  }

  async function runWorkflow(id) {
    if (!state.client) return
    try {
      els.wfProgress.hidden = false
      els.wfProgress.textContent = '运行中…'
      state.wfRunning = id
      const r = await state.client.call('workflow.run', { id, params: {} })
      els.wfProgress.hidden = false
      const ok = r && r.ok
      const stepCount = (r && r.stepResults && r.stepResults.length) || 0
      els.wfProgress.textContent = ok
        ? `✓ 完成：${stepCount} 步执行成功（${(r.durationMs || 0) / 1000}s）`
        : `✗ 失败：${(r && r.error) || 'unknown'}`
      els.wfProgress.className = 'wf-progress ' + (ok ? 'ok' : 'fail')
      state.wfRunning = null
      setTimeout(() => { els.wfProgress.hidden = true }, 8000)
    } catch (err) {
      els.wfProgress.hidden = false
      els.wfProgress.textContent = '✗ 运行失败: ' + err.message
      els.wfProgress.className = 'wf-progress fail'
      state.wfRunning = null
      setTimeout(() => { els.wfProgress.hidden = true }, 8000)
    }
  }

  function showTemplatePicker() {
    if (!state.client) return
    // Simple: list templates in an ask dialog and let the user pick by number.
    const labels = state.wfTemplates.map((t, i) => `${i + 1}. ${t.name}`)
    showAskDialog('选择场景模板', labels.join('\n'), state.wfTemplates.map((t) => t.name)).then((answer) => {
      const idx = state.wfTemplates.findIndex((t) => t.name === answer)
      if (idx !== -1) useTemplate(state.wfTemplates[idx].id)
    })
  }

  function listenPageUrl() {
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'dsh:page-url') {
        state.pageUrl = e.data.url
        state.pageTitle = e.data.title || ''
        // Page changed → re-resolve workspace
        resolveAndBind()
      }
    })
    // Ping content script for initial URL
    parent.postMessage({ type: 'dsh:ping' }, '*')
  }

  // ── config ──
  async function loadConfig() {
    try {
      const cfg = await chrome.runtime.sendMessage({ type: 'dsh:get-config' })
      state.config = cfg
      els.setBase.value = cfg.baseUrl
      els.setToken.value = cfg.token
      els.setDir.value = cfg.dirHint || ''
      await connect()
    } catch (err) {
      setStatus('配置错误: ' + err.message, true)
    }
  }

  function setStatus(text, isError) {
    els.connStatus.textContent = text
    els.connStatus.style.color = isError ? '#dc2626' : '#6b7280'
  }

  async function connect() {
    if (!state.config) return
    const { baseUrl, token } = state.config
    if (!token) {
      setStatus('未配置 Token', true)
      return
    }
    try {
      state.client = new DshClient({ baseUrl, token })
      const h = await state.client.health()
      setStatus(`已连接 ${baseUrl} (${h.tokenPrefix})`)
      await state.client.openMux()
      state.wsStream = state.client.onMux(handleMuxFrame)
      // Open the bidirectional control channel: host pushes page tool
      // requests down; we forward them to the page and reply with results.
      await state.client.openControl()
      state.unsubToolReq = state.client.onToolRequest(handleToolRequest)
      state.unsubAskReq = state.client.onAskRequest(handleAskRequest)
      state.client.onControlStatus((s) => {
        if (s === 'connected') {
          // Announce the current tab so the host knows where to operate.
          state.client.sendControlStatus('connected', getCurrentTabInfo())
        }
      })
      state.client.sendControlStatus('connected', getCurrentTabInfo())
      resolveAndBind()
    } catch (err) {
      setStatus('连接失败: ' + err.message, true)
    }
  }

  function getCurrentTabInfo() {
    return { url: state.pageUrl || location.href, title: state.pageTitle || document.title }
  }

  /**
   * Forward a host tool request to the page's content script and send the
   * result back over the control channel.
   */
  async function handleToolRequest(msg) {
    const { requestId, tool, args } = msg
    try {
      // Prefer the tab matching the page URL the panel is bound to; fall back
      // to the active tab. (active+currentWindow is unreliable from an iframe
      // because the panel's own window is the extension page.)
      let tab = null
      if (state.pageUrl) {
        const byUrl = await chrome.tabs.query({})
        tab = (byUrl || []).find((t) => t.url === state.pageUrl && t.id) || null
      }
      if (!tab) {
        const active = await chrome.tabs.query({ active: true, currentWindow: true })
        tab = active && active[0]
      }
      if (!tab || !tab.id) throw new Error('no target tab')
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'dsh:tool', requestId, tool, args })
      if (!res) throw new Error('content script did not respond (page may need reload)')
      if (res.ok) {
        state.client.respondTool(requestId, true, res.result)
      } else {
        state.client.respondTool(requestId, false, res.error)
      }
    } catch (err) {
      state.client.respondTool(requestId, false, { code: 'forward-error', message: String(err && err.message || err) })
    }
  }

  /**
   * Handle a user-ask request from the host (workflow confirmations / questions).
   * Shows a modal dialog with the question and options; replies with the
   * selected answer or custom text.
   */
  async function handleAskRequest(msg) {
    const { requestId, question, detail, options } = msg
    try {
      const answer = await showAskDialog(question, detail || '', options || [])
      state.client.respondAsk(requestId, answer)
    } catch (err) {
      // User dismissed — answer with the first option if any, else "取消".
      state.client.respondAsk(requestId, (options && options[0]) || '取消')
    }
  }

  /** Show a confirmation dialog; resolves with the chosen answer. */
  function showAskDialog(question, detail, options) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'ask-overlay'
      const card = document.createElement('div')
      card.className = 'ask-card'
      const q = document.createElement('div')
      q.className = 'ask-question'
      q.textContent = question
      card.appendChild(q)
      if (detail) {
        const d = document.createElement('div')
        d.className = 'ask-detail'
        d.textContent = detail
        card.appendChild(d)
      }
      const btns = document.createElement('div')
      btns.className = 'ask-buttons'
      const opts = options.length > 0 ? options : ['确认', '取消']
      opts.forEach((label) => {
        const b = document.createElement('button')
        b.textContent = label
        b.className = 'ask-btn' + (label === '取消' || /取消|停止|no/i.test(label) ? ' secondary' : '')
        b.addEventListener('click', () => {
          overlay.remove()
          resolve(label)
        })
        btns.appendChild(b)
      })
      // Custom input for free-form answers.
      const input = document.createElement('input')
      input.className = 'ask-input'
      input.placeholder = '或输入自定义回答…'
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          overlay.remove()
          resolve(input.value.trim())
        }
      })
      const inputRow = document.createElement('div')
      inputRow.className = 'ask-input-row'
      inputRow.appendChild(input)
      card.appendChild(btns)
      card.appendChild(inputRow)
      overlay.appendChild(card)
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve('取消') } })
      document.body.appendChild(overlay)
      input.focus()
    })
  }

  // ── workspace binding ──
  async function resolveAndBind() {
    if (!state.client || !state.pageUrl) return
    // Ask background for the mapped dir; fall back to config.dirHint
    let dir = null
    try {
      const r = await chrome.runtime.sendMessage({ type: 'dsh:resolve-dir', url: state.pageUrl })
      if (r && r.dir) dir = r.dir
    } catch {}
    if (!dir) dir = state.config.dirHint
    if (!dir) {
      els.wsPath.textContent = '未绑定（设置中填写目录）'
      els.btnBind.hidden = false
      return
    }
    els.btnBind.hidden = true
    els.wsPath.textContent = dir
    await bindWorkspace(dir)
  }

  async function bindWorkspace(dir) {
    if (!state.client) return
    if (dir === undefined) dir = els.setDir.value.trim() || null
    if (!dir) {
      els.wsPath.textContent = '未绑定'
      return
    }
    try {
      setStatus('绑定工作区…')
      // 1. Adopt the directory as a workspace (idempotent)
      const { workspace, created } = await state.client.call('workspace.create', { path: dir })
      state.workspace = workspace
      els.wsPath.textContent = workspace.path
      setStatus(created ? `工作区已创建 ${workspace.path}` : `工作区 ${workspace.path}`)
      // 2. List sessions to pick/reuse one for this workspace
      await refreshSessions()
      // 3. Auto-open: reuse the first session of this workspace, else create one
      const wsSessions = state.sessions.filter((s) => s.cwd && normPath(s.cwd) === normPath(workspace.path))
      if (wsSessions.length > 0) {
        openSession(wsSessions[0].sessionId)
      } else {
        const r = await state.client.call('session.create', { workspaceId: workspace.workspaceId })
        await refreshSessions()
        openSession(r.sessionId)
      }
    } catch (err) {
      setStatus('绑定失败: ' + err.message, true)
      console.error('[dsh-panel] bindWorkspace error', err)
    }
  }

  function normPath(p) {
    // macOS /private symlink tolerance
    return String(p || '').replace(/^\/private/, '')
  }

  // ── sessions ──
  async function refreshSessions() {
    if (!state.client) return
    try {
      const { items } = await state.client.call('session.list', {})
      state.sessions = items || []
      renderSessions()
    } catch (err) {
      console.error('[dsh-panel] refreshSessions error', err)
    }
  }

  function renderSessions() {
    els.sessionList.innerHTML = ''
    const wsPath = state.workspace ? normPath(state.workspace.path) : null
    for (const s of state.sessions) {
      const item = document.createElement('div')
      item.className = 'session-item' + (s.sessionId === state.sessionId ? ' active' : '')
      const projTitle = s.projections && s.projections.values && s.projections.values.title
      const title = projTitle || s.cwd || s.sessionId
      item.innerHTML = `<span class="s-title">${esc(title)}</span><span class="s-meta">${s.running ? '● 运行中' : ''}</span>`
      item.addEventListener('click', () => openSession(s.sessionId))
      els.sessionList.appendChild(item)
    }
  }

  async function createNewSession() {
    if (!state.client || !state.workspace) return
    try {
      const r = await state.client.call('session.create', { workspaceId: state.workspace.workspaceId })
      await refreshSessions()
      openSession(r.sessionId)
    } catch (err) {
      setStatus('新会话失败: ' + err.message, true)
    }
  }

  async function openSession(sessionId) {
    state.sessionId = sessionId
    state.messages = []
    renderMessages()
    renderSessions()
    try {
      const page = await state.client.call('session.history', { sessionId, maxMessages: 50 })
      state.messages = foldHistory(page.events || [])
      renderMessages()
      scrollBottom()
    } catch (err) {
      addMessage('error', '读取历史失败: ' + err.message)
    }
  }

  // ── mux event handling ──
  function handleMuxFrame(frame) {
    switch (frame.type) {
      case 'session/event':
        handleSessionEvent(frame.sessionId, frame.event)
        break
      case 'session/queue':
        break
      case 'approval/requested':
        setStatus(`⚠ 需要审批: ${frame.toolName}`)
        break
      case 'approval/resolved':
        setStatus('审批完成')
        break
      case 'question/requested':
        setStatus('⚠ 有新问题')
        break
      default:
        break
    }
  }

  function handleSessionEvent(sessionId, event) {
    if (sessionId !== state.sessionId) return
    const t = event.type
    const d = event.data || {}
    if (t === 'user/message' || t === 'assistant/message') {
      const text = extractText(d)
      if (text) {
        addMessage(t === 'user/message' ? 'user' : 'assistant', text, event.time)
        scrollBottom()
      }
    } else if (t === 'assistant/chunk') {
      const chunk = d.chunk || {}
      if (chunk.type === 'text' || (chunk.type === undefined && chunk.text)) {
        const text = chunk.text || ''
        if (text) appendStreaming(text)
      } else if (chunk.type === 'finish') {
        // turn completion; error surfaced on turn/end
        const reason = chunk.reason || {}
        if (reason.kind === 'error') {
          addMessage('error', '模型错误: ' + (reason.failure && reason.failure.message || reason.message || 'unknown'))
        }
      }
    } else if (t === 'turn/start') {
      state.busy = true
      els.btnCancel.hidden = false
      notifyBusy(true)
      scrollBottom()
    } else if (t === 'turn/end') {
      state.busy = false
      els.btnCancel.hidden = true
      notifyBusy(false)
      const reason = d.reason || {}
      if (reason.kind === 'error') {
        addMessage('error', '回合错误: ' + (reason.error && reason.error.message || reason.message || 'unknown'))
      }
    } else if (t === 'tool/call' || t === 'tool/result') {
      addToolEvent(event)
      updateExploreBanner(event)
      scrollBottom()
    } else if (t === 'session/title') {
      refreshSessions()
    }
  }

  /** Show/hide the exploration banner based on explore_* tool activity. */
  function updateExploreBanner(event) {
    const els2 = {
      banner: document.getElementById('explore-banner'),
      text: document.getElementById('explore-text')
    }
    if (!els2.banner) return
    const d = event.data || {}
    if (event.type === 'tool/call') {
      const name = d.name || (d.call && d.call.name) || ''
      if (name.startsWith('explore_')) {
        els2.banner.hidden = false
        if (name === 'explore_start') els2.text.textContent = '🧭 探索开始：正在尝试完成你的目标…'
        else if (name === 'explore_act') els2.text.textContent = '🔍 正在页面操作：' + (extractArgText(d.args || (d.call && d.call.arguments) || {}))
        else if (name === 'explore_check') els2.text.textContent = '✅ 正在检查目标是否达成…'
        else if (name === 'explore_ask') els2.text.textContent = '🙋 需要你回答一个问题…'
        else if (name === 'explore_finish') els2.text.textContent = '🎉 探索完成，正在提炼工作流…'
      }
    } else if (event.type === 'tool/result') {
      const name = (d.call && d.call.name) || (d.name) || ''
      if (name === 'explore_finish') {
        els2.banner.hidden = true
      }
    }
  }

  function extractArgText(args) {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args
      return (a.textAnchor || a.action || a.selector || JSON.stringify(a).slice(0, 40) || '').slice(0, 40)
    } catch { return '' }
  }

  function extractText(data) {
    const content = data && data.content || []
    return content
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('')
  }

  function addToolEvent(event) {
    const d = event.data || {}
    if (event.type === 'tool/call') {
      const name = d.name || (d.call && d.call.name) || 'tool'
      const args = d.args || (d.call && d.call.arguments) || {}
      let argText = ''
      try { argText = typeof args === 'string' ? args : JSON.stringify(args).slice(0, 200) } catch {}
      addMessage('tool', `🛠 ${name}\n${argText}`)
    } else if (event.type === 'tool/result') {
      const result = d.result || (d.response && d.response.value) || {}
      let resultText = ''
      try { resultText = typeof result === 'string' ? result : JSON.stringify(result).slice(0, 300) } catch {}
      addMessage('tool', `✓ 结果\n${resultText}`)
    }
  }

  // ── messages ──
  function addMessage(role, text, time) {
    state.messages.push({ role, text, time: time ? new Date(time).toLocaleTimeString() : new Date().toLocaleTimeString() })
    renderMessages()
  }

  function appendStreaming(text) {
    const last = state.messages[state.messages.length - 1]
    if (last && last.role === 'assistant') {
      last.text += text
    } else {
      state.messages.push({ role: 'assistant', text, time: new Date().toLocaleTimeString() })
    }
    renderMessages()
    scrollBottom()
  }

  function renderMessages() {
    els.messages.innerHTML = ''
    for (const m of state.messages) {
      const div = document.createElement('div')
      div.className = 'msg ' + m.role
      div.textContent = m.text
      const time = document.createElement('span')
      time.className = 'msg-time'
      time.textContent = m.time
      div.appendChild(time)
      els.messages.appendChild(div)
    }
  }

  function scrollBottom() {
    els.messages.scrollTop = els.messages.scrollHeight
  }

  // ── history folding ──
  function foldHistory(events) {
    const out = []
    for (const { event } of events) {
      const t = event.type
      const d = event.data || {}
      if (t === 'user/message') {
        const text = extractText(d)
        if (text) out.push({ role: 'user', text, time: fmt(event.time) })
      } else if (t === 'assistant/message') {
        const text = extractText(d)
        if (text) out.push({ role: 'assistant', text, time: fmt(event.time) })
      } else if (t === 'assistant/chunk') {
        const chunk = d.chunk || {}
        if (chunk.type === 'text' || (chunk.text !== undefined)) {
          const text = chunk.text || ''
          const last = out[out.length - 1]
          if (last && last.role === 'assistant') last.text += text
          else if (text) out.push({ role: 'assistant', text, time: fmt(event.time) })
        }
      } else if (t === 'tool/call' || t === 'tool/result') {
        // folded lightly
      }
    }
    return out
  }

  function fmt(ts) {
    if (!ts) return ''
    try { return new Date(ts).toLocaleTimeString() } catch { return '' }
  }

  // ── prompt ──
  async function sendPrompt() {
    const text = els.input.value.trim()
    if (!text || !state.client || !state.sessionId) {
      if (!state.sessionId) setStatus('请先绑定工作区', true)
      return
    }
    els.input.value = ''
    addMessage('user', text)
    scrollBottom()
    try {
      const r = await state.client.call('session.prompt', {
        sessionId: state.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
      if (r && r.command) {
        addMessage('tool', `命令: ${r.command.text || 'ok'}`)
      }
    } catch (err) {
      addMessage('error', '发送失败: ' + err.message)
    }
  }

  async function cancelTurn() {
    if (!state.sessionId || !state.client) return
    try {
      await state.client.call('session.cancel', { sessionId: state.sessionId })
    } catch (err) {
      console.error('[dsh-panel] cancel error', err)
    }
  }

  function notifyBusy(busy) {
    parent.postMessage({ type: 'dsh:busy', busy }, '*')
  }

  // ── settings ──
  function fillSettings() {
    els.setBase.value = state.config ? state.config.baseUrl : ''
    els.setToken.value = state.config ? state.config.token : ''
    els.setDir.value = state.config ? (state.config.dirHint || '') : ''
  }

  async function saveSettings() {
    const patch = {
      baseUrl: els.setBase.value.trim(),
      token: els.setToken.value.trim(),
      dirHint: els.setDir.value.trim()
    }
    try {
      const cfg = await chrome.runtime.sendMessage({ type: 'dsh:set-config', patch })
      state.config = cfg
      els.settings.hidden = true
      // Reconnect with the new config
      if (state.client) {
        if (state.unsubToolReq) state.unsubToolReq()
        state.client.close()
      }
      await connect()
    } catch (err) {
      setStatus('保存失败: ' + err.message, true)
    }
  }

  // ── utils ──
  function esc(s) {
    const d = document.createElement('div')
    d.textContent = String(s == null ? '' : s)
    return d.innerHTML
  }

  boot()
})()
