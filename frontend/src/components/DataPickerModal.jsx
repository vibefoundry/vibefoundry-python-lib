// The public data library, rendered the way vibefoundry.ai renders it.
//
// Same shape as the site's Public Data page: a banner with the title and the
// one way in, the description underneath, and a live row preview beside it.
// Download opens the same Excel-style filter modal, so students pick the cut
// they want rather than always taking the whole file — except here the result
// is written into input_folder/ instead of the browser's downloads.

import { useState } from 'react'
import DataFilterModal from './DataFilterModal'
import './DataLibrary.css'

const DownloadIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const Dataset = ({ data, onFilter }) => {
  const preview = data.preview
  return (
    <section className="pubdata-container">
      <div className="pubdata-body">
        <div className="pubdata-intro">
          <div className="pubdata-intro-banner">
            <div className="pubdata-intro-title">{data.title || data.id}</div>
            <button
              type="button"
              className="pubdata-download"
              onClick={() => onFilter(data)}
              title={`Filter and download ${data.sourceFile || data.id}`}
            >
              <DownloadIcon />
              <span>Download</span>
            </button>
          </div>
          <p className="pubdata-intro-desc">{data.description}</p>
        </div>

        {preview?.rows?.length > 0 && (
          <div className="pubdata-right">
            <div className="pubdata-pane-head">
              <span className="pubdata-preview-label">
                First {preview.rows.length.toLocaleString()} of{' '}
                {(data.rowCount || 0).toLocaleString()} rows — {data.sourceFile}
              </span>
            </div>
            <div className="pubdata-preview">
              <table>
                <thead>
                  <tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default function DataPickerModal({
  open,
  catalog,
  catalogError,
  loadingCatalog,
  onSaved,
  onClose,
}) {
  const [filtering, setFiltering] = useState(null)
  const [savedName, setSavedName] = useState(null)

  if (!open) return null

  const datasets = catalog?.datasets || []
  const idle = !loadingCatalog && !catalogError

  return (
    <div className="modal-overlay" onClick={() => !filtering && onClose()}>
      <div className="modal data-library-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>VibeFoundry Public Data</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <p className="modal-note">
            {savedName
              ? `Saved ${savedName} to input_folder/.`
              : 'Downloads land in input_folder/. Filter first to take just the cut you need.'}
          </p>

          {loadingCatalog && <p>Loading datasets…</p>}

          {catalogError && (
            <p className="modal-note" style={{ color: '#b91c1c' }}>{catalogError}</p>
          )}

          {idle && datasets.length === 0 && (
            <p className="modal-note">No datasets available.</p>
          )}

          {datasets.map((d) => (
            <Dataset key={d.id} data={d} onFilter={setFiltering} />
          ))}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>

      {filtering && (
        <DataFilterModal
          data={filtering}
          // Read through the IDE rather than straight from vibefoundry.ai:
          // same-origin here, so no CORS and no reliance on range requests.
          source={() =>
            fetch(`/api/data/public/file/${filtering.id}`).then((r) => {
              if (!r.ok) throw new Error(`Could not read the dataset (${r.status})`)
              return r.arrayBuffer()
            })
          }
          onClose={() => setFiltering(null)}
          onSaved={(name) => {
            setFiltering(null)
            setSavedName(name)
            onSaved?.()
          }}
        />
      )}
    </div>
  )
}
