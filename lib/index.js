/**
 * dsh-browser-host — host-side bridge for the DSH Browser Client extension.
 *
 * The official browser client talks to the harness through `POST /api/<method>`
 * (HTTP RPC) plus `GET /api/events.mux` / `GET /api/events.host` (SSE / WS
 * downlinks). Every one of those requests passes the same-origin browser-trust
 * fence in @deepseek-ai/dsh-client-connection: the Host header must be a
 * loopback/trusted authority AND the Origin header must equal the Host, with
 * Sec-Fetch-Site: cross-site rejected outright. A browser-extension page
 * (chrome-extension://<id>/panel.html) can never satisfy that — its Origin is
 * the extension id, not 127.0.0.1:3080.
 *
 * This plugin opens a separate, token-authenticated surface that the extension
 * can reach from any page (cross-origin is fine because WE attach the CORS
 * headers ourselves):
 *
 *   POST /ext-api/<method>            RPC proxy — same envelope as /api, same
 *                                     apiProxy service underneath
 *   GET  /ext-events.mux?token=…      WebSocket pump of the events.mux stream
 *                                     (the extension keeps one socket open)
 *   GET  /ext-events.host?token=…     WebSocket pump of the events.host stream
 *   GET  /ext-control?token=…         WebSocket BIDIRECTIONAL control channel:
 *                                     host pushes tool requests down, the
 *                                     extension pushes tool responses up
 *   GET  /ext-health?token=…          trivial { ok: true } health check
 *
 * The control channel is what turns the extension from a passive event
 * consumer into a page-operation backend: the harness registers page.* tools
 * whose execute() sends a tool request over the control channel, waits for the
 * extension (which runs the request in the real page via content script), and
 * resolves with the result.
 *
 * Auth: the token is a random 32-byte hex minted at boot (persisted to the
 * configured tokenFile when persistToken is true — default
 * $DSH_HOME/browser-client-token) and printed in the boot log. It is passed via
 * `Authorization: Bearer <token>` on HTTP and as a `token` query parameter on
 * the WebSocket upgrade (a browser cannot set an Authorization header on a
 * WebSocket handshake).
 *
 * Everything here is delivered as a normal Cordis plugin: we register routes
 * on the `webServer` service, forward RPC through the official
 * `toFetchHandler(apiProxy)` (the same fetch shape the official /api uses),
 * and pump the same `apiProxy.events.mux` / `.host` streams over a `ws`
 * WebSocketServer — the same WS library the official connection row uses.
 * No core package is modified.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import z from '@deepseek-ai/schemastery'
import { createToolBridge } from './bridge.js'
import { createPageTools } from './tools.js'
import { mountWorkflows } from './workflow/index.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-browser-host'

/** Services that must exist before we register routes. */
export const inject = ['webServer']

const DEFAULT_TOKEN_FILE = join(homedir(), '.dsh', 'browser-client-token')

/**
 * Read the persisted token, or mint + persist a fresh one.
 * @param persist - whether to write the token to disk.
 */
async function loadOrCreateToken(persist, tokenFile) {
  if (persist) {
    try {
      const existing = await readFile(tokenFile, 'utf8')
      const trimmed = existing.trim()
      if (/^[0-9a-f]{32,}$/.test(trimmed)) return trimmed
    } catch { /* first boot */ }
  }
  const token = randomBytes(32).toString('hex')
  if (persist) {
    try {
      await mkdir(dirname(tokenFile), { recursive: true })
      await writeFile(tokenFile, token, { mode: 0o600 })
    } catch (err) {
      console.warn(`[dsh-browser-host] cannot persist token to ${tokenFile}: ${err}`)
    }
  }
  return token
}

/** Timing-safe string compare for the bearer token. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Read the whole request body as a Buffer. */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** Send a JSON response. */
function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  })
  res.end(payload)
}

/** Whether an Origin header is a browser-extension page origin we serve. */
function isAllowedOrigin(origin) {
  if (typeof origin !== 'string') return false
  // Chrome / Edge / Brave: chrome-extension://<32-hex-id>
  // Firefox: moz-extension://<uuid>
  // Safari: safari-extension://<id> (web-extension flavor uses chrome-extension in Safari 15+)
  if (/^chrome-extension:\/\/[A-Za-z0-9]+$/.test(origin)) return true
  if (/^moz-extension:\/\/[A-Za-z0-9-]+$/.test(origin)) return true
  if (/^safari-extension:\/\/[A-Za-z0-9-]+$/.test(origin)) return true
  return false
}

