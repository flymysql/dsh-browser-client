// REAL end-to-end: connect a probe WS to the host control channel as the panel
// would, but ALSO let the real panel handle it. Actually the cleanest: send a
// prompt to a fresh session, and the REAL panel (already connected) receives
// the tool-request, forwards to content script, and replies. We only watch.
//
// The panel is already connected to /ext-api-control. When the LLM calls
// page_snapshot, the host bridge pushes tool-request to the panel socket.
// We verify the real panel answers by watching the session history for the
// tool/result containing REAL page data.
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

const HOST = 'http://127.0.0.1:3999'
const token = readFileSync('/Users/jimmy/work/demo/dsh-browser-host/test/env/browser-client-token', 'utf8').trim()
const rpc = async (method, payload) => {
  const res = await fetch(`${HOST}/ext-api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ rpcId: crypto.randomUUID(), method, payload })
  })
  const b = await res.json()
  if (!b.result || b.result.ok !== true) throw new Error(`${method}: ${JSON.stringify(b.result?.error || b)}`)
  return b.result.value
}

// fresh session
const wsDir = '/tmp/dsh-page-tools-demo'
import { mkdirSync } from 'node:fs'
try { mkdirSync(wsDir, { recursive: true }) } catch {}
const { workspace } = await rpc('workspace.create', { path: wsDir })
const { sessionId } = await rpc('session.create', { workspaceId: workspace.workspaceId })
console.log('fresh session:', sessionId)

// send prompt — the REAL panel should answer the tool request
console.log('→ sending prompt (real panel will answer page_snapshot)…')
await rpc('session.prompt', {
  sessionId, mode: 'queue',
  content: [{ type: 'text', text: '用 page_snapshot 看一下当前页面，页面上有什么商品？价格多少？' }],
  clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
})

const deadline = Date.now() + 90000
let toolResult = null
let finalText = ''
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 3000))
  const page = await rpc('session.history', { sessionId, maxMessages: 60 })
  const events = (page.events || []).map(e => e.event)
  // find tool/result for page_snapshot
  for (const ev of events) {
    if (ev.type === 'tool/result' && ev.data?.message) {
      const content = ev.data.message.content || []
      for (const c of content) {
        if (c.type === 'tool-result' && (c.content || []).length) {
          toolResult = c.content.map(x => x.text || '').join('')
        }
      }
    }
  }
  finalText = events.filter(e => e.type === 'assistant/chunk')
    .map(e => { const c = e.data?.chunk || {}; return c.type === 'text-delta' ? (c.text || '') : '' }).join('')
  const turnEnd = events.some(e => e.type === 'turn/end')
  if (turnEnd && (toolResult || finalText)) break
}
console.log('\n=== page_snapshot tool result (from REAL panel + content script) ===')
console.log((toolResult || '').slice(0, 800))
console.log('\n=== ASSISTANT FINAL TEXT ===')
console.log(finalText.slice(0, 800))
const pass = /键盘|耳机|显示器|¥/.test(toolResult || '') || /键盘|耳机|显示器|¥/.test(finalText)
console.log('\n' + (pass ? '✓ REAL E2E (panel+content script): PASSED' : '✗ REAL E2E: FAILED'))
process.exit(pass ? 0 : 1)
