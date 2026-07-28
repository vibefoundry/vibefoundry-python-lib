import { useState, useEffect, useRef } from 'react'

/**
 * Shows a spreadsheet or presentation the way it actually looks — charts, cell
 * fills, merged cells and all — by displaying what LibreOffice rendered on the
 * backend.
 *
 * Both formats are fetched as bytes rather than pointed at by URL. That is
 * deliberate: in an embedded pane an <iframe src="/api/..."> resolves against
 * the widget's origin instead of the backend and silently loads nothing, the
 * same way plain <img src> did. Fetching goes through the app's own fetch —
 * which the pane shims — and the result is handed to the iframe as srcDoc
 * (HTML) or a blob: URL (PDF), both of which work everywhere.
 */
const OfficeViewer = ({ content, onShowData }) => {
  const [html, setHtml] = useState(null)
  const [pdfUrl, setPdfUrl] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const blobRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setHtml(null)
    setPdfUrl(null)

    const url = `/api/office/render?path=${encodeURIComponent(content.path)}`

    ;(async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) {
          let detail = `Could not render ${content.filename}.`
          try {
            const body = await res.json()
            if (body?.detail) detail = body.detail
          } catch { /* non-JSON error body */ }
          if (!cancelled) setError(detail)
          return
        }

        if (content.format === 'html') {
          const text = await res.text()
          if (!cancelled) setHtml(text)
        } else {
          const blob = await res.blob()
          // Revoke the previous URL before replacing it, or every file you open
          // leaks its predecessor for the life of the session.
          if (blobRef.current) URL.revokeObjectURL(blobRef.current)
          blobRef.current = URL.createObjectURL(blob)
          if (!cancelled) setPdfUrl(blobRef.current)
        }
      } catch (err) {
        if (!cancelled) setError(String(err?.message || err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [content.path, content.format, content.filename])

  // Release the blob when the viewer goes away, not just when the file changes.
  useEffect(() => () => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current)
  }, [])

  if (loading) {
    return (
      <div className="office-viewer office-viewer-message">
        <p>Rendering {content.filename}…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="office-viewer office-viewer-message">
        <p className="office-error">{error}</p>
        {content.hasDataView && (
          <button className="btn-flat" onClick={onShowData}>View as data instead</button>
        )}
      </div>
    )
  }

  return (
    <div className="office-viewer">
      {content.hasDataView && (
        <div className="office-toolbar">
          <span className="office-filename">{content.filename}</span>
          <button className="btn-flat" onClick={onShowData}>View as data</button>
        </div>
      )}
      <iframe
        className="office-frame"
        title={content.filename}
        {...(html !== null ? { srcDoc: html } : { src: pdfUrl })}
        // The rendered document is our own backend's output, but it is still
        // third-party content: sandbox it so a document cannot script the IDE.
        sandbox={html !== null ? '' : undefined}
      />
    </div>
  )
}

export default OfficeViewer
