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

const INT32_MAX = 2147483647
const INT32_MIN = -2147483648

/**
 * Decide a column's parquet type from every value in it, rather than letting
 * the writer infer one.
 *
 * The writer's inference calls any integral JS number INT32 — see
 * autoSchemaElement — with no regard for magnitude. A Float64 column of whole
 * numbers, which is what financial figures look like once hyparquet has read
 * them, therefore gets typed INT32 and then throws on the first value past
 * ~2.1 billion: "expected int32 value, got 1486600000020".
 *
 * Returning undefined means "no opinion, let the writer infer" — right for
 * strings, booleans and small ints, where inference is already correct.
 */
/**
 * Work out one column's parquet type and nullability from every value in it.
 *
 * Both halves matter, and they have to travel together:
 *
 *   * Type, because the writer's inference calls any integral JS number INT32
 *     regardless of magnitude. A Float64 column of whole numbers — which is
 *     what financial figures look like once hyparquet has read them — gets
 *     typed INT32 and throws on the first value past ~2.1 billion.
 *   * Nullability, because the writer stops scanning as soon as it has settled
 *     on a type, so nulls that appear later never mark the column OPTIONAL and
 *     it throws "parquet required value is undefined". And the `nullable` flag
 *     is only read when a type is supplied alongside it, so every column has
 *     to be typed for its nullability to be honoured.
 *
 * Returns no type for genuinely mixed columns; there the writer's own
 * inference is as good a guess as ours.
 */
const describe = (values) => {
  let nullable = false
  let kind
  const note = (k) => { kind = !kind || kind === k ? k : 'MIXED' }

  for (const v of values) {
    if (v === null || v === undefined) { nullable = true; continue }
    if (kind === 'MIXED') continue
    if (typeof v === 'bigint') note('INT64')
    else if (typeof v === 'string') note('STRING')
    else if (typeof v === 'boolean') note('BOOLEAN')
    else if (typeof v === 'number') {
      // DOUBLE holds both non-integral values and integers past int32 exactly
      // here (these files top out around 1e12, inside 2^53), and matches the
      // Float64 the column was read from.
      const wide = !Number.isInteger(v) || v > INT32_MAX || v < INT32_MIN
      if (wide && kind === 'INT32') kind = 'DOUBLE'
      else if (!wide && kind === 'DOUBLE') { /* DOUBLE already covers it */ }
      else note(wide ? 'DOUBLE' : 'INT32')
    } else note('MIXED')
  }

  if (!kind || kind === 'MIXED') return { nullable }
  return { type: kind, nullable }
}

/**
 * Write rows back out as parquet, so a filtered cut opens with the same
 * `pl.read_parquet` the students use on the full file. CSV would lose the
 * column types and force everyone to re-infer them.
 */
export const rowsToParquet = (columns, rows) => {
  const columnData = columns.map((name) => {
    const data = rows.map((row) => row[name])
    // nullable travels with the type: naming a type skips the writer's own
    // scan, which is also where it would have noticed the nulls and marked
    // the column OPTIONAL. Without it the column is written REQUIRED and the
    // first null throws "parquet required value is undefined".
    const { type, nullable } = describe(data)
    return type ? { name, data, type, nullable } : { name, data, nullable }
  })
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
