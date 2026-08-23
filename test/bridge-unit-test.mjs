/**
 * bridge-unit-test.mjs — verify the ToolBridge request/response lifecycle.
 *
 * Stands up an in-process WebSocket server that mimics the host's
 * /ext-api-control endpoint, attaches a real ToolBridge to it, and connects a
 * second socket as the "extension panel". Then drives bridge.request() the way
 * the page.* tools do and confirms:
 *  1. tool-request frame travels host → extension and the response resolves;
 *  2. error frames reject with code/message;
 *  3. no-response frames time out;
 *  4. disconnect fails outstanding requests.
 *
 * No DSH host process needed — pure bridge logic verification.
 */
import WebSocket, { WebSocketServer } from 'ws'
import { createToolBridge } from '../lib/bridge.js'

const port = 18765
const wss = new WebSocketServer({ port })
const bridge = createToolBridge({ log: (m) => console.log('  [bridge]', m) })

// Incoming extension connection = the host's real socket.
wss.on('connection', (hostSocket) => {
  console.log('✓ extension socket attached to host bridge')
  bridge.attach(hostSocket)
})

// Our simulated extension panel.
const ext = new WebSocket(`ws://127.0.0.1:${port}`)

ext.on('message', (data) => {
  const frame = JSON.parse(data.toString())
  if (frame.kind === 'tool-request') {
    console.log(`← ext received tool-request: ${frame.tool} (${frame.requestId})`)
    if (frame.tool === 'page.snapshot') {
      ext.send(JSON.stringify({ kind: 'tool-response', requestId: frame.requestId, ok: true, result: { url: 'https://example.com/', title: 'Example', elements: [] } }))
    } else if (frame.tool === 'page.eval') {
      ext.send(JSON.stringify({ kind: 'tool-response', requestId: frame.requestId, ok: false, error: { code: 'eval-error', message: 'syntax error' } }))
    }
    // page.wait → deliberately no response (timeout test)
  }
})

ext.on('open', async () => {
  console.log('✓ ext socket open')
  let pass = true

  // Test 1: successful round-trip
  try {
    const result = await bridge.request('page.snapshot', { includeVisibleText: false }, { timeoutMs: 3000 })
    console.log('✓ TEST 1 (success): page.snapshot ->', JSON.stringify(result).slice(0, 100))
  } catch (err) {
    console.error('✗ TEST 1 failed:', err.message)
    pass = false
  }

  // Test 2: error round-trip
  try {
    await bridge.request('page.eval', { expression: 'bad(' }, { timeoutMs: 3000 })
    console.error('✗ TEST 2 failed: expected error, got success')
    pass = false
  } catch (err) {
    if (err.code === 'eval-error') console.log('✓ TEST 2 (error): page.eval ->', err.code, '|', err.message)
    else { console.error('✗ TEST 2 unexpected code:', err.code, err.message); pass = false }
  }

  // Test 3: timeout when extension never answers
  const t3start = Date.now()
  try {
    await bridge.request('page.wait', { condition: 'delay' }, { timeoutMs: 1200 })
    console.error('✗ TEST 3 failed: expected timeout')
    pass = false
  } catch (err) {
    const elapsed = Date.now() - t3start
    if (elapsed >= 1100 && err.message.includes('timed out')) console.log(`✓ TEST 3 (timeout): aborted after ${elapsed}ms`)
    else { console.error(`✗ TEST 3 unexpected: ${err.message} (${elapsed}ms)`); pass = false }
  }

  // Test 4: disconnect fails outstanding requests
  const p = bridge.request('page.act', { action: 'click', x: 1, y: 1 }, { timeoutMs: 10000 }).then(
    () => { console.error('✗ TEST 4 failed: should reject on disconnect'); pass = false },
    (err) => { console.log(`✓ TEST 4 (disconnect): rejected with "${err.message}"`) }
  )
  ext.close()
  await p

  bridge.close()
  wss.close()
  console.log(pass ? '\nALL TESTS PASSED' : '\nSOME TESTS FAILED')
  process.exit(pass ? 0 : 1)
})
