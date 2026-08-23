/**
 * content.js — injects the DSH floating bubble + panel into every page.
 *
 * Uses a closed Shadow DOM so page styles/scripts cannot interfere. The panel
 * body is an <iframe> loading the extension's panel.html (chrome-extension://
 * origin), which runs the real DSH chat UI. The iframe lets the panel use
 * fetch/WebSocket to the host without page CSP restrictions.
 */
(function () {
  'use strict'
  if (window.__DSH_BROWSER_CONTENT__) return
  window.__DSH_BROWSER_CONTENT__ = true

  const HOST = chrome.runtime.getURL('panel/panel.html')

  function createShadowHost() {
    // Outer fixed-position container (in page DOM, but unstyled except position).
    const host = document.createElement('div')
    host.id = 'dsh-browser-client-root'
    host.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;' +
      'pointer-events:none;'
    const shadow = host.attachShadow({ mode: 'closed' })
    document.documentElement.appendChild(host)
    return { host, shadow }
  }

  function buildUi(shadow) {
    const style = document.createElement('style')
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .dsh-bubble {
        position: fixed;
        right: 24px; bottom: 24px;
        width: 52px; height: 52px;
        border-radius: 50%;
        background: linear-gradient(135deg, #4f6ef7, #7b5ef0);
        color: #fff;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(79, 110, 247, 0.45);
        border: none; outline: none;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
        z-index: 10;
        pointer-events: auto;
        font-size: 22px; font-weight: 700;
        user-select: none;
      }
      .dsh-bubble:hover { transform: scale(1.08); box-shadow: 0 8px 26px rgba(79,110,247,0.6); }
      .dsh-bubble .dot {
        position: absolute; top: 4px; right: 4px;
        width: 12px; height: 12px; border-radius: 50%;
        background: #34d399; border: 2px solid #fff;
        display: none;
      }
      .dsh-bubble.busy .dot { display: block; background: #f59e0b; }
      .dsh-panel {
        position: fixed;
        right: 24px; bottom: 88px;
        width: 420px; height: min(640px, calc(100vh - 120px));
        background: #fff;
        border-radius: 16px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.22);
        border: 1px solid rgba(0,0,0,0.08);
        display: none;
        flex-direction: column;
        overflow: hidden;
        z-index: 10;
        pointer-events: auto;
      }
      .dsh-panel.open { display: flex; }
      .dsh-panel iframe {
        width: 100%; height: 100%;
        border: none;
        background: #fff;
      }
      .dsh-bubble.minimized { display: none; }
    `
    shadow.appendChild(style)

    // Bubble
    const bubble = document.createElement('button')
    bubble.className = 'dsh-bubble'
    bubble.innerHTML = 'DSH'
    const dot = document.createElement('span')
    dot.className = 'dot'
    bubble.appendChild(dot)
    shadow.appendChild(bubble)

    // Panel iframe
    const panel = document.createElement('div')
    panel.className = 'dsh-panel'
    const iframe = document.createElement('iframe')
    iframe.src = HOST
    iframe.setAttribute('allow', 'clipboard-write')
    panel.appendChild(iframe)
    shadow.appendChild(panel)

    let open = false
    function toggle() {
      open = !open
      panel.classList.toggle('open', open)
      bubble.classList.toggle('minimized', open)
      if (open) {
        // Focus the panel iframe so keyboard works immediately.
        try { iframe.contentWindow.focus() } catch {}
      }
    }
    bubble.addEventListener('click', (e) => {
      e.stopPropagation()
      toggle()
    })

    // Pass the current tab's URL into the panel so it can resolve the workspace.
    const syncUrl = () => {
      try {
        iframe.contentWindow.postMessage({ type: 'dsh:page-url', url: location.href, title: document.title }, '*')
      } catch {}
    }
    window.addEventListener('message', (e) => {
      if (e.source === iframe.contentWindow && e.data && e.data.type === 'dsh:ping') {
        syncUrl()
      }
    })
    syncUrl()
    // Refresh on SPA navigation
    let lastUrl = location.href
    const navObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href
        syncUrl()
      }
    })
    navObserver.observe(document.documentElement, { childList: true, subtree: true })

    // Busy indicator + collapse from panel messages
    window.addEventListener('message', (e) => {
      if (e.source !== iframe.contentWindow) return
      if (e.data && e.data.type === 'dsh:busy') {
        bubble.classList.toggle('busy', !!e.data.busy)
      } else if (e.data && e.data.type === 'dsh:collapse') {
        if (open) toggle()
      }
    })

    return { bubble, panel, iframe }
  }

  try {
    const { host, shadow } = createShadowHost()
    buildUi(shadow)
  } catch (err) {
    console.error('[dsh-browser-client] init failed', err)
  }
})()
