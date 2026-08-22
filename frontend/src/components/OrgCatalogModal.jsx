// The organization catalogue — which client hubs this machine can read, and
// what tables each one grants.
//
// Sits beside the public data picker and borrows its shell, but the content is
// a different kind of thing: public data is a fixed library, an organization is
// a connection that has to be made in the browser, lasts one hour, and lists
// only the tables that hub granted this person. Nothing here ever reads the
// credential — /api/org/status deliberately doesn't return one.

import { useCallback, useEffect, useRef, useState } from 'react'
import './DataLibrary.css'

const CONNECT_TIMEOUT_MS = 3 * 60 * 1000
const POLL_MS = 2000
const STATUS_REFRESH_MS = 15000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getJson = async (path) => {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} failed (${res.status})`)
  return res.json()
}

const postJson = async (path, body) => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || data.error || `${path} failed (${res.status})`)
  return data
}

// The wire contract fixes the shape of each item but not the envelope it
// arrives in, so take either a bare list or an id-keyed object rather than
// rendering nothing because the backend picked the other one.
const asList = (payload, ...keys) => {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  for (const key of keys) {
    const value = payload[key]
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      return Object.entries(value).map(([id, entry]) => ({ id, org_id: id, ...entry }))
    }
  }
  return []
}

const idOf = (entry) => entry.org_id || entry.id

// Identifies one credential rather than one org, so a reconnect can be told
// apart from the connection it replaced.
const stampOf = (entry) => (entry ? `${entry.expires || ''}|${entry.connected_at || ''}` : '')

// A personal connection lasts an hour, so the difference between "usable" and
// "about to stop working mid-question" is a number the user has to be able to
// see without asking for it.
const expiryLabel = (entry) => {
  if (!entry) return null
  let secs = null
  if (typeof entry.seconds_to_expiry === 'number') secs = entry.seconds_to_expiry
  else if (typeof entry.expires_in === 'number') secs = entry.expires_in
  else if (entry.expires) secs = Math.round((Date.parse(entry.expires) - Date.now()) / 1000)
  if (secs === null || Number.isNaN(secs)) return null
  if (secs <= 0) return 'Expired — reconnect'
  if (secs < 60) return `Expires in ${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `Expires in ${mins} min`
  return `Expires in ${Math.floor(mins / 60)}h ${mins % 60}m`
}

