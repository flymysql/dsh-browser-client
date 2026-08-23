/**
 * page-tools.js — the page-side execution core for the DSH Browser Client.
 *
 * Loaded as a second content script in the ISOLATED world (per manifest
 * content_scripts entry), this module implements the actual page tools the
 * host registers:
 *
 *   page.snapshot  — structured page view (URL/title/visible text/elements)
 *   page.eval      — arbitrary JS in the MAIN world (injected <script>)
 *   page.act       — click/type/scroll/key/clear/hover (real events, coords or selector)
 *   page.navigate  — go/back/forward/reload
 *   page.wait      — wait for selector/network-idle/delay/load
 *   page.screenshot— viewport/element/full capture (via background captureVisibleTab)
 *
 * It listens on chrome.runtime.onMessage for { type: 'dsh:tool', ... } frames
 * routed from the panel (the panel receives tool-request frames from the host
 * over its control WebSocket and forwards them here). Results travel back via
 * sendResponse (async) to the panel, which replies over the control socket.
 *
 * MAIN-world eval: page.eval injects a <script> tag whose body is the user
 * expression; it runs in the page's own JS context where page globals
 * (React/Redux stores, fetch data, etc.) are visible. The result is marshalled
 * back through a temporary global.
 */
(function () {
  'use strict'
  if (window.__DSH_PAGE_TOOLS__) return
  window.__DSH_PAGE_TOOLS__ = true

  const MAX_SNAPSHOT_ELEMENTS = 80

  // ── utilities ──────────────────────────────────────────────────────────────

  /** Unique-ish id for a snapshot element. */
  function shortSelector(el) {
    if (!el || el.nodeType !== 1) return null
    if (el.id) return `#${CSS.escape(el.id)}`
    if (el.getAttribute && el.getAttribute('data-testid')) return `[data-testid="${CSS.escape(el.getAttribute('data-testid'))}"]`
    if (el.getAttribute && el.getAttribute('data-test')) return `[data-test="${CSS.escape(el.getAttribute('data-test'))}"]`
    const tag = el.tagName.toLowerCase()
    const cls = el.className && typeof el.className === 'string'
      ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).map((c) => CSS.escape(c)).join('.')
      : ''
    return cls ? `${tag}.${cls}` : tag
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  }

  function viewportRect() {
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
  }

  /** Center point of an element, clamped to viewport. */
  function elementCenter(el) {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth)),
      y: Math.round(Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight))
    }
  }

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[contenteditable="true"]',
    'summary', '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',')

  // ── page.snapshot ───────────────────────────────────────────────────────────

  function collectVisibleText() {
    // Grab body innerText but cap it — long pages produce huge strings.
    const text = document.body ? (document.body.innerText || '') : ''
    return text.slice(0, 20000)
  }

  function collectElements(max) {
    const out = []
    const nodes = document.querySelectorAll(INTERACTIVE_SELECTOR)
    for (const el of nodes) {
      if (out.length >= max) break
      if (!isVisible(el)) continue
      const r = el.getBoundingClientRect()
      const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName.toLowerCase())
      let label = ''
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        label = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || ''
      } else {
        label = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 120)
      }
      out.push({
        index: out.length,
        role,
        label,
        selector: shortSelector(el),
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        center: elementCenter(el)
      })
    }
    return out
  }

  function snapshot(args = {}) {
    const includeVisibleText = args.includeVisibleText !== false
    const max = Math.min(Number(args.maxElements) || MAX_SNAPSHOT_ELEMENTS, 200)
    return {
      url: location.href,
      title: document.title,
      language: document.documentElement.lang || '',
      readyState: document.readyState,
      viewport: viewportRect(),
      visibleText: includeVisibleText ? collectVisibleText() : null,
      elements: collectElements(max)
    }
  }

  // ── page.eval (MAIN world) ──────────────────────────────────────────────────

  /**
   * Evaluate `expression` in the page's MAIN world by injecting a <script>.
   * The expression is a function BODY; args are passed as $0, $1, ….
   * The result is JSON-serialized into window.__dshEvalResult by the injected
   * script; we poll for it, then clean up.
   */
  function evalInMainWorld(expression, args) {
    return new Promise((resolve, reject) => {
      const key = '__dshEval' + Date.now() + Math.random().toString(36).slice(2)
      const argJson = JSON.stringify(args || []).replace(/</g, '\\u003c')
      const body = `
        (function () {
          try {
            const fn = new Function('return (function(){ ' + ${JSON.stringify(expression)} + ' })')();
            const r = fn.apply(null, ${argJson});
            const v = (r !== undefined && typeof r.then === 'function') ? 'PROMISE' : r;
            window['${key}'] = { ok: true, value: JSON.parse(JSON.stringify(v)) };
          } catch (e) {
            window['${key}'] = { ok: false, error: String(e && e.stack || e) };
          }
        })();
      `
      const script = document.createElement('script')
      script.textContent = body
      script.onerror = () => reject(new Error('failed to inject eval script'))
      document.documentElement.appendChild(script)
      script.remove()
      // Poll for the result (main-world script writes it synchronously-ish)
      const deadline = Date.now() + 8000
      const poll = () => {
        const r = window[key]
        if (r) {
          delete window[key]
          if (r.ok) resolve(r.value)
          else reject(new Error(r.error))
          return
        }
        if (Date.now() > deadline) {
          reject(new Error('eval timed out waiting for MAIN-world result'))
          return
        }
        setTimeout(poll, 50)
      }
      poll()
    })
  }

  // ── page.act ────────────────────────────────────────────────────────────────

  function elementAt(x, y) {
    const el = document.elementFromPoint(x, y)
    // Walk up to a clickable ancestor if the hit is a text node / child.
    let cur = el
    while (cur && cur !== document.body) {
      if (cur.matches && cur.matches(INTERACTIVE_SELECTOR)) return cur
      cur = cur.parentElement
    }
    return el
  }

  function findElement(selector) {
    try { return document.querySelector(selector) } catch { return null }
  }

  function dispatchRealEvent(el, type, opts = {}) {
    const ev = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, ...opts
    })
    el.dispatchEvent(ev)
  }

  function focusAndType(el, text) {
    el.focus()
    // Set value directly then dispatch input/change for framework bindings.
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    // Also dispatch real keydown per char for robust frameworks? Keep light: input+change suffices for most.
  }

  async function act(args) {
    const { action } = args
    let el = null
    if (args.selector) el = findElement(args.selector)

    switch (action) {
      case 'click': {
        let target = el
        let x = args.x, y = args.y
        if (!target && x !== undefined && y !== undefined) target = elementAt(x, y)
        if (!target) throw new Error('click target not found')
        if (x === undefined || y === undefined) {
          const c = elementCenter(target)
          x = c.x; y = c.y
        }
        dispatchRealEvent(target, 'mousedown', { clientX: x, clientY: y })
        dispatchRealEvent(target, 'mouseup', { clientX: x, clientY: y })
        dispatchRealEvent(target, 'click', { clientX: x, clientY: y })
        break
      }
      case 'hover': {
        let target = el
        if (!target && args.x !== undefined && args.y !== undefined) target = elementAt(args.x, args.y)
        if (!target) throw new Error('hover target not found')
        const c = elementCenter(target)
        dispatchRealEvent(target, 'mouseover', { clientX: c.x, clientY: c.y })
        dispatchRealEvent(target, 'mouseenter', { clientX: c.x, clientY: c.y })
        break
      }
      case 'type': {
        if (!el) throw new Error('type requires a selector')
        focusAndType(el, String(args.text || ''))
        break
      }
      case 'key': {
        const target = el || document.activeElement
        if (!target) throw new Error('no focused element for key')
        const key = String(args.key || args.text || '')
        const mapping = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 }
        const keyCode = mapping[key] || (key.length === 1 ? key.charCodeAt(0) : 0)
        const ev = new KeyboardEvent('keydown', { key, code: key, keyCode, bubbles: true, cancelable: true })
        target.dispatchEvent(ev)
        if (key.length === 1 && keyCode !== 13) {
          const input = new InputEvent('beforeinput', { data: key, inputType: 'insertText', bubbles: true })
          target.dispatchEvent(input)
        }
        const up = new KeyboardEvent('keyup', { key, code: key, keyCode, bubbles: true })
        target.dispatchEvent(up)
        break
      }
      case 'clear': {
        if (!el) throw new Error('clear requires a selector')
        focusAndType(el, '')
        break
      }
      case 'scroll': {
        if (args.x !== undefined || args.y !== undefined) {
          window.scrollTo(args.x || 0, args.y || 0)
        } else if (args.direction) {
          const amt = args.amount || Math.round(window.innerHeight * 0.8)
          const map = { up: [0, -amt], down: [0, amt], left: [-amt, 0], right: [amt, 0] }
          const [dx, dy] = map[args.direction] || [0, amt]
          window.scrollBy(dx, dy)
        } else if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        } else {
          throw new Error('scroll needs x/y, direction, or selector')
        }
        break
      }
      default:
        throw new Error(`unknown action: ${action}`)
    }
    // Small settle, then report the new state.
    await new Promise((r) => setTimeout(r, 300))
    return snapshot({ includeVisibleText: false, maxElements: 30 })
  }

  // ── page.navigate / page.wait ───────────────────────────────────────────────

  async function navigate(args) {
    const { action } = args
    switch (action) {
      case 'go':
        if (!args.url) throw new Error('navigate go requires url')
        location.href = args.url
        break
      case 'back': history.back(); break
      case 'forward': history.forward(); break
      case 'reload': location.reload(); break
      default: throw new Error(`unknown navigate action: ${action}`)
    }
    // wait for load to settle a bit
    await new Promise((r) => setTimeout(r, 1500))
    return { url: location.href, title: document.title }
  }

  function waitFor(condition, timeout, selector) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeout
      const check = () => {
        let done = false
        let ok = true
        if (condition === 'load') done = document.readyState === 'complete'
        else if (condition === 'network-idle') {
          // heuristic: no pending fetch for ~500ms — approximated with a quiet period
          done = true
        } else if (condition === 'delay') {
          done = Date.now() >= deadline
        } else if (condition === 'selector') {
          try { done = !!document.querySelector(selector) } catch { done = false }
        }
        if (done) resolve({ ok, condition, waited: timeout - Math.max(deadline - Date.now(), 0) })
        else if (Date.now() >= deadline) resolve({ ok: false, condition, reason: 'timeout' })
        else setTimeout(check, 200)
      }
      check()
    })
  }

  async function wait(args) {
    const timeout = Math.min(Number(args.timeout) || 10000, 60000)
    if (args.condition === 'delay') {
      await new Promise((r) => setTimeout(r, timeout))
      return { ok: true, condition: 'delay' }
    }
    return waitFor(args.condition, timeout, args.selector)
  }

  // ── page.screenshot ─────────────────────────────────────────────────────────

  async function screenshot(args) {
    // Ask the background service worker to capture the visible tab.
    const res = await chrome.runtime.sendMessage({ type: 'dsh:screenshot', mode: args.mode || 'viewport', selector: args.selector || null, name: args.name || null })
    if (!res || !res.ok) throw new Error((res && res.error) || 'screenshot failed')
    return res
  }

  // ── page.network (MAIN-world fetch/XHR capture) ─────────────────────────────

  /**
   * Install a ring-buffer network capture in the page's MAIN world by
   * injecting a <script>. It wraps window.fetch and XMLHttpRequest, records
   * {url, method, status, requestHeaders, responseHeaders, requestBody,
   * responseBodyPreview, ok, durationMs} for each request, and keeps the last
   * `maxEntries` in window.__dshNetworkLog. Installation is idempotent.
   */
  function installNetworkCapture() {
    const script = document.createElement('script')
    script.textContent = `
      (function () {
        if (window.__dshNetworkLog) return;
        var MAX = 200;
        var log = [];
        window.__dshNetworkLog = {
          entries: log,
          clear: function () { log.length = 0; },
          push: function (e) { log.push(e); if (log.length > MAX) log.shift(); }
        };
        function preview(v) {
          if (v === undefined || v === null) return null;
          var s = typeof v === 'string' ? v : JSON.stringify(v);
          if (s === undefined) return null;
          return s.length > 4000 ? s.slice(0, 4000) + '…' : s;
        }
        function readBody(body) {
          if (!body) return null;
          try { return preview(body); } catch (e) { return null; }
        }
        var origFetch = window.fetch;
        window.fetch = function () {
          var url = arguments[0];
          var opts = arguments[1] || {};
          var method = (opts.method || 'GET').toUpperCase();
          var start = performance.now();
          var urlStr = typeof url === 'string' ? url : (url && url.url) || String(url);
          return origFetch.apply(this, arguments).then(function (res) {
            var entry = {
              kind: 'fetch', url: urlStr, method: method,
              status: res.status, ok: res.ok,
              requestBody: readBody(opts.body),
              responseHeaders: preview(res.headers ? Object.fromEntries(res.headers.entries()) : null),
              durationMs: Math.round(performance.now() - start),
              ts: Date.now()
            };
            var cloned = res.clone();
            cloned.text().then(function (text) {
              entry.responseBodyPreview = preview(text);
            }).catch(function () {});
            window.__dshNetworkLog.push(entry);
            return res;
          }).catch(function (err) {
            window.__dshNetworkLog.push({
              kind: 'fetch', url: urlStr, method: method,
              status: 0, ok: false, error: String(err && err.message || err),
              requestBody: readBody(opts.body),
              durationMs: Math.round(performance.now() - start),
              ts: Date.now()
            });
            throw err;
          });
        };
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__dshMethod = method;
          this.__dshUrl = url;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          var self = this;
          var start = performance.now();
          this.addEventListener('loadend', function () {
            var entry = {
              kind: 'xhr', url: String(self.__dshUrl || ''), method: String(self.__dshMethod || 'GET'),
              status: self.status, ok: self.status >= 200 && self.status < 300,
              requestBody: readBody(body),
              responseBodyPreview: preview(self.responseText),
              durationMs: Math.round(performance.now() - start),
              ts: Date.now()
            };
            window.__dshNetworkLog.push(entry);
          });
          return origSend.apply(this, arguments);
        };
      })();
    `
    document.documentElement.appendChild(script)
    script.remove()
  }

  /**
   * page_network: read the captured network log.
   * args: { query?: 'all'|'recent', limit?: number, filterUrl?: string, clear?: boolean }
   * Returns entries matching filterUrl, newest first, capped at limit.
   */
  async function network(args) {
    const a = args || {}
    if (a.clear) {
      // Clear via MAIN world (log lives there).
      await evalInMainWorld('window.__dshNetworkLog && window.__dshNetworkLog.clear(); return "cleared"', [])
      return { ok: true, cleared: true, count: 0 }
    }
    // Ensure the hook is installed (idempotent) before reading.
    installNetworkCapture()
    const readExpr = `(function () {
      var log = window.__dshNetworkLog ? window.__dshNetworkLog.entries : [];
      var out = [];
      for (var i = log.length - 1; i >= 0; i--) {
        var e = log[i];
        if (${JSON.stringify(a.filterUrl || '')} && e.url.indexOf(${JSON.stringify(a.filterUrl || '')}) === -1) continue;
        out.push(e);
        if (out.length >= ${Math.min(Number(a.limit) || 30, 100)}) break;
      }
      return out;
    })()`
    const entries = await evalInMainWorld(readExpr, [])
    return { ok: true, count: Array.isArray(entries) ? entries.length : 0, entries: Array.isArray(entries) ? entries : [] }
  }

  // ── page.record (user-action recorder + multi-signature locators) ───────────

  /**
   * Build a multi-signature ElementTarget for an element: semantic (a11y
   * role+name), text anchor, relative position, CSS selector, viewport index.
   * This is what makes workflows robust to page changes — the executor tries
   * each signature in order and falls back gracefully.
   */
  function buildElementTarget(el, viewportIndex) {
    const out = {}
    // a11y semantic: role + accessible name (via aria-label / text / title)
    const role = el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName.toLowerCase())
    let name = el.getAttribute('aria-label') || el.getAttribute('title') || ''
    if (!name && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      name = el.getAttribute('placeholder') || el.getAttribute('name') || ''
    }
    if (!name) {
      const txt = (el.innerText || '').trim()
      if (txt && txt.length < 80) name = txt
    }
    if (role && name) out.semantic = { role, name }

    // text anchor: "按钮「提交」" style descriptor
    if (name) {
      const kind = role === 'link' ? '链接' : role === 'button' ? '按钮' : role === 'input' || el.tagName === 'INPUT' ? '输入框' : role
      out.textAnchor = `${kind}「${name.slice(0, 30)}」`
    } else if (el.id) {
      out.textAnchor = `元素#${el.id}`
    }

    // CSS selector (best effort, short)
    if (el.id) out.selector = `#${CSS.escape(el.id)}`
    else if (el.getAttribute('data-testid')) out.selector = `[data-testid="${CSS.escape(el.getAttribute('data-testid'))}"]`
    else {
      const tag = el.tagName.toLowerCase()
      const cls = typeof el.className === 'string'
        ? el.className.split(/\s+/).filter(Boolean).slice(0, 1).map((c) => CSS.escape(c)).join('.')
        : ''
      out.selector = cls ? `${tag}.${cls}` : tag
    }

    if (typeof viewportIndex === 'number') out.indexInViewport = viewportIndex
    return out
  }

  // Recorder state: active + captured events + listeners to remove.
  const recorder = { active: false, events: [], cleanup: null, startTs: 0 }

  function captureTargetInfo(el) {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.left), y: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height)
    }
  }

  /** Install global listeners that record user actions. */
  function startRecording() {
    if (recorder.active) return { ok: true, alreadyActive: true }
    recorder.active = true
    recorder.events = []
    recorder.startTs = Date.now()

    const record = (type, el, extra = {}) => {
      if (!recorder.active) return
      if (!el || el.nodeType !== 1) return
      // skip our own highlight overlay
      if (el.closest && el.closest('#dsh-record-overlay')) return
      const target = buildElementTarget(el)
      const info = captureTargetInfo(el)
      recorder.events.push({
        ts: Date.now() - recorder.startTs,
        type,
        target,
        info,
        ...extra
      })
    }

    const onClick = (e) => {
      const el = e.target && e.target.closest ? (e.target.closest('button, a, input, select, textarea, [role], [onclick]') || e.target) : e.target
      record('click', el)
    }
    const onInput = (e) => {
      const el = e.target
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        record('type', el, { value: String(el.value !== undefined ? el.value : el.textContent || '').slice(0, 200) })
      }
    }
    const onChange = (e) => {
      const el = e.target
      if (el && el.tagName === 'SELECT') record('select', el, { value: el.value })
    }
    const onScroll = () => {
      // debounced
      clearTimeout(recorder._scrollTimer)
      recorder._scrollTimer = setTimeout(() => {
        recorder.events.push({ ts: Date.now() - recorder.startTs, type: 'scroll', to: { x: window.scrollX, y: window.scrollY } })
      }, 300)
    }
    const onNav = () => {
      if (!recorder.active) return
      recorder.events.push({ ts: Date.now() - recorder.startTs, type: 'navigate', url: location.href })
    }

    document.addEventListener('click', onClick, true)
    document.addEventListener('input', onInput, true)
    document.addEventListener('change', onChange, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('pageshow', onNav)
    recorder.cleanup = () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('change', onChange, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('pageshow', onNav)
    }
    return { ok: true, started: true }
  }

  function stopRecording() {
    if (!recorder.active) return { ok: true, alreadyStopped: true, events: recorder.events }
    recorder.active = false
    if (recorder.cleanup) { recorder.cleanup(); recorder.cleanup = null }
    const events = recorder.events
    recorder.events = []
    return { ok: true, events, durationMs: Date.now() - recorder.startTs }
  }

  /**
   * page_record: start or stop recording user actions.
   * args: { mode: 'start' | 'stop' }
   */
  async function record(args) {
    const mode = args && args.mode
    if (mode === 'start') {
      const r = startRecording()
      return { ok: true, started: r.started, message: '录制开始：请像平时一样操作页面' }
    }
    if (mode === 'stop') {
      const r = stopRecording()
      return { ok: true, events: r.events, durationMs: r.durationMs, message: `录制完成，共 ${r.events.length} 个动作` }
    }
    // status
    return { ok: true, active: recorder.active, eventCount: recorder.events.length }
  }

  // ── page.highlight (element highlight for confirmation) ─────────────────────

  let highlightCleanup = null
  function clearHighlight() {
    if (highlightCleanup) { highlightCleanup(); highlightCleanup = null }
  }

  /**
   * page_highlight: draw a pulsing outline on the element at (x,y) or matching
   * a selector, so the user sees exactly what the LLM is about to act on.
   * args: { x?, y?, selector?, clear?: true }
   */
  async function highlight(args) {
    clearHighlight()
    if (args && args.clear) return { ok: true, cleared: true }

    let el = null
    if (args.selector) {
      try { el = document.querySelector(args.selector) } catch {}
    } else if (args.x !== undefined && args.y !== undefined) {
      el = document.elementFromPoint(args.x, args.y)
    }
    if (!el) return { ok: false, error: { code: 'not-found', message: 'element not found for highlight' } }

    const r = el.getBoundingClientRect()
    const overlay = document.createElement('div')
    overlay.id = 'dsh-record-overlay'
    overlay.style.cssText = `
      position: fixed; left: ${r.left}px; top: ${r.top}px;
      width: ${r.width}px; height: ${r.height}px;
      border: 3px solid #4f6ef7; border-radius: 6px;
      box-shadow: 0 0 0 2px rgba(79,110,247,.3), 0 0 20px rgba(79,110,247,.5);
      pointer-events: none; z-index: 2147483646;
      animation: dsh-pulse 1.2s ease-in-out infinite;
      box-sizing: border-box;
    `
    const style = document.createElement('style')
    style.textContent = `@keyframes dsh-pulse { 0%,100% { opacity: 1 } 50% { opacity: .5 } }`
    document.documentElement.appendChild(style)
    document.documentElement.appendChild(overlay)
    highlightCleanup = () => { overlay.remove(); style.remove() }
    return { ok: true, highlighted: { x: r.left, y: r.top, width: r.width, height: r.height } }
  }

  // ── dispatcher ──────────────────────────────────────────────────────────────

  const TOOLS = {
    'page_snapshot': snapshot,
    'page_eval': evalInMainWorld,
    'page_act': act,
    'page_navigate': navigate,
    'page_wait': wait,
    'page_screenshot': screenshot,
    'page_network': network,
    'page_record': record,
    'page_highlight': highlight
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'dsh:tool') return
    const { requestId, tool, args } = msg
    const fn = TOOLS[tool]
    if (!fn) {
      sendResponse({ ok: false, error: { code: 'unknown-tool', message: `unknown page tool: ${tool}` } })
      return
    }
    Promise.resolve()
      .then(() => fn(args || {}))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: { code: 'page-error', message: String(err && err.message || err) } }))
    return true // async sendResponse
  })
})()
