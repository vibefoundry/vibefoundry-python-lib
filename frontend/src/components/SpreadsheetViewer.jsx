import { useState, useEffect, useRef } from 'react'
import Chart from 'chart.js/auto'

// Excel's default series palette, so a redrawn chart reads as a spreadsheet
// chart rather than an obviously-different one. We are reconstructing, not
// reproducing — the same trade Google Sheets makes with an uploaded workbook.
const SERIES_COLORS = [
  '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000',
  '#5B9BD5', '#70AD47', '#264478', '#9E480E',
]

const AXIS_KINDS = new Set(['bar', 'horizontalBar', 'line', 'area', 'scatter', 'radar'])

function toChartConfig(spec) {
  const isArea = spec.type === 'area'
  const isHorizontal = spec.type === 'horizontalBar'
  const type =
    spec.type === 'horizontalBar' ? 'bar'
      : isArea ? 'line'
        : spec.type

  const datasets = spec.series.map((s, i) => {
    const color = SERIES_COLORS[i % SERIES_COLORS.length]
    const base = {
      label: s.name || `Series ${i + 1}`,
      data: s.values,
      backgroundColor: color,
      borderColor: color,
      borderWidth: type === 'line' ? 2 : 0,
    }
    if (type === 'line') {
      base.fill = isArea
      base.tension = 0
      base.pointRadius = spec.type === 'scatter' ? 4 : 2
      if (isArea) base.backgroundColor = color + '55'
    }
    // Pie and doughnut colour by slice, not by series.
    if (type === 'pie' || type === 'doughnut') {
      base.backgroundColor = spec.categories.map((_, j) => SERIES_COLORS[j % SERIES_COLORS.length])
      base.borderColor = '#ffffff'
      base.borderWidth = 1
    }
    return base
  })

  return {
    type,
    data: { labels: spec.categories, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: isHorizontal ? 'y' : 'x',
      plugins: {
        title: { display: !!spec.title, text: spec.title, font: { size: 15, weight: 'bold' } },
        legend: { display: datasets.length > 1 || type === 'pie' || type === 'doughnut', position: 'right' },
      },
      scales: AXIS_KINDS.has(spec.type)
        ? { y: { beginAtZero: true, grid: { color: '#e5e5e5' } }, x: { grid: { display: false } } }
        : undefined,
    },
  }
}

const ChartCard = ({ spec }) => {
  const canvasRef = useRef(null)
  const chartRef = useRef(null)

  useEffect(() => {
    if (spec.unsupported || !canvasRef.current) return
    // Destroy before recreating: Chart.js refuses to attach twice to one canvas.
    if (chartRef.current) chartRef.current.destroy()
    chartRef.current = new Chart(canvasRef.current, toChartConfig(spec))
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy()
        chartRef.current = null
      }
    }
  }, [spec])

  if (spec.unsupported) {
    return (
      <div className="sheet-chart sheet-chart-unsupported">
        <p>
          {spec.title ? `“${spec.title}” ` : ''}
          is a {spec.unsupported.replace('Chart', '')} chart, which can’t be redrawn here.
        </p>
      </div>
    )
  }

  return (
    <div className="sheet-chart">
      <canvas ref={canvasRef} />
    </div>
  )
}

/**
 * Shows a spreadsheet as it looks — styled cells and its charts — by
 * reconstructing it rather than rendering it. The cells arrive as HTML carrying
 * real fills, fonts, borders and merges; each chart arrives as a definition
 * read out of the workbook and is redrawn here.
 *
 * The table is injected as HTML because it *is* markup, not a picture: text
 * stays selectable and copyable, and the browser's own find works across it.
 * The backend builds it from the workbook, so it is our own content, and it
 * carries no scripts.
 */
const SpreadsheetViewer = ({ content, onShowData }) => {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sheet, setSheet] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const q = sheet ? `&sheet=${encodeURIComponent(sheet)}` : ''
    fetch(`/api/spreadsheet?path=${encodeURIComponent(content.path)}${q}`)
      .then(async (res) => {
        if (!res.ok) {
          let detail = `Could not open ${content.filename}.`
          try { const b = await res.json(); if (b?.detail) detail = b.detail } catch { /* non-JSON */ }
          throw new Error(detail)
        }
        return res.json()
      })
      .then((body) => { if (!cancelled) setData(body) })
      .catch((err) => { if (!cancelled) setError(String(err?.message || err)) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [content.path, content.filename, sheet])

  if (loading && !data) {
    return <div className="sheet-viewer sheet-message"><p>Opening {content.filename}…</p></div>
  }

  if (error) {
    return (
      <div className="sheet-viewer sheet-message">
        <p className="sheet-error">{error}</p>
        <button className="btn-flat" onClick={onShowData}>View as data instead</button>
      </div>
    )
  }

  const sheets = data?.sheets || []

  return (
    <div className="sheet-viewer">
      <div className="sheet-toolbar">
        <span className="sheet-filename">{content.filename}</span>
        <button className="btn-flat" onClick={onShowData}>View as data</button>
      </div>

      <div className="sheet-scroll">
        <div
          className="sheet-grid"
          dangerouslySetInnerHTML={{ __html: data?.html || '' }}
        />

        {(data?.charts || []).map((spec, i) => (
          <ChartCard key={`${data.activeSheet}-${i}`} spec={spec} />
        ))}
      </div>

      {sheets.length > 1 && (
        <div className="sheet-tabs">
          {sheets.map((name) => (
            <button
              key={name}
              className={`sheet-tab ${name === (data?.activeSheet) ? 'active' : ''}`}
              onClick={() => setSheet(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default SpreadsheetViewer
