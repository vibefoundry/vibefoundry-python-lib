import { useState, useEffect } from 'react'
import { getEvents, environment } from '../utils/diagnostics'

// What the IDE and its relay have been doing, in one copyable block.
//
// Two sources, because the interesting bugs live between them: the UI knows what
// it asked for, and the plugin relay knows which backend it asked. A wrong
// folder looks perfectly healthy from either side alone — it is only when you
// see "the workspace root is X" next to "the backend is serving Y" that the
// problem is obvious.
//
// /__plugin/log is answered by the MCP relay itself rather than the backend, so
// it is only there when running as a pane. In a browser that fetch 404s and the
// panel simply shows the UI half.

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function LogsModal({ onClose }) {
  const [plugin, setPlugin] = useState(null)
  const [pluginError, setPluginError] = useState(null)
  const [backendHealth, setBackendHealth] = useState(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      // Ask both halves. Either can fail without taking the panel down with it —
      // a diagnostics screen that goes blank when something is broken is worse
      // than useless, since something being broken is why it is open.
      const [pluginRes, healthRes] = await Promise.allSettled([
        fetch('/__plugin/log').then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
        fetch('/api/health').then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
      ])
      if (cancelled) return
      if (pluginRes.status === 'fulfilled') setPlugin(pluginRes.value)
      else setPluginError(String(pluginRes.reason && pluginRes.reason.message))
      if (healthRes.status === 'fulfilled') setBackendHealth(healthRes.value)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  const report = {
    capturedAt: new Date().toISOString(),
    environment: environment(),
    backend: backendHealth,
    plugin: plugin || { unavailable: pluginError },
    uiEvents: getEvents(),
  }
  const text = pretty(report)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard is often blocked inside the pane's sandbox. Fall back to
      // selecting the text so a manual copy still works.
      const el = document.getElementById('vf-logs-text')
      if (el) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // The headline: which folder each side thinks it is working on. Nearly every
  // "why is it showing the wrong project" question is answered by these two
  // lines disagreeing, so they go above the raw dump rather than inside it.
  const root = plugin && Array.isArray(plugin.roots) && plugin.roots.length ? plugin.roots[0] : null
  const serving = backendHealth && backendHealth.project_folder
  const disagree = root && serving && root.replace(/^\/private/, '') !== serving.replace(/^\/private/, '')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: '780px', width: '92%' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Logs</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body" style={{ paddingTop: '16px' }}>
          <div style={{ marginBottom: '16px', fontSize: '13px', lineHeight: 1.7 }}>
            <div>
              <span style={{ color: 'var(--color-text-muted)' }}>Workspace root: </span>
              <code>{root || (plugin ? 'not reported by the host' : '—')}</code>
            </div>
            <div>
              <span style={{ color: 'var(--color-text-muted)' }}>Backend is serving: </span>
              <code>{serving || '—'}</code>
              {backendHealth && backendHealth.version ? (
                <span style={{ color: 'var(--color-text-subtle)' }}> (v{backendHealth.version})</span>
              ) : null}
            </div>
            {disagree && (
              <div style={{ marginTop: '8px', color: '#b42318', fontWeight: 600 }}>
                These disagree — the IDE is showing a different folder than the workspace.
              </div>
            )}
          </div>

          <pre
            id="vf-logs-text"
            style={{
              background: 'var(--color-bg-subtle)',
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '12px',
              margin: 0,
              fontSize: '11px',
              lineHeight: 1.5,
              maxHeight: '46vh',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              userSelect: 'text',
            }}
          >
            {loading ? 'Collecting…' : text}
          </pre>
        </div>

        <div className="modal-footer">
          <span style={{ marginRight: 'auto', fontSize: '12px', color: 'var(--color-text-subtle)' }}>
            {getEvents().length} UI events
            {plugin ? `, ${(plugin.log || []).length} relay events` : pluginError ? ', relay unavailable' : ''}
          </span>
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default LogsModal
