// Browse the data library and pull a dataset straight into input_folder/.
//
// Two tabs over the same shape. Public datasets need no identity at all;
// private ones are the signed-in user's own client data, and the server
// decides which client that is — this component never names one.

const TABS = [
  { key: 'public', label: 'Public Data' },
  { key: 'private', label: 'Private Data' },
]

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
  tab,
  onTabChange,
  catalog,
  catalogError,
  loadingCatalog,
  isDownloading,
  downloadingId,
  needsSignIn,
  onSignIn,
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
          <h3>Data Library</h3>
          <button
            className="modal-close"
            onClick={() => !isDownloading && onClose()}
          >×</button>
        </div>

        <div className="view-tabs data-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`view-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => !isDownloading && onTabChange(t.key)}
              disabled={isDownloading}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          <p className="modal-note">
            Downloads land in <code>input_folder/</code>.
          </p>

          {loadingCatalog && <p>Loading datasets…</p>}

          {/* Not signed in is a prompt, not an error — the private tab is
              expected to look like this until they authenticate. */}
          {needsSignIn && !loadingCatalog && (
            <div className="data-signin-prompt">
              <p className="modal-note">
                Sign in to see the data your organisation has shared with you.
              </p>
              <button className="btn-primary" onClick={onSignIn}>Sign in</button>
            </div>
          )}

          {catalogError && !needsSignIn && (
            <p className="modal-note" style={{ color: '#b91c1c' }}>
              {catalogError}
            </p>
          )}

          {idle && !needsSignIn && datasets.length === 0 && (
            <p className="modal-note">
              {tab === 'private'
                ? 'No private datasets have been shared with your organisation.'
                : 'No datasets available.'}
            </p>
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
