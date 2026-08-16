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
          {/* Public datasets carry a category; private ones are tagged with
              the client they belong to, which matters when someone can see
              more than one client's data. */}
          {(dataset.category || dataset.clientName) && (
            <span className="template-card-track">
              {dataset.category || dataset.clientName}
            </span>
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
  onOpenDrive,
  driveBusy,
  driveError,
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

          {/* Private data is whatever Google says you may see. There is no
              VibeFoundry catalogue of it, no allowlist to keep in step with
              the client's own sharing, and no credential on our side — you
              sign into Google and pick, and Google decides. */}
          {tab === 'private' && (
            <div className="data-signin-prompt">
              <p className="modal-note">
                Your private data lives in Google Drive. Sign in with Google and
                pick the files you want — you'll only see what's been shared
                with you.
              </p>
              <button
                className="btn-primary"
                onClick={onOpenDrive}
                disabled={driveBusy}
              >
                {driveBusy ? 'Waiting for Google…' : 'Choose files from Google Drive'}
              </button>
              {driveBusy && (
                <p className="modal-note">
                  A browser tab is open. Pick your files there and they'll appear here.
                </p>
              )}
              {driveError && (
                <p className="modal-note" style={{ color: '#b91c1c' }}>{driveError}</p>
              )}
            </div>
          )}

          {tab === 'public' && loadingCatalog && <p>Loading datasets…</p>}

          {tab === 'public' && catalogError && (
            <p className="modal-note" style={{ color: '#b91c1c' }}>
              {catalogError}
            </p>
          )}

          {tab === 'public' && idle && datasets.length === 0 && (
            <p className="modal-note">No datasets available.</p>
          )}

          {tab === 'public' && datasets.length > 0 && (
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
