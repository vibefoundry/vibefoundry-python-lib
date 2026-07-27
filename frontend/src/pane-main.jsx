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

// --- the one place that talks to the host bridge -----------------------------
// Everything below funnels through here, so the pane has exactly one route to
// the backend and the shims stay thin.
async function backendRequest(path, method = 'GET', body) {
  const api = await awaitOpenai()
  if (!api) return { status: 503, json: { error: 'host bridge unavailable' } }

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
    return { status: sc.status || 200, json: sc.json, text: sc.text }
  } catch (err) {
    return { status: 502, json: { error: String((err && err.message) || err) } }
  }
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

  // The server answers a profile request with "started, watch the websocket".
  // Ours is a polling bridge, so notice the request going past and start
  // watching on the app's behalf. See watchProfile below.
  if (method === 'POST' && path.split('?')[0] === '/api/dataframe/profile') {
    const filePath = body && body.filePath
    if (filePath) watchProfile(filePath)
  }

  const res = await backendRequest(path, method, body)
  const payload = res.json != null ? res.json : (res.text != null ? res.text : '')
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

window.fetch = shimFetch

// --- WebSocket shim: a polling bridge, not a dead stub -----------------------
//
// The sandbox blocks websockets to localhost, so the app can never receive the
// events the server pushes. It used to get an inert stub, which meant anything
// waiting on a pushed event waited forever — the large-file preview modal sat
// on its spinner indefinitely the first time you opened a big file.
//
// Instead: a fake socket that reports OPEN and delivers messages we synthesize
// by polling. Consumers cannot tell the difference, so App.jsx and the modal
// work unmodified — which matters, because they are the standalone IDE's code
// and this file is the only place allowed to know it is running in a pane.
const paneSockets = new Set()

function PaneSocket(url) {
  this.url = url
  this.readyState = 1 // OPEN — never CLOSED, so App.jsx's reconnect never fires
  this.onopen = null
  this.onmessage = null
  this.onclose = null
  this.onerror = null
  paneSockets.add(this)
  setTimeout(() => { if (this.onopen) try { this.onopen({}) } catch (e) {} }, 0)
}
PaneSocket.prototype.send = function () {}
PaneSocket.prototype.close = function () {
  this.readyState = 3
  paneSockets.delete(this)
}
PaneSocket.prototype.addEventListener = function () {}
PaneSocket.prototype.removeEventListener = function () {}
PaneSocket.CONNECTING = 0
PaneSocket.OPEN = 1
PaneSocket.CLOSING = 2
PaneSocket.CLOSED = 3
window.WebSocket = PaneSocket

/** Deliver a synthesized server message to every live socket. */
function pushToPane(message) {
  const data = JSON.stringify(message)
  paneSockets.forEach((sock) => {
    if (sock.readyState !== 1 || typeof sock.onmessage !== 'function') return
    try { sock.onmessage({ data }) } catch (e) { /* a listener threw; keep going */ }
  })
}

// One watcher per file, so repeated clicks don't stack pollers.
const profileWatches = new Set()

/**
 * Poll a profile to completion and emit the event the server would have pushed.
 *
 * No synthetic progress: the modal renders a literal chunk count ("3 / 10
 * chunks"), and inventing those numbers would put a falsehood on screen. So the
 * bar sits at zero until the profile lands, then the modal moves on. Profiling
 * 5M rows takes well under a second, so this is only visible on enormous files.
 */
async function watchProfile(filePath) {
  if (profileWatches.has(filePath)) return
  profileWatches.add(filePath)

  const deadline = Date.now() + 10 * 60 * 1000
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400))
      const res = await backendRequest(
        `/api/dataframe/profile/result?filePath=${encodeURIComponent(filePath)}`
      )
      const profile = res && res.json && res.json.profile
      if (profile && profile.columns) {
        pushToPane({ type: 'profile_complete', filePath, profile })
        return
      }
    }
  } finally {
    profileWatches.delete(filePath)
  }
}

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
