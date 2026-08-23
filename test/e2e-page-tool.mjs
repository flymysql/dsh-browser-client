/**
 * e2e-page-tool.mjs — full-loop verification: LLM → page.snapshot tool →
 * control channel → simulated extension → response → LLM continues.
 *
 * Requires:
 *  - the test DSH host running on :3999 (with dsh-browser-host mounted)
 *  - a DEEPSEEK_API_KEY in the environment (or the profile's configured LLM)
 *
 * Flow:
 *  1. Connect a WebSocket to /ext-api-control?token=… as the extension panel.
 *  2. Send a session.prompt: "用 page.snapshot 看一下当前页面有什么"
 *  3. The agent calls page.snapshot → host bridge sends tool-request down our
 *     socket → we reply with a canned snapshot → tool resolves → agent answers.
 *  4. Poll session.history for the assistant's final message mentioning the
 *     snapshot data, proving the loop closed.
 */
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:3999'
const TOKEN_FILE = process.env.TOKEN_FILE || '/Users/jimmy/work/demo/dsh-browser-host/test/env/browser-client-token'
const SESSION = process.env.DSH_SESSION || readFileSync('/tmp/dsh-test-session-id', 'utf8').trim()
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

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/ext-api-control?token=${encodeURIComponent(token)}`, {
  origin: 'chrome-extension://abcdefghijklmnop'
})

let toolCalls = 0
ws.on('message', (data) => {
  const frame = JSON.parse(data.toString())
  if (frame.kind === 'tool-request') {
    toolCalls++
    console.log(`\n← HOST tool-request: ${frame.tool} args=${JSON.stringify(frame.args).slice(0, 120)}`)
    if (frame.tool === 'page_snapshot') {
      const result = {
        url: 'https://example.com/shop',
        title: 'Example Shop',
        viewport: { x: 0, y: 0, width: 1280, height: 720 },
        visibleText: '欢迎来到示例商城。热卖商品：机械键盘 ¥299，降噪耳机 ¥899。',
        elements: [
          { index: 0, role: 'button', label: '加入购物车', x: 100, y: 200, center: { x: 150, y: 220 } },
          { index: 1, role: 'link', label: '查看详情', x: 300, y: 200, center: { x: 340, y: 220 } }
        ]
      }
      ws.send(JSON.stringify({ kind: 'tool-response', requestId: frame.requestId, ok: true, result }))
      console.log('→ ext replied: page.snapshot result (canned shop snapshot)')
    } else {
      ws.send(JSON.stringify({ kind: 'tool-response', requestId: frame.requestId, ok: false, error: { code: 'unexpected', message: 'test only serves page.snapshot' } }))
    }
  }
})

ws.on('open', async () => {
  console.log('✓ control socket open, session:', SESSION)
  try {
    // Fire the prompt. The agent should call page.snapshot.
    console.log('\n→ sending prompt: "用 page.snapshot 工具看一下当前页面有什么内容"')
    const r = await rpc('session.prompt', {
      sessionId: SESSION,
      mode: 'queue',
      content: [{ type: 'text', text: '用 page.snapshot 工具看一下当前页面有什么内容，然后告诉我页面上有什么商品。' }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
    console.log('✓ prompt accepted:', JSON.stringify(r).slice(0, 120))

    // Wait for the turn to finish, then read history. The assistant reply
    // streams as assistant/chunk text-delta blocks; fold them.
    const deadline = Date.now() + 90000
    let finalText = ''
    let lastTurnEnd = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      const page = await rpc('session.history', { sessionId: SESSION, maxMessages: 60 })
      const events = (page.events || []).map((e) => e.event)
      lastTurnEnd = [...events].reverse().find((e) => e.type === 'turn/end')
      finalText = events
        .filter((e) => e.type === 'assistant/chunk')
        .map((e) => {
          const c = e.data && e.data.chunk || {}
          return c.type === 'text-delta' ? (c.text || '') : ''
        })
        .join('')
      if (lastTurnEnd && finalText) {
        break
      }
      console.log(`  … waiting for turn to complete (${Math.round((deadline - Date.now()) / 1000)}s left, toolCalls=${toolCalls})`)
    }

    console.log('\n=== ASSISTANT FINAL TEXT ===')
    console.log(finalText.slice(0, 1500))

    const usedTool = toolCalls > 0
    const sawPageData = /键盘|耳机|商城|购物车|¥/.test(finalText)
    console.log('\n=== VERDICT ===')
    console.log(`tool calls: ${toolCalls} (${usedTool ? '✓' : '✗'})`)
    console.log(`assistant referenced page data: ${sawPageData ? '✓' : '✗'}`)
    console.log(`turn ended: ${lastTurnEnd ? '✓' : '✗'}`)
    const pass = usedTool && sawPageData && lastTurnEnd !== null
    console.log(pass ? '\nE2E PAGE TOOL LOOP: PASSED' : '\nE2E PAGE TOOL LOOP: FAILED')
    ws.close()
    process.exit(pass ? 0 : 1)
  } catch (err) {
    console.error('E2E failed:', err.message)
    ws.close()
    process.exit(1)
  }
})

ws.on('error', (err) => {
  console.error('socket error:', err.message)
  process.exit(1)
})

// Safety timeout
setTimeout(() => {
  console.error('E2E timed out')
  process.exit(1)
}, 120000).unref()
