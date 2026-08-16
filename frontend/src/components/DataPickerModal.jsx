// Browse the public data library and pull a dataset into input_folder/.
//
// Public files only: no identity, no token, no gate. Same card shape as the
// Public Data page on vibefoundry.ai, so the two read as one library.

function formatSize(mb) {
  if (typeof mb !== 'number' || !isFinite(mb)) return null
  return mb < 1 ? `${Math.round(mb * 1024)} KB` : `${mb.toFixed(1)} MB`
}

function formatRows(n) {
  return typeof n === 'number' ? n.toLocaleString() : null
}

function DatasetRow({ dataset, isDownloading, downloadingId, onSelect }) {
  const busy = isDownloading && downloadingId === dataset.id
  const facts = [
    formatRows(dataset.rowCount) && `${formatRows(dataset.rowCount)} rows`,
    dataset.columnCount && `${dataset.columnCount} columns`,
    formatSize(dataset.sizeMb),
  ].filter(Boolean)

  return (
    <div className="template-card">
      <div className="template-card-titles">
        <div className="template-card-title-row">
          <h3>{dataset.title || dataset.id}</h3>
          {dataset.category && (
            <span className="template-card-track">{dataset.category}</span>
          )}
        </div>
        {dataset.description && (
          <p className="template-card-desc">{dataset.description}</p>
        )}
        {facts.length > 0 && (
          <p className="template-card-desc data-card-facts">{facts.join(' · ')}</p>
        )}
      </div>
      <div className="template-card-footer">
        <button
          className="btn-primary"
          onClick={() => onSelect(dataset.id)}
          disabled={isDownloading}
        >
          {busy ? 'Downloading…' : 'Download'}
        </button>
      </div>
    </div>
  )
}

export default function DataPickerModal({
  open,
  catalog,
  catalogError,
  loadingCatalog,
  isDownloading,
  downloadingId,
  onSelect,
  onClose,
}) {
  if (!open) return null

  const datasets = catalog?.datasets || []
  const idle = !loadingCatalog && !catalogError

  return (
    <div className="modal-overlay" onClick={() => !isDownloading && onClose()}>
      <div
        className="modal template-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Public Data</h3>
          <button
            className="modal-close"
            onClick={() => !isDownloading && onClose()}
          >×</button>
        </div>

        <div className="modal-body">
          <p className="modal-note">
            Downloads land in <code>input_folder/</code>.
          </p>

          {loadingCatalog && <p>Loading datasets…</p>}

          {catalogError && (
            <p className="modal-note" style={{ color: '#b91c1c' }}>
              {catalogError}
            </p>
          )}

          {idle && datasets.length === 0 && (
            <p className="modal-note">No datasets available.</p>
          )}

          {datasets.length > 0 && (
            <div className="template-row-list">
              {datasets.map((d) => (
                <DatasetRow
                  key={d.id}
                  dataset={d}
                  isDownloading={isDownloading}
                  downloadingId={downloadingId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={isDownloading}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
