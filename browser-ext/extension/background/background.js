/**
 * background.js — MV3 service worker for DSH Browser Client.
 *
 * Owns:
 *  - host base URL + token (read from the token file by the user, or from the
 *    host plugin log; persisted in chrome.storage)
 *  - URL pattern → local directory mapping rules (for auto workspace binding)
 *  - per-tab session/workspace cache (so the panel can reuse a session per page)
 */

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3080',
  token: '',
  // Rules: [{ pattern: 'github.com/foo/*', dir: '~/work/foo' }]
  rules: []
}

async function getConfig() {
  const stored = await chrome.storage.local.get('dshConfig')
  return { ...DEFAULTS, ...(stored.dshConfig || {}) }
}

async function setConfig(patch) {
  const cur = await getConfig()
  const next = { ...cur, ...patch }
  await chrome.storage.local.set({ dshConfig: next })
  return next
}

/** Expand ~ and env-ish vars in a directory string. */
function expandDir(dir) {
  if (dir.startsWith('~/')) {
    // Best effort: chrome doesn't expose HOME; the user config can use a full path.
    return dir
  }
  return dir
}

/** Match a URL against a rule pattern; return the mapped dir or null. */
function matchRule(url, rules) {
  const u = new URL(url)
  const host = u.hostname
  const path = u.pathname
  for (const rule of rules || []) {
    const p = rule.pattern || ''
    // Simple wildcard matcher: 'host/path/*' or 'host/*'
    let hostPart = p
    let pathPart = ''
    const star = p.indexOf('/*')
    if (star !== -1) {
      hostPart = p.slice(0, star)
      pathPart = p.slice(star + 1) // '/*' → '/' or deeper
    }
    if (host.startsWith(hostPart)) {
      const need = pathPart || '/'
      if (path.startsWith(need)) return rule.dir
    }
  }
  return null
}

/** Resolve the workspace directory for a page URL: rule → default hint. */
async function resolveDirForUrl(url) {
  const cfg = await getConfig()
  const matched = matchRule(url, cfg.rules)
  if (matched) return { dir: expandDir(matched), via: 'rule' }
  return { dir: null, via: 'none' }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    switch (msg.type) {
      case 'dsh:get-config':
        sendResponse(await getConfig())
        break
      case 'dsh:set-config':
        sendResponse(await setConfig(msg.patch))
        break
      case 'dsh:set-rules':
        sendResponse(await setConfig({ rules: msg.rules }))
        break
      case 'dsh:resolve-dir':
        sendResponse(await resolveDirForUrl(msg.url))
        break
      case 'dsh:screenshot': {
        sendResponse(await captureScreenshot(msg))
        break
      }
      default:
        sendResponse({ ok: false, error: 'unknown message ' + msg.type })
    }
  })()
  return true // async response
})

/**
 * Capture the current tab. MV3 background can captureVisibleTab; full-page
 * capture would need content-script stitching — phase 2, we start with
 * viewport + element-clipped captures.
 */
async function captureScreenshot(msg) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs && tabs[0]
    if (!tab || !tab.id) return { ok: false, error: 'no active tab' }
    // The capture must happen with the tab active & visible. If it is not,
    // fall back to an error the model can act on.
    if (!tab.active) return { ok: false, error: 'tab not active; cannot capture' }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    return { ok: true, dataUrl, mode: msg.mode || 'viewport', name: msg.name || null }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}
