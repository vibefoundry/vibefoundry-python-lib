// Entry point for the VibeFoundry PANE (Codex / ChatGPT desktop app).
//
// It installs a thin shim layer so the UNMODIFIED <App/> runs inside the
// sandboxed widget iframe, then mounts the same app the standalone build uses:
//   - fetch('/api/...')   -> window.openai.callTool('vf_request', ...)  (the
//     sandbox blocks direct localhost; the MCP server proxies for us)
//   - /api/auth/status    -> faked "signed in" (no browser sign-in flow in a pane)
//   - WebSocket           -> inert (sandbox blocks ws to localhost)
//   - requestDisplayMode  -> fullscreen on load
//
// This file is ONLY used by vite.pane.config.js. The standalone app (main.jsx)
// never loads it, so none of this affects the normal pip-installed IDE.

import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// --- wait for the Apps SDK host bridge ---------------------------------------
function awaitOpenai(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now()
    ;(function poll() {
      if (window.openai && typeof window.openai.callTool === 'function') {
        return resolve(window.openai)
      }
      if (Date.now() - start > timeoutMs) return resolve(null)
      setTimeout(poll, 50)
    })()
  })
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// --- fetch shim: route every /api call through the MCP proxy -----------------
const origFetch = window.fetch ? window.fetch.bind(window) : null

const shimFetch = async function (input, init) {
  init = init || {}
  const url = typeof input === 'string' ? input : (input && input.url) || ''
  const isApi =
    url.startsWith('/api') ||
    url.startsWith('http://127.0.0.1') ||
    url.startsWith('http://localhost')

  if (!isApi) {
    return origFetch ? origFetch(input, init) : Promise.reject(new Error('offline: ' + url))
  }

  // No browser sign-in flow exists inside a pane, so short-circuit the auth
  // poll rather than let the IDE sit on its sign-in gate forever.
  if (url.startsWith('/api/auth/status')) {
    return jsonResponse({ signedIn: true })
  }

  // Normalize to a backend-relative path (drop any absolute origin prefix).
  let path = url.replace(/^https?:\/\/[^/]+/, '')
  if (path[0] !== '/') path = '/' + path

  const method = (
    init.method ||
    (typeof input === 'object' && input.method) ||
    'GET'
  ).toUpperCase()

  let body = init.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch (e) { /* keep raw string */ }
  }

  const api = await awaitOpenai()
  if (!api) return jsonResponse({ error: 'host bridge unavailable' }, 503)

  // Build args WITHOUT undefined values — the host rejects undefined params
  // ("Invalid MCP tool call params").
  const args = { path, method }
  if (body !== undefined && body !== null) args.body = body

  try {
    const res = await api.callTool('vf_request', args)
    const sc =
      (res && (res.structuredContent || (res.result && res.result.structuredContent))) ||
      res ||
      {}
    const payload = sc.json != null ? sc.json : (sc.text != null ? sc.text : '')
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return new Response(text, {
      status: sc.status || 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return jsonResponse({ error: String((err && err.message) || err) }, 502)
  }
}

window.fetch = shimFetch

// --- WebSocket shim: inert, never connects, never reconnect-loops ------------
function InertWebSocket(url) {
  this.url = url
  this.readyState = 0 // CONNECTING forever — no open/close/error events fire
  this.onopen = null
  this.onmessage = null
  this.onclose = null
  this.onerror = null
}
InertWebSocket.prototype.send = function () {}
InertWebSocket.prototype.close = function () { this.readyState = 3 }
InertWebSocket.prototype.addEventListener = function () {}
InertWebSocket.prototype.removeEventListener = function () {}
InertWebSocket.CONNECTING = 0
InertWebSocket.OPEN = 1
InertWebSocket.CLOSING = 2
InertWebSocket.CLOSED = 3
window.WebSocket = InertWebSocket

// --- Inline = a single launch button; the full IDE mounts only in the pane ---
const FONT =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'

function goFullscreen() {
  try {
    if (window.openai && window.openai.requestDisplayMode) {
      window.openai.requestDisplayMode({ mode: 'fullscreen' })
    }
  } catch (e) { /* host may ignore */ }
}

function LaunchScreen() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        minHeight: '190px',
        height: '100%',
        width: '100%',
        margin: 0,
        background: '#ffffff',
        fontFamily: FONT,
      }}
    >
      <button
        onClick={launch}
        style={{
          font: `600 15px ${FONT}`,
          padding: '13px 24px',
          background: '#0d0d0d',
          color: '#fff',
          border: 'none',
          borderRadius: '10px',
          cursor: 'pointer',
          boxShadow: '0 2px 10px rgba(0,0,0,.12)',
        }}
      >
        Open VibeFoundry
      </button>
    </div>
  )
}

const root = createRoot(document.getElementById('root'))
let launched = false
let currentView = null

// Show the launch button inline; mount the real IDE once the user launches it
// (or the host expands the widget to fullscreen). Driven by display mode so it
// stays in sync however the pane is expanded.
function render() {
  const mode = (window.openai && window.openai.displayMode) || 'inline'
  const view = launched || mode === 'fullscreen' ? 'app' : 'launch'
  if (view === currentView) return
  currentView = view
  root.render(view === 'app' ? <App /> : <LaunchScreen />)
}

function launch() {
  launched = true
  goFullscreen()
  render()
}

window.addEventListener('openai:set_globals', render)
render()
