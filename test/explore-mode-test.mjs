/**
 * explore-mode-test.mjs — verify explore-mode workflow generation end-to-end.
 *
 * Simulates an LLM exploring a complex task: tries an action that FAILS,
 * observes, tries a DIFFERENT approach that SUCCEEDS, verifies the goal, then
 * explore_finish distills ONLY the successful steps into a saved workflow.
 *
 * This proves the core product insight: complex tasks are solved by
 * exploration (trial → error → correct), and the working path is extracted
 * while failed attempts are dropped.
 *
 * Requires: isolated DSH instance with dsh-browser-host mounted.
 */
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:4110'
const TOKEN_FILE = process.env.TOKEN_FILE || '/Users/jimmy/work/demo/dsh-browser-host/test/env/browser-client-token-4110'
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

// ── simulated extension: control WS answering explore tool page ops ──────────
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/ext-api-control?token=${encodeURIComponent(token)}`, {
  origin: 'chrome-extension://abcdefghijklmnop'
})
const toolLog = []
const pageState = { cartCount: 0, loggedIn: false }
ws.on('message', (data) => {
  const frame = JSON.parse(data.toString())
  if (frame.kind === 'tool-request') {
    toolLog.push(frame.tool)
    let result
    switch (frame.tool) {
      case 'page_navigate': result = { url: 'https://example.com/shop', title: 'Shop' }; break
      case 'page_eval': {
        // Answer based on the expression: simulate page state.
        const expr = String(frame.args && frame.args.expression || '')
        if (/cartCount/.test(expr)) result = pageState.cartCount
        else if (/loggedIn|login/.test(expr)) result = pageState.loggedIn
        else result = { x: 120, y: 240, found: true }
        break
      }
      case 'page_act': {
        const action = frame.args && frame.args.action
        const anchor = String(frame.args && frame.args.textAnchor || '')
        // Simulate: clicking 登录 button logs in; clicking 加入购物车 adds.
        if (/登录/.test(anchor)) { pageState.loggedIn = true; result = { ok: true, loggedIn: true } }
        else if (/购物车/.test(anchor) && pageState.loggedIn) { pageState.cartCount += 1; result = { ok: true, cart: pageState.cartCount } }
        else if (/购物车/.test(anchor) && !pageState.loggedIn) { result = { ok: false, error: '需要先登录' } }
        else result = { ok: true }
        break
      }
      case 'page_snapshot': result = { url: 'https://example.com/shop', title: 'Shop', elements: [{ role: 'button', label: '加入购物车', x: 100, y: 200 }] }; break
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

// ── 1. explore_start ─────────────────────────────────────────────────────────
const start = await rpc('workflow.explore.start', { goal: '把商品加入购物车' })
check('explore_start', start.ok === true, start.message)

// ── 2. try clicking 加入购物车 WITHOUT login → FAILS ────────────────────────
const fail = await rpc('workflow.explore.act', {
  action: 'click', textAnchor: '按钮「加入购物车」',
  note: '尝试直接加购', success: false
})
check('failed attempt recorded (success=false)', fail.success === false, fail.message)

// ── 3. observe: realize login needed → click 登录 → succeeds ────────────────
const login = await rpc('workflow.explore.act', {
  action: 'click', textAnchor: '按钮「登录」', note: '先登录', success: true
})
check('login step recorded (success=true)', login.success === true)

// ── 4. now add to cart → succeeds ───────────────────────────────────────────
const add = await rpc('workflow.explore.act', {
  action: 'click', textAnchor: '按钮「加入购物车」', note: '加入购物车', success: true
})
check('add-to-cart step recorded (success=true)', add.success === true)

// ── 5. verify goal via explore_check ────────────────────────────────────────
const chk = await rpc('workflow.explore.check', {
  condition: '购物车里有 1 件商品', expression: 'window.__cartCount', verified: pageState.cartCount > 0
})
check('explore_check verified', chk.verified === true)

// ── 6. explore_finish → distill ONLY successful steps ───────────────────────
const fin = await rpc('workflow.explore.finish', {
  name: '登录后加购',
  description: '先登录再加入购物车',
  successCriteria: ['购物车有商品']
})
check('explore_finish ok', fin.ok === true, JSON.stringify(fin.error || '').slice(0, 80))
check('distilled 2 steps (failed attempt dropped)', fin.stepCount === 2, `steps=${fin.stepCount}`)
check('summary mentions exploration', /探索/.test(fin.summary || ''), '')
console.log('\n=== 提炼的工作流 ===')
console.log((fin.summary || '').slice(0, 400))

// ── 7. verify the saved workflow in the store ───────────────────────────────
const list = await rpc('workflow.list', {})
const saved = (list.items || []).find((w) => w.id === fin.workflowId)
check('workflow persisted', !!saved, saved ? saved.name : 'NOT FOUND')
check('workflow has 2 steps only', saved && saved.steps.length === 2, `steps=${saved && saved.steps.length}`)

ws.close()
console.log(pass ? '\nEXPLORE MODE TEST: PASSED' : '\nEXPLORE MODE TEST: FAILED')
process.exit(pass ? 0 : 1)
