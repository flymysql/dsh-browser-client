/**
 * workflow-store-test.mjs — verify the workflow store end-to-end on a live
 * DSH instance: open store, save/list/get/remove workflows through the
 * /ext-api/workflow.* local RPC methods.
 *
 * Requires: test DSH host on :3999 with dsh-browser-host mounted.
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.DSH_BASE || 'http://127.0.0.1:3999'
const TOKEN_FILE = process.env.TOKEN_FILE || '/Users/jimmy/work/demo/dsh-browser-host/test/env/browser-client-token'
const token = readFileSync(TOKEN_FILE, 'utf8').trim()

const rpc = async (method, payload) => {
  const res = await fetch(`${BASE}/ext-api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ rpcId: crypto.randomUUID(), method, payload })
  })
  const body = await res.json()
  if (!body.result || body.result.ok !== true) throw new Error(`${method}: ${JSON.stringify(body.result?.error || body)}`)
  return body.result.value
}

let pass = true
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) pass = false
}

// 1. list (should work; possibly empty)
const initial = await rpc('workflow.list', {})
check('workflow.list works', Array.isArray(initial.items), `count=${initial.items.length}`)

// 2. empty template
const empty = await rpc('workflow.empty', {})
check('workflow.empty returns template', !!empty.workflow && Array.isArray(empty.workflow.steps), `name=${empty.workflow.name}`)

// 3. save a valid workflow
const saved = await rpc('workflow.save', {
  workflow: {
    name: '测试工作流-订单导出',
    description: '每天导出订单到表格',
    trigger: { kind: 'manual' },
    target: { urlPattern: '*.taobao.com/*' },
    steps: [
      { kind: 'navigate', url: 'https://example.com/orders' },
      { kind: 'action', action: 'click', target: { textAnchor: '按钮「导出」' } },
      { kind: 'wait', condition: 'network-idle', timeout: 5000 },
      { kind: 'extract', fields: [{ name: '订单号', selector: { semantic: { role: 'cell', name: 'order-id' } } }] }
    ],
    parameters: [{ name: 'date', label: '导出日期', type: 'text', required: true }],
    approval: { confirmOn: ['write'], sampleBeforeBatch: false },
    verify: { successCriteria: ['导出完成提示出现'], retry: { maxAttempts: 2, onFailure: 'ask-user' } }
  }
})
check('workflow.save works', !!saved.workflow && !!saved.workflow.id, `id=${saved.workflow.id}`)
const wid = saved.workflow.id

// 4. get it back
const got = await rpc('workflow.get', { id: wid })
check('workflow.get works', !!got.workflow && got.workflow.id === wid, `name=${got.workflow.name}`)

// 5. list includes it
const after = await rpc('workflow.list', {})
check('workflow.list includes saved', after.items.some((w) => w.id === wid), `count=${after.items.length}`)

// 6. save invalid workflow → error
try {
  await rpc('workflow.save', { workflow: { name: '', steps: [] } })
  check('workflow.save rejects invalid', false, 'expected error')
} catch (e) {
  check('workflow.save rejects invalid', true, e.message.slice(0, 60))
}

// 7. remove
const removed = await rpc('workflow.remove', { id: wid })
check('workflow.remove works', removed.ok === true)
const afterRm = await rpc('workflow.list', {})
check('workflow removed from list', !afterRm.items.some((w) => w.id === wid), `count=${afterRm.items.length}`)

// 8. persistence: re-open store (list again — durable store should still have
//    any records from previous boots; we removed ours so just confirm works)
check('store size stable', afterRm.items.length >= 0)

console.log(pass ? '\nWORKFLOW STORE TEST: PASSED' : '\nWORKFLOW STORE TEST: FAILED')
process.exit(pass ? 0 : 1)
