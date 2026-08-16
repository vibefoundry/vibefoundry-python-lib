// Reading and re-writing the hosted parquets in the browser.
//
// The hosted files are static objects on R2 — there is no server to filter
// them. So the filter modal reads a whole file here, filters in memory, and
// writes the selection back out as a new parquet. R2 sends Accept-Ranges and
// the bucket's CORS policy exposes content-range, which is what lets hyparquet
// fetch a file it did not originate.
import { parquetReadObjects, asyncBufferFromUrl } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { parquetWriteBuffer } from 'hyparquet-writer'

// Guard against loading something that would exhaust browser memory. Well above
// any file currently hosted (the largest is ~250k rows).
const MAX_SLICE_ROWS = 500_000

/**
 * Read every row of a hosted parquet. The filter modal calls this once when it
 * opens and then works entirely against the returned array, so its menus, its
 * preview and its download all describe the same snapshot of the file.
 */
export const loadRows = async (source) => {
  // A URL streams via range requests; an ArrayBuffer is already in hand. The
  // private datasets arrive as bytes through an authenticated endpoint, where
  // ranged public reads are neither possible nor wanted.
  const file = typeof source === 'string'
    ? await asyncBufferFromUrl({ url: source })
    : source
  const rows = await parquetReadObjects({ file, compressors })
  if (rows.length > MAX_SLICE_ROWS) {
    throw new Error(`This file has ${rows.length.toLocaleString()} rows — too many to filter in the browser.`)
  }
  return rows
}

/**
 * Write rows back out as parquet, so a filtered cut opens with the same
 * `pl.read_parquet` the students use on the full file. CSV would lose the
 * column types and force everyone to re-infer them.
 */
export const rowsToParquet = (columns, rows) => {
  const columnData = columns.map((name) => ({ name, data: rows.map((row) => row[name]) }))
  return new Blob([parquetWriteBuffer({ columnData })], { type: 'application/vnd.apache.parquet' })
}

export const triggerDownload = (blob, filename) => {
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough for the click to have been consumed.
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
