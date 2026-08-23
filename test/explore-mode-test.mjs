/**
 * explore-mode-test.mjs — verify explore-mode workflow generation end-to-end.
 *
 * Simulates an LLM exploring a complex task:
 *  - Scenario A: navigate → fail → undo → correct approach → verify → distill.
 *    Proves navigation is recorded, failed attempts are dropped, and the
 *    distilled workflow starts from the correct URL (navigate+wait prefix).
 *  - Scenario B: explore_undo recovers from a wrong path.
 *
 * Requires: isolated DSH instance with dsh-browser-host mounted.
 */
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:4113'
const TOKEN_FILE = process.env.TOKEN_FILE || '/Users/jimmy/work/demo/dsh-browser-host/test/env/browser-client-token-4113'
const token = readFileSync(TOKEN_FILE, 'utf8').trim()

const rpc = async (method, payload) => {
  const res = await fetch(`${BASE}/ext-api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ rpcId: crypto.randomUUID(), method, payload })
  })
  const b = await res.json()
  if (!b.result || b.result.ok !== true) throw new Error(`${method}: ${JSON.stringify(b.result?.error || b)}`)
  return b.result.value
}

let pass = true
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) pass = false
}

// ── simulated extension ───────────────────────────────────────────────────────
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/ext-api-control?token=${encodeURIComponent(token)}`, {
  origin: 'chrome-extension://abcdefghijklmnop'
})
const pageState = { cartCount: 0, loggedIn: false, url: 'https://example.com/shop' }
ws.on('message', (data) => {
  const frame = JSON.parse(data.toString())
  if (frame.kind === 'tool-request') {
    let result
    switch (frame.tool) {
      case 'page_navigate': {
        const url = frame.args && frame.args.url
        if (frame.args && frame.args.action === 'back') { result = { url: pageState.url, title: 'Shop' } }
        else { pageState.url = url; result = { url, title: 'Shop' } }
        break
      }
      case 'page_eval': {
        const expr = String(frame.args && frame.args.expression || '')
        if (/cartCount/.test(expr)) result = pageState.cartCount
        else if (/loggedIn|login/.test(expr)) result = pageState.loggedIn
        else result = { x: 120, y: 240, found: true }
        break
      }
      case 'page_act': {
        const anchor = String(frame.args && frame.args.textAnchor || '')
        if (/登录/.test(anchor)) { pageState.loggedIn = true; result = { ok: true, loggedIn: true, url: pageState.url } }
        else if (/购物车/.test(anchor) && pageState.loggedIn) { pageState.cartCount += 1; result = { ok: true, cart: pageState.cartCount, url: pageState.url } }
        else if (/购物车/.test(anchor) && !pageState.loggedIn) { result = { ok: false, error: '需要先登录' } }
        else result = { ok: true, url: pageState.url }
        break
      }
      case 'page_snapshot': result = { url: pageState.url, title: 'Shop', elements: [{ role: 'button', label: '加入购物车', x: 100, y: 200 }] }; break
      case 'page_wait': result = { ok: true }; break
      default: result = { ok: true }
    }
    ws.send(JSON.stringify({ kind: 'tool-response', requestId: frame.requestId, ok: true, result }))
  } else if (frame.kind === 'ask-request') {
    const first = (frame.options && frame.options[0]) || '确认'
    ws.send(JSON.stringify({ kind: 'ask-response', requestId: frame.requestId, answer: first }))
  }
})
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
console.log('✓ simulated extension connected (page: 需先登录才能加购)')

// ── Scenario A: navigate → fail → correct → verify → distill ────────────────
console.log('\n=== Scenario A: 导航+试错+提炼 ===')
await rpc('workflow.explore.start', { goal: '登录后把商品加入购物车' })

// 1. navigate to the shop (recorded as a navigate step)
const nav = await rpc('workflow.explore.act', { action: 'navigate', text: 'https://example.com/shop', note: '打开商城', success: true })
check('navigate recorded', nav.success === true && nav.url === 'https://example.com/shop')

// 2. try add-to-cart without login → FAILS
const fail = await rpc('workflow.explore.act', {
  action: 'click', textAnchor: '按钮「加入购物车」', note: '尝试直接加购', success: false
})
check('failed attempt recorded (success=false)', fail.success === false)

// 3. login → success
const login = await rpc('workflow.explore.act', {
  action: 'click', textAnchor: '按钮「登录」', note: '先登录', success: true
})
check('login step recorded (success=true)', login.success === true)

// 4. add to cart → success
const add = await rpc('workflow.explore.act', {
  action: 'click', textAnchor: '按钮「加入购物车」', note: '加入购物车', success: true
})
check('add-to-cart step recorded (success=true)', add.success === true)

// 5. verify
const chk = await rpc('workflow.explore.check', {
  condition: '购物车里有 1 件商品', expression: 'window.__cartCount', verified: pageState.cartCount > 0
})
check('explore_check verified', chk.verified === true)

// 6. distill
const fin = await rpc('workflow.explore.finish', {
  name: '登录后加购', description: '先登录再加入购物车', successCriteria: ['购物车有商品']
})
check('explore_finish ok', fin.ok === true, JSON.stringify(fin.error || '').slice(0, 80))

// 7. verify the distilled workflow structure in the store
const list = await rpc('workflow.list', {})
const saved = (list.items || []).find((w) => w.id === fin.workflowId)
check('workflow persisted', !!saved)
check('workflow starts with navigate to start URL', saved && saved.steps[0] && saved.steps[0].kind === 'navigate' && saved.steps[0].url === 'https://example.com/shop', `step0=${saved && saved.steps[0] && saved.steps[0].kind}`)
check('workflow has navigate+wait prefix', saved && saved.steps.length >= 3 && saved.steps[1].kind === 'wait', `steps=${saved && saved.steps.length}`)
check('failed attempt dropped (no 尝试直接加购 note)', saved && !saved.steps.some((s) => (s.note || '').includes('尝试直接加购')), '')
check('target URL pattern derived from start URL', saved && saved.target && saved.target.urlPattern.includes('example.com'), saved && saved.target && saved.target.urlPattern)
check('success criteria from verified check', saved && saved.verify && saved.verify.successCriteria.length >= 1, JSON.stringify(saved && saved.verify && saved.verify.successCriteria))

// ── Scenario B: explore_undo recovers from a wrong path ──────────────────────
console.log('\n=== Scenario B: explore_undo 回退 ===')
await rpc('workflow.explore.start', { goal: '测试回退' })
await rpc('workflow.explore.act', { action: 'navigate', text: 'https://example.com/shop', note: '打开', success: true })
const wrong = await rpc('workflow.explore.act', { action: 'click', textAnchor: '按钮「错误操作」', note: '点错了', success: true })
check('wrong step recorded', wrong.success === true)
const undone = await rpc('workflow.explore.undo', { reason: '点错了，回退' })
check('explore_undo removes the step', undone.ok === true && undone.undone === wrong.seq, `undone=${undone.undone}`)
const finB = await rpc('workflow.explore.finish', { name: '回退测试' })
// After undo, only a navigate remains (no action) → finish correctly refuses
// to distill a meaningless navigate-only workflow.
check('finish refuses navigate-only workflow', finB.ok === false, JSON.stringify(finB.message || '').slice(0, 60))

ws.close()
console.log(pass ? '\nEXPLORE MODE TEST: PASSED' : '\nEXPLORE MODE TEST: FAILED')
process.exit(pass ? 0 : 1)

// ── Scenario C: 站点记忆 ─────────────────────────────────────────────────────
// (added at runtime by the runner below if desired — keep file stable)
