/**
 * tools.js — page_* tools registered by dsh-browser-host.
 *
 * Each tool is a thin relay: its execute() sends a `tool-request` over the
 * control-channel ToolBridge and resolves with the extension's result (which
 * ran in the real page via content script). The extension is the source of
 * truth for what the page looks like / what it can do.
 *
 * Tool names use underscores (page_snapshot) instead of dots: the Tencent
 * intranet gateway rejects tool names containing '.' (invalid_parameter_value).
 *
 * Tools:
 *   page_snapshot  — structured view of the current page (URL, title, visible
 *                    text summary, interactive elements with coordinates).
 *   page_eval      — run arbitrary JS in the page (MAIN world) and return the
 *                    JSON-serializable result.
 *   page_act       — click / type / scroll / key / clear at coordinates or via
 *                    selector.
 *   page_navigate  — go / back / forward / reload / open URL in tab.
 *   page_wait      — wait for a condition (selector / network idle / timeout).
 *   page_screenshot— capture the current viewport (or element) as PNG.
 *   page_network   — read the page's captured fetch/XHR activity (URL, method,
 *                    status, body previews) to understand the page's data flow.
 */

/** Canonical output projection: JSON text for the model. */
function jsonOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }]
  }
}

/**
 * Build one relay tool (a plain ToolDefinition; register through the
 * `tools` service's register()).
 * @param {ToolBridge} bridge
 * @param {{ timeoutMs?: number }} opts
 */
function relayTool(bridge, { timeoutMs }, name, description, parameters) {
  return {
    name,
    description,
    parameters,
    output: jsonOutput(),
    timeoutMs,
    isConcurrencySafe: () => false, // page ops mutate page state; never parallel
    execute: async (args, exec) => {
      const result = await bridge.request(name, args, {
        signal: exec && exec.signal,
        timeoutMs
      })
      return result
    }
  }
}

/**
 * Create the page.* tool definitions, ready for tools.register().
 * @param {ToolBridge} bridge
 * @param {{ timeoutMs?: number }} opts
 */
