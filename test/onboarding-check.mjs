/**
 * onboarding-check.mjs — verify the panel onboarding + explore UI renders.
 * Requires: 360Chrome on :9224 with the extension loaded, DSH on :4116.
 */
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9224'
const HOST = 'http://127.0.0.1:4116'
const TOKEN_FILE = '/Users/jimmy/work/demo/dsh-browser-host/test/env/browser-client-token-4116'
const token = readFileSync(TOKEN_FILE, 'utf8').trim()

async function listTargets() { return (await (await fetch(`${CDP}/json`)).json()) }
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  let mid = 0; const pending = new Map()
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++mid; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  await send('Runtime.enable')
  return { send, close: () => ws.close() }
}

let pass = true
const check = (n, c, d = '') => { console.log(`${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!c) pass = false }

// Find the panel iframe.
let targets = await listTargets()
let panel = targets.find(t => t.url.includes('panel.html'))
if (!panel) {
  console.log('panel not found; opening demo page to trigger injection…')
  await fetch(`${CDP}/json/new?file:///tmp/dsh-demo-shop.html`, { method: 'PUT' })
  await new Promise(r => setTimeout(r, 4000))
  targets = await listTargets()
  panel = targets.find(t => t.url.includes('panel.html'))
}
if (!panel) { console.log('✗ no panel iframe'); process.exit(1) }
const pn = await attach(panel)
await new Promise(r => setTimeout(r, 2000))

// Configure host + token so the panel connects.
await pn.send('Runtime.evaluate', {
  expression: `(async () => {
    await chrome.runtime.sendMessage({ type: 'dsh:set-config', patch: { baseUrl: ${JSON.stringify(HOST)}, token: ${JSON.stringify(token)}, dirHint: '/tmp/dsh-page-tools-demo' } });
    return true;
  })()`, awaitPromise: true, returnByValue: true
})

// Reload panel to pick up new HTML (onboarding card).
await pn.send('Runtime.evaluate', { expression: 'location.reload()', returnByValue: true })
await new Promise(r => setTimeout(r, 4000))

// Check onboarding card presence.
const ui = await pn.send('Runtime.evaluate', {
  expression: `(() => {
    const ob = document.getElementById('onboarding');
    const chips = ob ? [...ob.querySelectorAll('.ob-chip')] : [];
    const inputPh = document.getElementById('input') ? document.getElementById('input').placeholder : '';
    const stepsEl = document.getElementById('explore-steps');
    return JSON.stringify({
      onboardingVisible: ob ? !ob.hidden : false,
      chipCount: chips.length,
      chipTexts: chips.map(c => c.textContent.slice(0, 20)),
      inputPlaceholder: inputPh.slice(0, 40),
      exploreStepsExists: !!stepsEl
    });
  })()`, returnByValue: true
})
const s = JSON.parse(ui.result.value)
check('onboarding card visible (first run)', s.onboardingVisible === true)
check('has 4 example chips', s.chipCount >= 4, `chips=${s.chipCount}`)
check('chips contain everyday-language examples', s.chipTexts.some(t => /订单|抓|搬/.test(t)), s.chipTexts.join(' | '))
check('input placeholder is conversational', /订单|重复|自动/.test(s.inputPlaceholder), s.inputPlaceholder)
check('explore-steps container exists', s.exploreStepsExists === true)

// Click a chip → should fill input and hide onboarding.
const click = await pn.send('Runtime.evaluate', {
  expression: `(() => {
    const ob = document.getElementById('onboarding');
    const chip = ob ? ob.querySelector('.ob-chip') : null;
    if (!chip) return 'no chip';
    chip.click();
    const input = document.getElementById('input');
    return JSON.stringify({ inputVal: input.value, obHidden: ob.hidden });
  })()`, returnByValue: true
})
const c = JSON.parse(click.result.value)
check('chip click fills input', c.inputVal.length > 0, c.inputVal.slice(0, 30))
check('chip click hides onboarding', c.obHidden === true)

// Verify the panel connects to host.
const conn = await pn.send('Runtime.evaluate', {
  expression: `JSON.stringify({ status: document.getElementById('conn-status') ? document.getElementById('conn-status').textContent : 'none' })`,
  returnByValue: true
})
const cs = JSON.parse(conn.result.value)
check('panel connects to host', /工作区|已连接|连接/.test(cs.status), cs.status)

pn.close()
console.log(pass ? '\nONBOARDING UI CHECK: PASSED' : '\nONBOARDING UI CHECK: FAILED')
process.exit(pass ? 0 : 1)
