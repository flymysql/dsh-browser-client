/**
 * dsh-client.js — shared DSH Browser Client ↔ dsh-browser-host wire client.
 *
 * Talks to the host plugin's extension surface:
 *   POST /ext-api/<method>             RPC (JSON envelope, bearer token)
 *   GET  /ext-events.mux?token=…       WebSocket mux event stream
 *   GET  /ext-events.host?token=…      WebSocket host event stream
 *   GET  /ext-api-control?token=…      WebSocket BIDIRECTIONAL control channel:
 *                                      receives page tool requests from the
 *                                      host, sends back responses
 *   GET  /ext-api-health               health check
 *
 * The host base URL and token are injected by the caller (settings page /
 * background). This file is loaded as a classic script in the panel page; it
 * exposes window.DshClient.
 */
(function (global) {
  'use strict'

  const DEFAULTS = {
    baseUrl: 'http://127.0.0.1:3080',
    token: ''
  }

  class DshClient {
    constructor(opts = {}) {
      this.baseUrl = (opts.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '')
      this.token = opts.token || DEFAULTS.token
      this._mux = null
      this._host = null
      this._control = null
      this._muxHandlers = new Set()
      this._hostHandlers = new Set()
      this._pending = new Map() // rpcId -> {resolve, reject, timer}
      this._toolHandlers = new Set() // (request) => void — page tool requests
      this._askHandlers = new Set()  // user-ask requests (workflow confirmations)
      this._controlStatusHandlers = new Set()
    }

    /** One RPC call. Resolves with the response result or throws on error. */
    async call(method, payload = {}, { signal } = {}) {
      const rpcId = crypto.randomUUID()
      const body = { rpcId, method, payload }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 120000)
      const onAbort = () => ctrl.abort()
      if (signal) {
        if (signal.aborted) ctrl.abort()
        else signal.addEventListener('abort', onAbort)
      }
      try {
        const res = await fetch(`${this.baseUrl}/ext-api/${method}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.token}`
          },
          body: JSON.stringify(body),
          signal: ctrl.signal
        })
        if (res.status === 401) throw new Error('invalid token (401)')
        if (res.status === 403) throw new Error('origin not allowed (403)')
        const text = await res.text()
        let parsed
        try { parsed = JSON.parse(text) } catch { throw new Error(`bad response ${res.status}: ${text.slice(0, 120)}`) }
        // Host returns the official envelope: { type, rpcId, result }
        if (parsed.result && parsed.result.ok === false) {
          const err = parsed.result.error || {}
          throw new Error(`dsh:${err.code || 'error'} ${err.message || ''}`.trim())
        }
        return parsed.result && parsed.result.ok === true ? parsed.result.value : parsed.result
      } finally {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
    }

    /** Open the mux event stream. Returns a promise resolving once open. */
    async openMux() {
      if (this._mux && this._mux.readyState <= WebSocket.OPEN) return this._mux
      const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/ext-events.mux?token=${encodeURIComponent(this.token)}`)
      this._mux = ws
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        for (const h of this._muxHandlers) {
          try { h(msg.payload, msg) } catch (e) { console.error('[dsh-client] mux handler error', e) }
        }
      })
      ws.addEventListener('close', () => { this._mux = null })
      ws.addEventListener('error', () => { /* closed by close */ })
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', () => reject(new Error('mux open failed')), { once: true })
      })
      return ws
    }

    /** Register a mux frame handler; returns an unsubscribe fn. */
    onMux(handler) {
      this._muxHandlers.add(handler)
      return () => this._muxHandlers.delete(handler)
    }

    /** Register a host-frame handler; returns an unsubscribe fn. */
    onHost(handler) {
      this._hostHandlers.add(handler)
      return () => this._hostHandlers.delete(handler)
    }

    /** Open the host event stream (session create/destroy etc). */
    async openHost() {
      if (this._host && this._host.readyState <= WebSocket.OPEN) return this._host
      const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/ext-events.host?token=${encodeURIComponent(this.token)}`)
      this._host = ws
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        for (const h of this._hostHandlers) {
          try { h(msg.payload, msg) } catch (e) { console.error('[dsh-client] host handler error', e) }
        }
      })
      ws.addEventListener('close', () => { this._host = null })
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', () => reject(new Error('host open failed')), { once: true })
      })
      return ws
    }

    async health() {
      const res = await fetch(`${this.baseUrl}/ext-api-health`, {
        headers: { authorization: `Bearer ${this.token}` }
      })
      if (res.status !== 200) throw new Error(`health ${res.status}`)
      return res.json()
    }

    // ── bidirectional control channel (page tool execution) ───────────────────

    /**
     * Open the control WebSocket. The panel owns exactly one; the host pushes
     * page tool requests down it and we push responses back up.
     * @returns {Promise<WebSocket>}
     */
    async openControl() {
      if (this._control && this._control.readyState <= WebSocket.OPEN) return this._control
      const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/ext-api-control?token=${encodeURIComponent(this.token)}`)
      this._control = ws
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        this._dispatchControl(msg)
      })
      ws.addEventListener('close', () => {
        this._control = null
        this._notifyControlStatus('disconnected')
      })
      ws.addEventListener('error', () => { /* close follows */ })
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', () => reject(new Error('control open failed')), { once: true })
      })
      this._notifyControlStatus('connected')
      return ws
    }

    /** Route one inbound control frame. */
    _dispatchControl(msg) {
      if (msg && msg.kind === 'tool-request') {
        for (const h of this._toolHandlers) {
          try { h(msg) } catch (e) { console.error('[dsh-client] tool handler error', e) }
        }
      } else if (msg && msg.kind === 'ask-request') {
        for (const h of this._askHandlers) {
          try { h(msg) } catch (e) { console.error('[dsh-client] ask handler error', e) }
        }
      }
    }

    /** Register a handler for inbound user-ask requests (workflow confirmations). */
    onAskRequest(handler) {
      this._askHandlers.add(handler)
      return () => this._askHandlers.delete(handler)
    }

    /** Send an ask response back up the control channel. */
    respondAsk(requestId, answer) {
      if (!this._control || this._control.readyState !== WebSocket.OPEN) {
        console.warn('[dsh-client] control socket not open; dropping ask response', requestId)
        return
      }
      this._control.send(JSON.stringify({ kind: 'ask-response', requestId, answer }))
    }

    /** Register a handler for inbound page tool requests. */
    onToolRequest(handler) {
      this._toolHandlers.add(handler)
      return () => this._toolHandlers.delete(handler)
    }

    /** Send a tool response back up the control channel. */
    respondTool(requestId, ok, resultOrError) {
      if (!this._control || this._control.readyState !== WebSocket.OPEN) {
        console.warn('[dsh-client] control socket not open; dropping tool response', requestId)
        return
      }
      const frame = ok
        ? { kind: 'tool-response', requestId, ok: true, result: resultOrError }
        : { kind: 'tool-response', requestId, ok: false, error: resultOrError }
      this._control.send(JSON.stringify(frame))
    }

    /** Report connection state / current tab to the host. */
    sendControlStatus(state, tab) {
      if (!this._control || this._control.readyState !== WebSocket.OPEN) return
      this._control.send(JSON.stringify({ kind: 'status', state, tab: tab || null }))
    }

    /** Subscribe to control connection status changes. */
    onControlStatus(handler) {
      this._controlStatusHandlers.add(handler)
      return () => this._controlStatusHandlers.delete(handler)
    }

    _notifyControlStatus(state) {
      for (const h of this._controlStatusHandlers) {
        try { h(state) } catch (e) { console.error('[dsh-client] control status handler error', e) }
      }
    }

    close() {
      if (this._mux) { try { this._mux.close() } catch {} this._mux = null }
      if (this._host) { try { this._host.close() } catch {} this._host = null }
      if (this._control) { try { this._control.close() } catch {} this._control = null }
    }
  }

  global.DshClient = DshClient
})(globalThis)
