/**
 * bridge.js — bidirectional tool bridge between DSH host tools and the
 * extension control channel.
 *
 * The extension panel holds one WebSocket to /ext-control?token=… open for the
 * lifetime of the panel. This bridge:
 *
 *   - owns the socket: frames from the extension are routed by `kind`;
 *   - lets host tools `request()` a tool execution: sends a `tool-request`
 *     frame down, parks a {resolve, reject, timer} promise keyed by
 *     requestId, and settles it when the matching `tool-response` /
 *     `tool-error` frame comes back;
 *   - forwards the caller AbortSignal so cancellation reaches the extension.
 *
 * Wire protocol (JSON text frames):
 *   host → extension:  { kind: 'tool-request', requestId, tool, args, timeoutMs }
 *   extension → host:  { kind: 'tool-response', requestId, ok: true, result }
 *                      { kind: 'tool-response', requestId, ok: false, error: {code, message} }
 *                      { kind: 'status', state: 'connected'|'disconnected', tab?: {...} }
 */

import { randomUUID } from 'node:crypto'

export class ToolBridge {
  /**
   * @param {{ log?: (msg: string) => void }} opts
   */
  constructor(opts = {}) {
    this.log = opts.log || (() => {})
    this.ws = null
    this.pending = new Map() // requestId -> { resolve, reject, timer, signalHandler }
    this.status = 'disconnected'
    this.statusHandlers = new Set()
    this._attached = false
  }

  /** Whether a control socket is currently attached. */
  isConnected() {
    return this.ws !== null && this.ws.readyState === 1 /* OPEN */
  }

  /**
   * Attach a control WebSocket. Only one at a time; a newer attach replaces
   * the older (a reconnecting panel re-announces itself).
   */
  attach(ws) {
    if (this.ws) {
      this.log('control socket replaced (reconnect)')
      try { this.ws.close() } catch { /* already closed */ }
    }
    this.ws = ws
    this._attached = true
    this.log('control socket attached')

    ws.on('message', (data) => {
      let frame
      try { frame = JSON.parse(data.toString('utf8')) } catch (err) {
        this.log(`bad control frame: ${err.message}`)
        return
      }
      this._handleFrame(frame)
    })
    ws.on('close', () => {
      this.log('control socket closed')
      if (this.ws === ws) this.ws = null
      this._failAll('extension disconnected')
      this._setStatus('disconnected', null)
    })
    ws.on('error', (err) => {
      this.log(`control socket error: ${err && err.message || err}`)
    })

    this._setStatus('connected', null)
  }

  /** Set the latest extension status and notify handlers. */
  _setStatus(state, tab) {
    this.status = state
    for (const h of this.statusHandlers) {
      try { h(state, tab) } catch (err) { this.log(`status handler error: ${err && err.message || err}`) }
    }
  }

  /** Subscribe to connection state changes; returns an unsubscribe fn. */
  onStatus(handler) {
    this.statusHandlers.add(handler)
    handler(this.status, null)
    return () => this.statusHandlers.delete(handler)
  }

  _handleFrame(frame) {
    switch (frame && frame.kind) {
      case 'tool-response': {
        const pending = this.pending.get(frame.requestId)
        if (!pending) {
          this.log(`unexpected tool-response for ${frame.requestId}`)
          return
        }
        this.pending.delete(frame.requestId)
        clearTimeout(pending.timer)
        if (pending.signalHandler && pending.signal) {
          pending.signal.removeEventListener('abort', pending.signalHandler)
        }
        if (frame.ok === false) {
          const err = new Error((frame.error && frame.error.message) || 'page tool failed')
          err.code = (frame.error && frame.error.code) || 'page-error'
          pending.reject(err)
        } else {
          pending.resolve(frame.result)
        }
        break
      }
      case 'ask-response': {
        const pending = this.pending.get(frame.requestId)
        if (!pending) {
          this.log(`unexpected ask-response for ${frame.requestId}`)
          return
        }
        this.pending.delete(frame.requestId)
        clearTimeout(pending.timer)
        if (pending.signalHandler && pending.signal) {
          pending.signal.removeEventListener('abort', pending.signalHandler)
        }
        pending.resolve(frame.answer)
        break
      }
      case 'status': {
        this._setStatus(frame.state, frame.tab || null)
        break
      }
      default:
        this.log(`unknown control frame kind: ${frame && frame.kind}`)
    }
  }

  /**
   * Ask the user a question through the extension panel.
   * Sends an `ask-request` frame down; the panel shows a dialog and replies
   * with `ask-response` carrying the selected answer.
   * @param {string} question - the question text.
   * @param {{ options?: string[], detail?: string, timeoutMs?: number }} opts
   * @returns {Promise<string>} the user's answer.
   */
  requestAsk(question, opts = {}) {
    if (!this.isConnected()) {
      return Promise.reject(new Error('extension not connected — open the DSH browser panel'))
    }
    const requestId = randomUUID()
    const timeoutMs = opts.timeoutMs || 120000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('ask timed out waiting for user'))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer, signal: null, signalHandler: null })
      const frame = JSON.stringify({
        kind: 'ask-request',
        requestId,
        question: String(question || '请确认'),
        detail: opts.detail || '',
        options: opts.options || []
      })
      try {
        this.ws.send(frame)
      } catch (err) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(new Error(`failed to send ask request: ${err && err.message || err}`))
      }
    })
  }

  /**
   * Send a tool request down the control channel and wait for the response.
   * @param {string} tool - tool name (e.g. 'page.snapshot').
   * @param {unknown} args - JSON-serializable arguments.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @param {number} [timeoutMs] - round-trip budget.
   * @returns {Promise<unknown>} the tool result.
   */
  request(tool, args, { signal, timeoutMs } = {}) {
    if (!this.isConnected()) {
      return Promise.reject(new Error('extension not connected — open the DSH browser panel'))
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        if (signalHandler && signal) signal.removeEventListener('abort', signalHandler)
        reject(new Error(`page tool ${tool} timed out after ${timeoutMs}ms`))
      }, timeoutMs || 60000)
      const signalHandler = () => {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(new Error(`page tool ${tool} cancelled`))
      }
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer)
          reject(new Error(`page tool ${tool} cancelled`))
          return
        }
        signal.addEventListener('abort', signalHandler)
      }
      this.pending.set(requestId, { resolve, reject, timer, signal, signalHandler })
      const frame = JSON.stringify({ kind: 'tool-request', requestId, tool, args, timeoutMs: timeoutMs || 60000 })
      try {
        this.ws.send(frame)
      } catch (err) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', signalHandler)
        reject(new Error(`failed to send tool request: ${err && err.message || err}`))
      }
    })
  }

  /** Fail every outstanding request (used on disconnect). */
  _failAll(message) {
    const err = new Error(message)
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      if (pending.signalHandler && pending.signal) {
        pending.signal.removeEventListener('abort', pending.signalHandler)
      }
      pending.reject(err)
    }
    this.pending.clear()
  }

  /** Close the bridge: drop the socket and fail outstanding requests. */
  close() {
    if (this.ws) {
      try { this.ws.close() } catch { /* already closed */ }
      this.ws = null
    }
    this._failAll('bridge closed')
  }
}

/** Create a ready-to-use ToolBridge (factory kept for API symmetry). */
export function createToolBridge(opts) {
  return new ToolBridge(opts)
}
