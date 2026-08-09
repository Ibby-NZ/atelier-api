// How many rows a report table answers with, in one place.
//
// Three reports share it now (product performance, stock, not invoiced) and the
// route's querystring schema spends MAX_ROW_LIMIT as its `maximum`, so an
// over-large limit is a 400 rather than a silent clamp reporting a page size
// nobody asked for. A per-report copy of the number is how one report would
// quietly start answering with a different page than its neighbours.
//
// `limit: null` is the EXPORT's contract — every row — and is deliberately
// unreachable from a table route, which is what makes "the export is not the
// current page" true while both share one builder.

export const DEFAULT_ROW_LIMIT = 200
export const MAX_ROW_LIMIT = 1000

/**
 * Resolve a caller's limit into the number of rows a report will actually ask
 * the database for.
 *
 * @param {number|null|undefined} limit null for every row
 * @returns {number|null}
 */
export const clampLimit = (limit) => {
  if (limit === null) return null
  const requested = Number(limit)
  if (!Number.isFinite(requested)) return DEFAULT_ROW_LIMIT
  return Math.min(Math.max(1, Math.trunc(requested)), MAX_ROW_LIMIT)
}