const OrgTables = ({ tables }) => {
  if (tables.length === 0) {
    return <p className="modal-note">No tables granted to you on this hub yet.</p>
  }
  return (
    <div className="pubdata-preview orgcat-tables">
      <table>
        <thead>
          <tr><th>Table</th><th>Rows</th><th>Columns</th></tr>
        </thead>
        <tbody>
          {tables.map((t) => (
            <tr key={t.id}>
              <td title={t.id}>{t.title || t.id}</td>
              <td>{typeof t.rows === 'number' ? t.rows.toLocaleString() : '—'}</td>
              <td>{Array.isArray(t.columns) ? t.columns.length : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function OrgCatalogModal({ open, onClose }) {
  const [orgs, setOrgs] = useState([])
  const [statusById, setStatusById] = useState({})
  const [tablesByOrg, setTablesByOrg] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [connecting, setConnecting] = useState(null)
  const [hubUrl, setHubUrl] = useState('')
  // Flipped when the modal closes so an in-flight connect poll stops instead of
  // running for its full three minutes against a modal nobody is looking at.
  const cancelRef = useRef(false)

  const loadStatus = useCallback(async () => {
    const data = await getJson('/api/org/status')
    const entries = asList(data, 'orgs', 'connected', 'organizations')
    const byId = {}
    entries.forEach((entry) => {
      const id = idOf(entry)
      // The status endpoint lists connected orgs, so presence is the signal —
      // an explicit connected:false still wins if the backend sends one.
      if (id) byId[id] = { ...entry, connected: entry.connected !== false }
    })
    setStatusById(byId)
    return byId
  }, [])

  const loadCatalog = useCallback(async () => {
    const data = await getJson('/api/org/catalog')
    // The credential expired under us — the backend has already dropped it, so
    // show nothing rather than a table list the user can no longer read.
    if (data && data.status === 'reauth_required') {
      setTablesByOrg({})
      setError('That connection has ended. Connect again to keep reading its tables.')
      return
    }
    const rows = asList(data, 'tables', 'datasets', 'catalog')
    const byOrg = {}
    rows.forEach((row) => {
      // Public datasets ride in the same merged catalogue but have their own
      // picker; this modal is about what each organization grants.
      if (row.source === 'public') return
      const id = row.org_id
      if (!id) return
      ;(byOrg[id] = byOrg[id] || []).push(row)
    })
    setTablesByOrg(byOrg)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await getJson('/api/org/list')
      setOrgs(asList(list, 'orgs', 'organizations'))
      const byId = await loadStatus()
      if (Object.keys(byId).length > 0) await loadCatalog()
      else setTablesByOrg({})
    } catch (err) {
      console.error('Failed to load organizations:', err)
      setError('Could not reach the organization service.')
    } finally {
      setLoading(false)
    }
  }, [loadStatus, loadCatalog])

  useEffect(() => {
    if (!open) return
    cancelRef.current = false
    refresh()
    return () => { cancelRef.current = true }
  }, [open, refresh])

  // Keep the countdown and the connected list honest while the modal sits
  // open — a connection can expire, or be made from another window, without
  // anything happening in this one.
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => { loadStatus().catch(() => {}) }, STATUS_REFRESH_MS)
    return () => clearInterval(timer)
  }, [open, loadStatus])

  const connect = async (payload, busyKey) => {
    setConnecting(busyKey)
    setError(null)
    try {
      const before = new Set(Object.keys(statusById))
      const previous = payload.org_id ? statusById[payload.org_id] : null
      const started = await postJson('/api/org/connect', payload)
      // The hub hands the credential to the backend through the browser, so
      // there is nothing to await on this call — polling is how the UI learns,
      // the same way sign-in watches /api/auth/status rather than the popup.
      const wanted = payload.org_id || started.org_id || null
      const deadline = Date.now() + CONNECT_TIMEOUT_MS
      while (Date.now() < deadline) {
        await sleep(POLL_MS)
        if (cancelRef.current) return
        const byId = await loadStatus().catch(() => null)
        if (!byId) continue
        const hit = wanted
          ? byId[wanted]
          // Connecting by pasted hub URL, the org id isn't known until the hub
          // says what it is — so the new entry IS the answer.
          : Object.values(byId).find((entry) => !before.has(idOf(entry)))
        // Reconnecting an org that is still connected would otherwise "succeed"
        // on the first poll, before the browser round-trip has happened at all —
        // so a fresh credential has to show a new stamp, not merely be present.
        if (hit && hit.connected && stampOf(hit) !== stampOf(previous)) {
          await refresh()
          return
        }
      }
      setError('The connection did not complete. Finish signing in in your browser, then try again.')
    } catch (err) {
      console.error('Failed to connect organization:', err)
      setError(String(err.message || err))
    } finally {
      setConnecting(null)
    }
  }

  const disconnect = async (orgId) => {
    setError(null)
    try {
      await postJson('/api/org/disconnect', { org_id: orgId })
      await refresh()
    } catch (err) {
      console.error('Failed to disconnect organization:', err)
      setError(String(err.message || err))
    }
  }

  const addHub = () => {
    const url = hubUrl.trim()
    if (!url || connecting) return
    setHubUrl('')
    connect({ hub_url: url }, `hub:${url}`)
  }

  if (!open) return null

  // An org reached by pasted hub URL isn't in the bundled list, so it would be
  // connected and invisible. Anything the store knows about gets a card.
  const rows = orgs.slice()
  const listed = new Set(orgs.map(idOf))
  Object.values(statusById).forEach((entry) => {
    const id = idOf(entry)
    if (id && !listed.has(id)) rows.push({ id, name: entry.org_name, hub_url: entry.hub_url })
  })

  return (
    <div className="modal-overlay" onClick={() => !connecting && onClose()}>
      <div className="modal data-library-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Organizations</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <p className="modal-note">
            Connecting opens your browser and signs you in at the organization's
            own hub. The connection lasts one hour and covers only the tables
            that hub granted you.
          </p>

          {error && <p className="modal-note" style={{ color: '#b91c1c' }}>{error}</p>}

          {loading && rows.length === 0 && <p>Loading organizations…</p>}

          {!loading && rows.length === 0 && !error && (
            <p className="modal-note">
              No organizations yet — paste your hub URL below to add one.
            </p>
          )}

          {rows.map((org) => {
            const id = idOf(org)
            const status = statusById[id]
            const connected = status ? status.connected : !!org.connected
            const busy = connecting === id
            const expires = expiryLabel(status || org)
            return (
              <section key={id} className="pubdata-container orgcat-card">
                <div className="orgcat-head">
                  <div className="orgcat-identity">
                    <div className="orgcat-name">{org.name || id}</div>
                    {org.hub_url && <div className="orgcat-hub">{org.hub_url}</div>}
                  </div>
                  <div className="orgcat-actions">
                    {connected && (
                      <button
                        className="pubdata-modal-reset"
                        onClick={() => disconnect(id)}
                        disabled={!!connecting}
                      >
                        Disconnect
                      </button>
                    )}
                    <button
                      className="pubdata-modal-download"
                      onClick={() => connect({ org_id: id }, id)}
                      disabled={!!connecting}
                    >
                      {busy ? 'Waiting for browser…' : connected ? 'Reconnect' : 'Connect'}
                    </button>
                  </div>
                </div>

                <div className={`orgcat-status ${connected ? 'is-on' : ''}`}>
                  <span className="orgcat-dot" />
                  {connected ? (
                    <span>
                      Connected{status?.email ? ` as ${status.email}` : ''}
                      {expires ? ` · ${expires}` : ''}
                    </span>
                  ) : (
                    <span>Not connected</span>
                  )}
                </div>

                {connected && <OrgTables tables={tablesByOrg[id] || []} />}
              </section>
            )
          })}

          <section className="pubdata-container orgcat-add">
            <div className="orgcat-add-title">Add organization</div>
            <div className="orgcat-add-row">
              <input
                type="text"
                className="dialog-input"
                placeholder="https://hub.yourcompany.com"
                value={hubUrl}
                onChange={(e) => setHubUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addHub() }}
              />
              <button
                className="pubdata-modal-download"
                onClick={addHub}
                disabled={!hubUrl.trim() || !!connecting}
              >
                Add
              </button>
            </div>
            <p className="modal-note">
              Paste the hub address your organization gave you. Nothing about
              you is sent anywhere else — your machine talks to that hub only.
            </p>
          </section>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={refresh} disabled={loading || !!connecting}>
            Refresh
          </button>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
