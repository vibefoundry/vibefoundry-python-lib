// Excel-style filter + download modal for one dataset.
//
// Opening the modal reads the parquet from R2 once and keeps the rows in
// memory. Every menu (unique values for a column, min/max for a numeric one)
// is derived from those same rows rather than from anything precomputed, so a
// menu can never offer a value the file does not contain — the failure mode you
// get the moment a precomputed facet list and the hosted file drift apart.
//
// Column stats are computed lazily, only when a header menu is first opened.
// Scanning every column of a 250k-row file up front would cost seconds for
// menus the student may never touch.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { loadRows, rowsToParquet } from './sliceDownload'

const PREVIEW_LIMIT = 100

// Above this a column stops offering a pick-list — a 10,000-entry checkbox list
// is not a filter, it's a scroll. Such columns fall back to a "contains" box.
const MAX_PICKLIST = 2000

const isBlank = (v) => v === null || v === undefined || v === ''

// hyparquet returns BigInt for 64-bit ints, so Number() rather than a bare
// typeof check, and String() wherever values are compared or rendered.
const asNumber = (v) => {
  if (isBlank(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const EMPTY = { values: [], min: null, max: null, text: '' }

const isEmptyFilter = (f) =>
  !f || (!f.values?.length && f.min === null && f.max === null && !f.text)

/** Describe a column from the values actually present in the loaded rows. */
const describeColumn = (rows, column) => {
  const seen = new Set()
  let numeric = 0
  let nonBlank = 0
  let min = Infinity
  let max = -Infinity
  let overflowed = false

  for (const row of rows) {
    const value = row[column]
    if (isBlank(value)) continue
    nonBlank += 1
    const n = asNumber(value)
    if (n !== null) {
      numeric += 1
      if (n < min) min = n
      if (n > max) max = n
    }
    if (!overflowed) {
      seen.add(String(value))
      if (seen.size > MAX_PICKLIST) overflowed = true
    }
  }

  // "Mostly numeric" rather than "all numeric": a stray sentinel like "N/A"
  // shouldn't stop a revenue column offering a range.
  const numericish = nonBlank > 0 && numeric / nonBlank > 0.95
  const values = overflowed
    ? null
    : [...seen].sort((a, b) => (numericish ? Number(a) - Number(b) : a.localeCompare(b, undefined, { numeric: true })))

  return {
    // A numeric column gets range inputs *and* a value list — the user asked
    // for both, and which one fits depends on the column (a year is picked, a
    // dollar amount is bounded).
    hasRange: numericish && nonBlank > 0,
    values,
    min,
    max,
  }
}

const rowMatches = (row, filters) => {
  for (const [column, f] of Object.entries(filters)) {
    const value = row[column]
    if (f.values?.length && !f.values.includes(String(value))) return false
    if (f.min !== null || f.max !== null) {
      const n = asNumber(value)
      if (n === null) return false
      if (f.min !== null && n < f.min) return false
      if (f.max !== null && n > f.max) return false
    }
    if (f.text && !String(value ?? '').toLowerCase().includes(f.text.toLowerCase())) return false
  }
  return true
}

const ValuePicker = ({ meta, filter, onPatch }) => {
  const [search, setSearch] = useState('')
  const selected = filter.values || []
  const shown = search
    ? meta.values.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
    : meta.values

  const toggle = (value) => onPatch({
    values: selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value],
  })

  return (
    <>
      <input
        className="pubdata-menu-search"
        placeholder={`Search ${meta.values.length.toLocaleString()} values…`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="pubdata-menu-actions">
        <button type="button" onClick={() => onPatch({ values: shown })}>Select all</button>
        <button type="button" onClick={() => onPatch({ values: [] })} disabled={!selected.length}>
          Clear
        </button>
      </div>
      <div className="pubdata-menu-list">
        {shown.slice(0, 400).map((value) => (
          <label key={value} className="pubdata-menu-option">
            <input type="checkbox" checked={selected.includes(value)} onChange={() => toggle(value)} />
            <span>{value}</span>
          </label>
        ))}
        {shown.length > 400 && (
          <div className="pubdata-menu-note">
            {(shown.length - 400).toLocaleString()} more — narrow with search
          </div>
        )}
      </div>
    </>
  )
}

const RangeInputs = ({ meta, filter, onPatch }) => {
  const set = (key, raw) => onPatch({ [key]: raw === '' ? null : Number(raw) })
  return (
    <div className="pubdata-menu-range">
      <div className="pubdata-menu-note">
        Range {meta.min.toLocaleString()} – {meta.max.toLocaleString()}
      </div>
      <div className="pubdata-menu-range-row">
        <label>Min<input type="number" value={filter.min ?? ''} onChange={(e) => set('min', e.target.value)} /></label>
        <label>Max<input type="number" value={filter.max ?? ''} onChange={(e) => set('max', e.target.value)} /></label>
      </div>
    </div>
  )
}

const HeaderMenu = ({ column, meta, filter, onPatch, onClear, onClose }) => {
  const ref = useRef(null)
  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current?.contains(e.target) && !e.target.closest('.pubdata-th-toggle')) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  return (
    <div className="pubdata-menu" ref={ref}>
      <div className="pubdata-menu-head">
        <span className="pubdata-menu-title">{column}</span>
        <button type="button" className="pubdata-menu-reset" onClick={onClear} disabled={isEmptyFilter(filter)}>
          Reset
        </button>
      </div>

      {meta.hasRange && <RangeInputs meta={meta} filter={filter} onPatch={onPatch} />}

      {meta.values && <ValuePicker meta={meta} filter={filter} onPatch={onPatch} />}

      {!meta.values && (
        <div className="pubdata-menu-range">
          <div className="pubdata-menu-note">Too many distinct values to list.</div>
          <label>
            Contains
            <input value={filter.text || ''} onChange={(e) => onPatch({ text: e.target.value })} />
          </label>
        </div>
      )}
    </div>
  )
}

// `source` is either a URL (public datasets, read by range request) or an async
// function returning bytes (private datasets, fetched through the gated
// endpoint). Everything downstream is identical either way.
const FilterModal = ({ data, source, onClose, onSaved }) => {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState({})
  const [openColumn, setOpenColumn] = useState(null)
  const [busy, setBusy] = useState('')
  const metaCache = useRef(new Map())

  useEffect(() => {
    let cancelled = false
    Promise.resolve(typeof source === 'function' ? source() : source)
      .then((raw) => loadRows(raw))
      .then((r) => { if (!cancelled) setRows(r) })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [source])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const columns = rows?.length ? Object.keys(rows[0]) : []

  // name -> description, from the dataset JSON the refresh script writes.
  const docs = useMemo(
    () => Object.fromEntries((data.columns || []).map((c) => [c.name, c.description])),
    [data.columns]
  )

  const filtered = useMemo(() => {
    if (!rows) return []
    if (!Object.keys(filters).length) return rows
    return rows.filter((row) => rowMatches(row, filters))
  }, [rows, filters])

  const metaFor = (column) => {
    if (!metaCache.current.has(column)) {
      metaCache.current.set(column, describeColumn(rows, column))
    }
    return metaCache.current.get(column)
  }

  // Merge a partial change into one column's filter, dropping it entirely once
  // nothing is constrained so the "N filters" count stays honest.
  const patchFilter = (column, patch) => setFilters((prev) => {
    const next = { ...EMPTY, ...prev[column], ...patch }
    const copy = { ...prev }
    if (isEmptyFilter(next)) delete copy[column]
    else copy[column] = next
    return copy
  })

  const clearFilter = (column) => setFilters((prev) => {
    const copy = { ...prev }
    delete copy[column]
    return copy
  })

  // The site hands the blob to the browser's downloader. Here it goes to the
  // project instead: the whole point is that the cut lands in input_folder/
  // ready for a script, not in ~/Downloads.
  const download = () => {
    setBusy('Building parquet…')
    // Yield a frame so the busy label paints before the main thread blocks
    // encoding what may be a large file.
    setTimeout(async () => {
      try {
        const untouched = filtered.length === data.rowCount
        const name = untouched
          ? data.sourceFile || `${data.id}.parquet`
          : `${data.id}_cut.parquet`
        const blob = rowsToParquet(columns, filtered)
        const form = new FormData()
        form.append('file', blob, name)
        form.append('filename', name)
        const res = await fetch('/api/data/public/save-cut', { method: 'POST', body: form })
        if (!res.ok) throw new Error(`save failed (${res.status})`)
        const saved = await res.json()
        setBusy('')
        onSaved?.(saved.filename)
      } catch (err) {
        setError(`Could not save the file: ${err.message}`)
        setBusy('')
      }
    }, 0)
  }

  const [doc, setDoc] = useState(null)

  const showDoc = (column, el) => {
    const text = docs[column]
    // Suppressed while this column's menu is open so the two never overlap.
    if (!text || openColumn === column) return
    const r = el.getBoundingClientRect()
    const width = 240
    // Flip to sit left of the anchor when a right-edge column would overflow.
    const left = Math.min(r.left, window.innerWidth - width - 12)
    setDoc({ text, left: Math.max(12, left), top: r.bottom + 6 })
  }
  const hideDoc = () => setDoc(null)

  const activeCount = Object.keys(filters).length
  const preview = filtered.slice(0, PREVIEW_LIMIT)

  // Portalled to <body>: the modal is position:fixed but renders inside a card
  // that sets z-index, which would trap it in that stacking context and let
  // later cards paint over the top of it.
  return createPortal(
    <div className="pubdata-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pubdata-modal" role="dialog" aria-label={`Filter ${data.title}`}>
        <header className="pubdata-modal-head">
          <div className="pubdata-modal-heading">
            <div className="pubdata-modal-title">{data.title}</div>
            <div className="pubdata-modal-sub">
              {rows === null && !error && 'Loading data…'}
              {error && <span className="pubdata-modal-error">{error}</span>}
              {rows !== null && (
                <>
                  {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} rows
                  {activeCount > 0 && ` · ${activeCount} filter${activeCount > 1 ? 's' : ''}`}
                </>
              )}
            </div>
          </div>
          <div className="pubdata-modal-actions">
            <button type="button" className="pubdata-modal-reset" onClick={() => setFilters({})} disabled={!activeCount}>
              Reset all
            </button>
            <button
              type="button"
              className="pubdata-modal-download"
              onClick={download}
              disabled={rows === null || filtered.length === 0 || !!busy}
            >
              {busy || `Download cut (${filtered.length.toLocaleString()})`}
            </button>
            <button type="button" className="pubdata-modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>

        <div className="pubdata-sheet">
          {rows === null && !error && <div className="pubdata-sheet-empty">Reading the file…</div>}
          {error && <div className="pubdata-sheet-empty">{error}</div>}
          {rows !== null && filtered.length === 0 && (
            <div className="pubdata-sheet-empty">No rows match these filters.</div>
          )}
          {rows !== null && filtered.length > 0 && (
            <table>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column}>
                      {/* Column documentation shows on hover. It is drawn by
                          the portalled tooltip below rather than nested here,
                          because anything inside the scroll container gets
                          clipped by its overflow at the edges. */}
                      <span
                        className="pubdata-th-name"
                        onMouseEnter={(e) => showDoc(column, e.currentTarget)}
                        onMouseLeave={hideDoc}
                      >
                        {column}
                      </span>
                      <button
                        type="button"
                        className={`pubdata-th-toggle${filters[column] ? ' is-on' : ''}`}
                        onClick={() => setOpenColumn(openColumn === column ? null : column)}
                        aria-label={`Filter ${column}`}
                      >
                        ▼
                      </button>
                      {openColumn === column && (
                        <HeaderMenu
                          column={column}
                          meta={metaFor(column)}
                          filter={filters[column] || EMPTY}
                          onPatch={(patch) => patchFilter(column, patch)}
                          onClear={() => clearFilter(column)}
                          onClose={() => setOpenColumn(null)}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => <td key={c}>{isBlank(row[c]) ? '' : String(row[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className="pubdata-modal-foot">
          Previewing the first {Math.min(PREVIEW_LIMIT, filtered.length)} rows.
          The download includes all {filtered.length.toLocaleString()}.
        </footer>
      </div>

      {doc && (
        <div className="pubdata-th-tip" style={{ left: doc.left, top: doc.top }}>
          {doc.text}
        </div>
      )}
    </div>,
    document.body
  )
}

export default FilterModal