export function createPageTools(bridge, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000

  return [
    relayTool(bridge, { timeoutMs }, 'page_snapshot', [
      'Build a structured snapshot of the current page: URL, title, language,',
      'visible text summary, and a numbered list of interactive elements',
      '(links, buttons, inputs, selects, textareas, [role] landmarks) with their',
      'viewport coordinates and best-effort CSS selectors.',
      'Use this first to understand what the user is looking at. Coordinates are',
      'relative to the current viewport and can be passed to page.act for clicks.'
    ].join(' '), {
      type: 'object',
      properties: {
        includeVisibleText: {
          type: 'boolean',
          description: 'Include the full visible text (default true; may be large on long pages).'
        },
        maxElements: {
          type: 'integer',
          description: 'Cap on interactive elements returned (default 80).'
        }
      },
      additionalProperties: false
    }),

    relayTool(bridge, { timeoutMs }, 'page_eval', [
      'Run a JavaScript expression in the current page (MAIN world, so page',
      'globals and internal state are visible) and return the JSON-serializable',
      'result. Use it to read page data that the DOM does not expose directly:',
      'framework stores, API responses, computed values. The expression runs as',
      '`(function(){ ... })()` — end with a return value. The result must be',
      'JSON-serializable; use JSON.stringify on complex objects. Throwing inside',
      'the expression surfaces as a tool error.'
    ].join(' '), {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'JavaScript expression (function body) to evaluate in the page.'
        }
      },
      required: ['expression'],
      additionalProperties: false
    }),

    relayTool(bridge, { timeoutMs }, 'page_act', [
      'Perform a user action on the current page: click, type, scroll, key, or',
      'clear. Target by viewport coordinates (x,y — from page.snapshot or a',
      'screenshot) or by CSS selector for stable elements.',
      'Actions: click (x,y or selector), type (selector + text; or focus then',
      'keyboard), scroll (by x,y / direction / element), key (Enter/Escape/Tab/…),',
      'clear (selector), hover (x,y or selector).',
      'After the action the result contains the new page state summary so the',
      'model can verify the effect.'
    ].join(' '), {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'type', 'scroll', 'key', 'clear', 'hover'],
          description: 'The action to perform.'
        },
        x: { type: 'number', description: 'Viewport x coordinate (click/hover/scroll-to).' },
        y: { type: 'number', description: 'Viewport y coordinate (click/hover/scroll-to).' },
        selector: { type: 'string', description: 'CSS selector targeting the element.' },
        text: { type: 'string', description: 'Text to type (type action) or key name (key action).' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
        amount: { type: 'integer', description: 'Scroll amount in px (default viewport fraction).' },
        key: { type: 'string', description: 'Keyboard key name for key action (Enter, Escape, Tab, ArrowDown…).' }
      },
      required: ['action'],
      additionalProperties: false
    }),

    relayTool(bridge, { timeoutMs }, 'page_navigate', [
      'Navigate the current tab: go to a URL, back, forward, or reload. The',
      'result reports the final URL and title after load settles.'
    ].join(' '), {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['go', 'back', 'forward', 'reload'],
          description: 'Navigation action.'
        },
        url: { type: 'string', description: 'Target URL for action=go.' }
      },
      required: ['action'],
      additionalProperties: false
    }),

    relayTool(bridge, { timeoutMs }, 'page_wait', [
      'Wait for a page condition before continuing: a CSS selector to appear,',
      'network idle, or a fixed delay. Returns once the condition is met or the',
      'timeout expires (with ok:false on timeout).'
    ].join(' '), {
      type: 'object',
      properties: {
        condition: {
          type: 'string',
          enum: ['selector', 'network-idle', 'delay', 'load'],
          description: 'What to wait for.'
        },
        selector: { type: 'string', description: 'Selector for condition=selector.' },
        timeout: { type: 'integer', description: 'Max wait in ms (default 10000).' }
      },
      required: ['condition'],
      additionalProperties: false
    }),

    relayTool(bridge, { timeoutMs }, 'page_screenshot', [
      'Capture the current page as a PNG image. Saves the file into the DSH',
      'workspace and returns the path plus a small JSON preview. Use with a',
      'vision-capable model to see the page visually (layout, popups, visual',
      'state that text snapshots miss).',
      'mode: viewport (default) captures the visible area; element captures one',
      'element by selector; full captures the whole scrollable page.'
    ].join(' '), {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['viewport', 'element', 'full'],
          description: 'Capture mode.'
        },
        selector: { type: 'string', description: 'Element selector for mode=element.' },
        name: { type: 'string', description: 'File name (default page-<timestamp>.png).' }
      },
      additionalProperties: false
    }),

    relayTool(bridge, { timeoutMs }, 'page_network', [
      'Read the network activity of the current page: fetch/XHR requests the',
      'page has made, with URL, method, status, request/response body previews.',
      'Use it to understand what APIs the page calls and what data they return',
      '(e.g. a feed endpoint, a search API, an upload).',
      'query: "all" (default) returns the newest captured entries; "recent" is',
      'an alias. filterUrl keeps only URLs containing the substring. clear'
    ].join(' '), {
      type: 'object',
      properties: {
        filterUrl: { type: 'string', description: 'Only entries whose URL contains this substring.' },
        limit: { type: 'integer', description: 'Max entries to return (default 30, cap 100).' },
        clear: { type: 'boolean', description: 'Clear the captured log and return (no entries).' }
      },
      additionalProperties: false
    }),

    relayTool(bridge, { timeoutMs }, 'page_record', [
      'Record the user manually demonstrating a task on the current page.',
      'mode=start begins capturing the user\'s real clicks/typing/scrolling/',
      'navigation as multi-signature element targets (semantic role+name, text',
      'anchor, selector, position) — the raw material for building a workflow.',
      'mode=stop ends recording and returns the captured action sequence.',
      'Use this to "record" a repetitive task once so it can be turned into a',
      'saved workflow and replayed automatically.'
    ].join(' '), {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['start', 'stop'], description: 'start or stop recording.' }
      },
      additionalProperties: false
    }),

    relayTool(bridge, { timeoutMs }, 'page_highlight', [
      'Draw a pulsing outline on the element at the given viewport coordinates',
      '(x,y) or matching a CSS selector, so the user can see exactly which page',
      'element the assistant is about to act on before any destructive action.',
      'Pass clear=true to remove the highlight.'
    ].join(' '), {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Viewport x coordinate.' },
        y: { type: 'number', description: 'Viewport y coordinate.' },
        selector: { type: 'string', description: 'CSS selector to highlight instead of coordinates.' },
        clear: { type: 'boolean', description: 'Remove any active highlight.' }
      },
      additionalProperties: false
    })
  ]
}
