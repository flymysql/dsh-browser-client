/**
 * e2e-page-network.mjs — full-loop verification for page_network:
 * LLM → page_network tool → control channel → simulated extension (returns
 * canned network entries) → response → LLM references the data.
 *
 * Requires the test DSH host on :3999 with dsh-browser-host mounted and a
 * working LLM route (same prerequisites as e2e-page-tool.mjs).
 */
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:3999'
const TOKEN_FILE = process.env.TOKEN_FILE || '/Users/jimmy/work/demo/dsh-browser-host/test/env/browser-client-token'
const token = readFileSync(TOKEN_FILE, 'utf8').trim()

const rpc = async (method, payload, rpcId = crypto.randomUUID()) => {
  const res = await fetch(`${BASE}/ext-api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ rpcId, method, payload })
  })
  const body = await res.json()
  if (!body.result || body.result.ok !== true) throw new Error(`${method}: ${JSON.stringify(body.result && body.result.error || body)}`)
  return body.result.value
}

// Fresh workspace + session
const wsDir = '/tmp/dsh-page-tools-demo'
import { mkdirSync } from 'node:fs'
try { mkdirSync(wsDir, { recursive: true }) } catch {}
const { workspace } = await rpc('workspace.create', { path: wsDir })
const { sessionId } = await rpc('session.create', { workspaceId: workspace.workspaceId })
console.log('session:', sessionId)

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/ext-api-control?token=${encodeURIComponent(token)}`, {
  origin: 'chrome-extension://abcdefghijklmnop'
})

let toolCalls = 0
ws.on('message', (data) => {
  const frame = JSON.parse(data.toString())
  if (frame.kind === 'tool-request') {
    toolCalls++
    console.log(`← HOST tool-request: ${frame.tool} args=${JSON.stringify(frame.args).slice(0, 120)}`)
    if (frame.tool === 'page_network') {
      const result = {
        ok: true,
        count: 2,
        entries: [
          { kind: 'fetch', url: 'https://api.example.com/feed?page=1', method: 'GET', status: 200, ok: true, responseBodyPreview: '{"items":[{"id":1,"title":"机械键盘","price":299},{"id":2,"title":"降噪耳机","price":899}]}' },
          { kind: 'fetch', url: 'https://api.example.com/track', method: 'POST', status: 204, ok: true }
        ]
      }
      ws.send(JSON.stringify({ kind: 'tool-response', requestId: frame.requestId, ok: true, result }))
      console.log('→ ext replied: page_network entries (canned feed API)')
    } else {
      ws.send(JSON.stringify({ kind: 'tool-response', requestId: frame.requestId, ok: false, error: { code: 'unexpected', message: 'test only serves page_network' } }))
    }
  }
})

await new Promise((resolve, reject) => {
  ws.on('open', resolve)
  ws.on('error', reject)
})
console.log('✓ control socket open')

console.log('\n→ sending prompt: "用 page_network 看页面调了什么接口，数据里有什么商品"')
await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '用 page_network 看一下页面调用了哪些接口，接口返回数据里有什么商品信息。' }],
  clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
})

// Poll for turn completion, fold text-delta chunks.
const deadline = Date.now() + 90000
let finalText = ''
let lastTurnEnd = null
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000))
  const page = await rpc('session.history', { sessionId, maxMessages: 60 })
  const events = (page.events || []).map((e) => e.event)
  lastTurnEnd = [...events].reverse().find((e) => e.type === 'turn/end')
  finalText = events
    .filter((e) => e.type === 'assistant/chunk')
    .map((e) => {
      const c = e.data && e.data.chunk || {}
      return c.type === 'text-delta' ? (c.text || '') : ''
    })
    .join('')
  if (lastTurnEnd && finalText) break
  console.log(`  … waiting (${Math.round((deadline - Date.now()) / 1000)}s left, toolCalls=${toolCalls})`)
}

console.log('\n=== ASSISTANT FINAL TEXT ===')
console.log(finalText.slice(0, 1500))

const usedTool = toolCalls > 0
const sawApi = /api\.example\.com|feed|track/.test(finalText)
const sawData = /键盘|耳机|299|899|商品/.test(finalText)
console.log('\n=== VERDICT ===')
console.log(`tool calls: ${toolCalls} (${usedTool ? '✓' : '✗'})`)
console.log(`referenced API: ${sawApi ? '✓' : '✗'}`)
console.log(`referenced data: ${sawData ? '✓' : '✗'}`)
console.log(`turn ended: ${lastTurnEnd ? '✓' : '✗'}`)
const pass = usedTool && sawApi && sawData && lastTurnEnd !== null
console.log(pass ? '\nE2E PAGE_NETWORK LOOP: PASSED' : '\nE2E PAGE_NETWORK LOOP: FAILED')
ws.close()
process.exit(pass ? 0 : 1)