/**
 * Cordis plugin entry. Registered as a host row in cordis.patch.yml; config
 * keys are validated by the loader (see Config below).
 */
async function apply(ctx, config) {
  const extPrefix = config.extPrefix
  const extEventsPath = config.extEventsPath
  const tokenFile = config.tokenFile || DEFAULT_TOKEN_FILE
  const token = await loadOrCreateToken(config.persistToken, tokenFile)

  console.log(`[dsh-browser-host] extension token: ${token}`)
  console.log(`[dsh-browser-host] extension surface: ${extPrefix}/* (HTTP RPC), ${extEventsPath} (WS events)`)

  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.warn('[dsh-browser-host] webServer not available; extension surface disabled')
    return
  }

  const disposers = []

  // CORS for extension-page origins (we attach it ourselves because the
  // browser enforces CORS on fetch() from the extension page, and the harness
  // /api fence would otherwise 403 these requests at the transport layer).
  const corsHeaders = (origin) => {
    if (!isAllowedOrigin(origin)) return {}
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-expose-headers': '*',
      'access-control-max-age': '600'
    }
  }

  // ── HTTP RPC proxy: POST /ext-api/<method> ────────────────────────────────
  // Local (custom) method handlers registered by subsystems (workflow.*).
  const localRpcHandlers = new Map()
  const rpcHandler = async (req, res) => {
    try {
    const origin = req.headers.origin
    const cors = corsHeaders(origin)

    if (req.method === 'OPTIONS') {
      if (cors['access-control-allow-origin'] === undefined) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
      res.writeHead(204, { ...cors, 'content-length': '0' })
      res.end()
      return
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' }, cors)

    const auth = req.headers.authorization || ''
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!safeEqual(presented, token)) return sendJson(res, 401, { ok: false, error: 'invalid token' }, cors)

    const apiProxy = ctx.get('apiProxy')
    if (apiProxy === undefined) return sendJson(res, 503, { ok: false, error: 'apiProxy unavailable' }, cors)

    const pathname = new URL(req.url, 'http://x').pathname
    const method = pathname.startsWith(`${extPrefix}/`) ? pathname.slice(extPrefix.length + 1) : undefined
    if (method === undefined || method === '') return sendJson(res, 404, { ok: false, error: 'method missing' }, cors)

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') return sendJson(res, 415, { ok: false, error: 'content type must be application/json' }, cors)

    let envelope
    try {
      envelope = JSON.parse((await readBody(req)).toString('utf8'))
    } catch {
      return sendJson(res, 400, { ok: false, error: 'body is not JSON' }, cors)
    }
    if (!envelope || typeof envelope !== 'object' || typeof envelope.rpcId !== 'string' || typeof envelope.method !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'envelope must be { rpcId, method, payload }' }, cors)
    }

    // Local (custom) methods are handled by the plugin itself; anything else
    // proxies to the official apiProxy (same fetch shape as /api).
    const localHandler = localRpcHandlers.get(method)
    if (localHandler) {
      try {
        const value = await localHandler(envelope.payload ?? {})
        const body = JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors })
        res.end(body)
      } catch (err) {
        const body = JSON.stringify({
          type: 'server-response', rpcId: envelope.rpcId,
          result: { ok: false, error: { code: 'workflow-error', message: String(err && err.message || err) } }
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors })
        res.end(body)
      }
      return
    }

    // Same fetch shape the official /api uses: toFetchHandler(apiProxy).
    // The wire requires type: 'client-request'; the extension may omit it
    // (we keep the envelope minimal on the wire to the extension).
    const { toFetchHandler } = await import('@deepseek-ai/dsh-host-apiproxy')
    const handler = toFetchHandler(apiProxy)
    const upstream = new Request(`http://dsh.internal/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: envelope.rpcId, method: envelope.method, payload: envelope.payload ?? {} }),
      signal: req.signal ?? undefined
    })

    try {
      const response = await handler.fetch(upstream)
      const status = response.status
      const text = await response.text()
      console.log(`[dsh-browser-host] ${method} -> upstream ${status} body=${text.slice(0, 120)}`)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors })
      res.end(text)
    } catch (err) {
      console.error(`[dsh-browser-host] rpcHandler error: ${err && err.stack || err}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: `handler error: ${String(err && err.message || err)}` }, cors)
      else res.destroy()
    }
    } catch (err) {
      console.error(`[dsh-browser-host] rpcHandler outer error: ${err && err.stack || err}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: `handler error: ${String(err && err.message || err)}` }, cors)
      else res.destroy()
    }
  }

  // ── WebSocket event pumps: GET /ext-events.mux?token=… etc ────────────────
  // One `ws` server handles both upgrade paths; each socket pumps one stream.
  const wss = new WebSocketServer({ noServer: true })

  const pumpStream = async (req, socket, head, streamFactory) => {
    const url = new URL(req.url, 'http://x')
    if (!safeEqual(url.searchParams.get('token') || '', token)) {
      socket.end([
        'HTTP/1.1 401 Unauthorized',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'invalid token'
      ].join('\r\n'))
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined && !isAllowedOrigin(origin)) {
      socket.end([
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'origin not allowed'
      ].join('\r\n'))
      return
    }

    const apiProxy = ctx.get('apiProxy')
    if (apiProxy === undefined) {
      socket.end([
        'HTTP/1.1 503 Service Unavailable',
        'Connection: close',
        '',
        'apiProxy unavailable'
      ].join('\r\n'))
      return
    }

    wss.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      websocket.once('close', () => abort.abort())
      websocket.once('error', () => abort.abort())
      // Downlink only: any client message is a protocol violation.
      websocket.on('message', () => websocket.close(1008, 'downlink only'))

      const send = (frame) => {
        if (websocket.readyState !== websocket.OPEN) return
        websocket.send(JSON.stringify({ rpcId: frame.rpcId, payload: frame.payload }))
      }

      const pump = (async () => {
        try {
          for await (const frame of streamFactory(abort.signal)) send(frame)
        } catch (err) {
          if (!abort.signal.aborted) {
            try {
              send({ rpcId: '0', payload: { type: 'stream/error', error: { code: 'internal', message: String(err), details: {} } } })
            } catch { /* socket gone */ }
          }
        } finally {
          abort.abort()
          try { websocket.close() } catch { /* already closed */ }
        }
      })()
    })
  }

  // ── route registration ─────────────────────────────────────────────────────
  const routes = [
    { kind: 'prefix', path: extPrefix, handler: rpcHandler },
    {
      kind: 'exact',
      path: extEventsPath,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        res.writeHead(426, { connection: 'Upgrade', upgrade: 'websocket' })
        res.end('upgrade required')
      }
    },
    {
      kind: 'exact',
      path: `${extEventsPath.replace(/\.mux$/, '.host')}`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        res.writeHead(426, { connection: 'Upgrade', upgrade: 'websocket' })
        res.end('upgrade required')
      }
    },
    {
      kind: 'exact',
      path: `${extPrefix}-health`,
      handler: async (req, res) => {
        const origin = req.headers.origin
        const cors = corsHeaders(origin)
        const auth = req.headers.authorization || ''
        const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!safeEqual(presented, token)) return sendJson(res, 401, { ok: false, error: 'invalid token' }, cors)
        return sendJson(res, 200, { ok: true, host: 'dsh-browser-host', tokenPrefix: presented.slice(0, 8) + '…' }, cors)
      }
    }
  ]

  for (const route of routes) {
    try {
      const dispose = webServer.register(route)
      disposers.push(dispose)
    } catch (err) {
      console.warn(`[dsh-browser-host] failed to register route ${route.path}: ${err}`)
    }
  }

  // ── WebSocket upgrade routes ───────────────────────────────────────────────
  const upgradeRoutes = [
    { path: extEventsPath, stream: (signal) => ctx.get('apiProxy').events.mux({ rpcId: 'ext-mux', payload: {} }, signal) },
    { path: extEventsPath.replace(/\.mux$/, '.host'), stream: (signal) => ctx.get('apiProxy').events.host({ rpcId: 'ext-host', payload: {} }, signal) }
  ]
  for (const { path, stream } of upgradeRoutes) {
    try {
      const dispose = webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => pumpStream(req, socket, head, stream)
      })
      disposers.push(dispose)
    } catch (err) {
      console.warn(`[dsh-browser-host] failed to register upgrade route ${path}: ${err}`)
    }
  }

  // ── Bidirectional control channel: GET /ext-control?token=… ────────────────
  // Unlike the downlink-only event pumps above, this socket accepts messages
  // from the extension: tool-response frames answering host tool requests.
  // The extension panel holds exactly one such socket open for the lifetime of
  // the panel (panel open == extension connected == page tools available).
  const controlPath = `${extPrefix}-control`
  const controlWss = new WebSocketServer({ noServer: true })
  const toolBridge = createToolBridge({ log: (msg) => console.log(`[dsh-browser-host] ${msg}`) })

  const controlUpgrade = (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (!safeEqual(url.searchParams.get('token') || '', token)) {
      socket.end([
        'HTTP/1.1 401 Unauthorized',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'invalid token'
      ].join('\r\n'))
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined && !isAllowedOrigin(origin)) {
      socket.end([
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'origin not allowed'
      ].join('\r\n'))
      return
    }
    controlWss.handleUpgrade(req, socket, head, (websocket) => {
      toolBridge.attach(websocket)
    })
  }

  // HTTP fallback for the control path (non-upgrade requests)
  const controlHttpHandler = async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    res.writeHead(426, { connection: 'Upgrade', upgrade: 'websocket' })
    res.end('upgrade required')
  }

  try {
    const dispose = webServer.registerUpgrade({ path: controlPath, handler: controlUpgrade })
    disposers.push(dispose)
    const disposeHttp = webServer.register({ kind: 'exact', path: controlPath, handler: controlHttpHandler })
    disposers.push(disposeHttp)
  } catch (err) {
    console.warn(`[dsh-browser-host] failed to register control route ${controlPath}: ${err}`)
  }

  // ── page.* tools (page understanding + operation, executed in the extension) ─
  const registeredTools = []
  const toolsService = ctx.get('tools')
  if (toolsService !== undefined) {
    const tools = createPageTools(toolBridge, { timeoutMs: config.toolTimeoutMs })
    for (const tool of tools) {
      try {
        registeredTools.push(toolsService.register(tool))
        console.log(`[dsh-browser-host] registered tool ${tool.name}`)
      } catch (err) {
        console.warn(`[dsh-browser-host] failed to register tool ${tool.name}: ${err}`)
      }
    }
  } else {
    console.warn('[dsh-browser-host] tools service not available; page.* tools disabled')
  }

  // ── workflow subsystem (durable store + RPC + commands) ─────────────────────
  let workflowsDispose = null
  try {
    const wf = await mountWorkflows(ctx, {
      harness: {
        handle: (method, fn) => { localRpcHandlers.set(method, fn); return () => localRpcHandlers.delete(method) },
        unhandle: (method) => { localRpcHandlers.delete(method) }
      },
      tools: toolsService,
      skills: ctx.get('skills'),
      toolTimeoutMs: config.toolTimeoutMs,
      bridge: toolBridge,
      ctxServices: {
        askUser: async (req) => {
          // Ask the user through the panel: send an ask-request over the
          // control channel; the panel shows a dialog and replies with the
          // selected answer (or custom text).
          const question = req.question || '请确认'
          const options = Array.isArray(req.options) ? req.options.map((o) => (typeof o === 'object' ? o.label : String(o))) : []
          const answer = await toolBridge.requestAsk(question, {
            detail: req.detail || '',
            options
          })
          return answer
        }
      },
      log: (m) => console.log(`[dsh-browser-host] ${m}`)
    })
    workflowsDispose = wf.dispose
    // Expose the store so the executor can read saved definitions.
    ctx.provide('dshWorkflowStore', wf.store)
  } catch (err) {
    console.warn(`[dsh-browser-host] workflow subsystem failed: ${err && err.stack || err}`)
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already gone */ }
    }
    for (const dispose of registeredTools) {
      try { dispose() } catch { /* already gone */ }
    }
    if (workflowsDispose) { try { workflowsDispose() } catch { /* already gone */ } }
    try { wss.close() } catch { /* already closed */ }
    try { controlWss.close() } catch { /* already closed */ }
    toolBridge.close()
  }, 'dsh-browser-host.routes')
}

/** Config schema (schemastery; the loader rejects non-schema config). */
export const Config = z.object({
  extPrefix: z.string().default('/ext-api'),
  extEventsPath: z.string().default('/ext-events.mux'),
  persistToken: z.boolean().default(true),
  tokenFile: z.string().default(DEFAULT_TOKEN_FILE),
  /** Default timeout for page.* tool round-trips (ms). */
  toolTimeoutMs: z.number().default(60000)
})

export default { name, inject, apply }
