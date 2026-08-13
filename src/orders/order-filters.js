// Order-desk filters — the one place an /admin/orders querystring becomes SQL
// (W12 US-002, FR-116/FR-117).
//
// PURE on purpose, in the posture src/reports/filters.js takes: no pool, no
// query, no imports from the route layer, nothing to stub. That is what makes
// test/order-filters.test.js able to prove the whitelist and the escaping on
// their own, without a database.
//
// **This is NOT src/reports/filters.js and must never reuse it.** That module's
// values are slugs and enums — `[a-z0-9-]` by construction (src/seed/slugify.js)
// — which is the entire reason `parseSlug` can validate a shape and be done. A
// client reference and a customer PO number are FREE TEXT a person typed, so:
//
//   - the value binds as a $n placeholder, never into the SQL text; and
//   - the LIKE metacharacters `%` and `_` are escaped IN THE PATTERN, with an
//     explicit `ESCAPE '\'` on every clause. Without that, a reference of
//     "100%" matches every order in the table and "A_1" matches "AB1" — a
//     wildcard injection whose only symptom is a search that quietly answers
//     with the wrong orders.
//
// The column literals fix the aliases the caller's FROM must use: `o` orders,
// `u` the LEFT JOINed account (src/orders/admin-orders.js ORDER_FROM). A query
// that aliases differently gets clauses that do not resolve.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Filter name -> the trusted columns it searches.
//
// A name -> column LIST rather than reports' name -> column map, because the
// free-text filters here legitimately span several columns: an order is
// attributed to an account OR to a walk-in's email and never both, so "client"
// is unanswerable from any one column. `from`/`to` are two bounds on one column,
// which is why the clause shape lives in buildOrderFilters rather than here.
export const ORDER_FILTER_COLUMNS = Object.freeze({
  // The catch-all the CRM's search box drives: everything a person might
  // remember about an order. Deliberately includes our own order number — it is
  // the one identifier printed on every document that leaves the building.
  q: Object.freeze([
    'o.order_number',
    'o.client_reference',
    'o.customer_po_number',
    'u.name',
    'u.email',
    'o.guest_email',
  ]),
  // Guest email is in here because a guest order has NO account row: the LEFT
  // JOIN gives NULL for u.name and u.email, and a client filter that searched
  // only those would silently exclude every order placed without a login.
  client: Object.freeze(['u.name', 'u.email', 'o.guest_email']),
  reference: Object.freeze(['o.client_reference']),
  po_number: Object.freeze(['o.customer_po_number']),
  from: Object.freeze(['o.created_at']),
  to: Object.freeze(['o.created_at']),
})

export const ORDER_FILTER_NAMES = Object.freeze(Object.keys(ORDER_FILTER_COLUMNS))

const TEXT_FILTERS = Object.freeze(['q', 'client', 'reference', 'po_number'])
const DATE_FILTERS = Object.freeze(['from', 'to'])

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// A typed search term, capped. The cap is here rather than only in the route
// schema because Ajv's `removeAdditional` makes a schema a shape check and this
// module the real gate; a megabyte of text in an ILIKE pattern is a query nobody
// asked for.
const MAX_TERM_LENGTH = 200

// Values are echoed back so the office can see what it typed; capped so a long
// query param cannot turn an error message into a payload.
const PREVIEW_LIMIT = 60
const preview = (value) => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text
}

const invalid = (name, value, expected) =>
  httpError(400, `Invalid value for filter "${name}" (${preview(value)}): expected ${expected}.`)

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

// A term is stored TRIMMED AND RAW — the pattern (and its escaping) is built in
// buildOrderFilters. Keeping the user's own text in the parsed filters is what
// lets a route echo `meta.filters` back without un-escaping anything.
const parseTerm = (name, value) => {
  if (typeof value !== 'string') {
    throw invalid(name, value, 'a text value')
  }
  const text = value.trim()
  if (text.length > MAX_TERM_LENGTH) {
    throw invalid(name, text, `at most ${MAX_TERM_LENGTH} characters`)
  }
  return text
}

// A calendar date, not a timestamp: the CRM's date inputs produce YYYY-MM-DD and
// an order-desk range is a range of days. The round trip is what rejects
// 2026-02-30, which the regex alone accepts.
const parseDate = (name, value) => {
  if (typeof value !== 'string') {
    throw invalid(name, value, 'a calendar date as YYYY-MM-DD')
  }
  const text = value.trim()
  if (!DATE_PATTERN.test(text)) {
    throw invalid(name, text, 'a calendar date as YYYY-MM-DD')
  }
  const parsed = new Date(`${text}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw invalid(name, text, 'a real calendar date as YYYY-MM-DD')
  }
  return text
}

// Every column is a code literal naming an alias and a column, checked while the
// module loads so a typo throws here rather than reaching SQL — the posture
// assertEntity (src/lifecycle/registry.js) and src/reports/filters.js take.
const COLUMN_REFERENCE = /^[a-z]+\.[a-z_]+$/
for (const [name, columns] of Object.entries(ORDER_FILTER_COLUMNS)) {
  if (columns.length === 0) {
    throw new Error(`Order filter "${name}" searches no column`)
  }
  for (const column of columns) {
    if (!COLUMN_REFERENCE.test(column)) {
      throw new Error(`Order filter "${name}" has a malformed column reference: ${column}`)
    }
  }
  if (!TEXT_FILTERS.includes(name) && !DATE_FILTERS.includes(name)) {
    throw new Error(`Order filter "${name}" has no parser`)
  }
}

/**
 * Validates an /admin/orders querystring into the canonical filter object
 * listAdminOrders takes. Unknown keys are ignored (the whitelist is what
 * controls which filters exist — Ajv strips unknown keys rather than rejecting
 * them, so no schema could reject one anyway); a recognised key carrying an
 * unusable value is a 400 naming the filter.
 *
 * A blank value is ABSENT, never "match nothing" — an empty search box must
 * show the queue, not an empty screen.
 *
 * @param {object} [query]
 * @returns {Readonly<object>} only the filters actually supplied
 */
export const parseOrderFilters = (query = {}) => {
  const filters = {}

  for (const name of ORDER_FILTER_NAMES) {
    const raw = query?.[name]
    if (isBlank(raw)) continue
    filters[name] = DATE_FILTERS.includes(name)
      ? parseDate(name, raw)
      : parseTerm(name, raw)
  }

  // A backwards range is a mistake whose only symptom is an empty list, so it is
  // refused rather than answered with zero orders.
  if (filters.from && filters.to && filters.from > filters.to) {
    throw httpError(
      400,
      `Invalid order range: "from" (${filters.from}) is after "to" (${filters.to}).`
    )
  }

  return Object.freeze(filters)
}

/**
 * Escape the LIKE metacharacters so a search for "100%" matches a literal
 * percent rather than every order, and "A_1" matches an underscore rather than
 * any character. The backslash itself goes first by being in the same character
 * class — a single pass, so an escape is never re-escaped.
 *
 * Pairs with the `ESCAPE '\'` clause every ILIKE below carries. Exported for
 * the unit tests: the escaping IS the security property of this module.
 *
 * @param {string} value
 * @returns {string}
 */
export const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

// A contains-match over one or more columns, all sharing one placeholder. The
// OR group is parenthesised so it cannot swallow the AND that joins it to the
// next clause. `u.name`/`u.email` are NULL on a guest order and an ILIKE against
// NULL is NULL, which is simply not-a-match inside an OR — exactly right.
const likeClause = (columns, index) => {
  const matches = columns.map((column) => `${column} ILIKE $${index} ESCAPE '\\'`)
  return matches.length === 1 ? matches[0] : `(${matches.join(' OR ')})`
}

// One clause per filter. Columns are trusted literals; `index` is the
// placeholder number the caller's params array has just reached.
const CLAUSES = Object.freeze({
  from: (columns, index) => `${columns[0]} >= $${index}::date`,
  // Inclusive: a `to` of today must carry today's orders. `<= $n::date` would
  // cut the range at that morning's midnight and silently drop the whole day.
  to: (columns, index) => `${columns[0]} < ($${index}::date + 1)`,
  q: likeClause,
  client: likeClause,
  reference: likeClause,
  po_number: likeClause,
})

/**
 * Turns parsed filters into WHERE fragments and bound params.
 *
 * `params` lets the caller append these to placeholders it has already bound;
 * the array is COPIED, never mutated. Clauses come out in ORDER_FILTER_NAMES
 * order rather than the caller's key order, so one filter set is always one SQL
 * string — which is what lets the count query and the page query share it.
 *
 * @param {object} [filters] output of parseOrderFilters
 * @param {{ params?: unknown[] }} [options]
 * @returns {{ clauses: string[], params: unknown[], where: string }}
 */
export const buildOrderFilters = (filters = {}, { params = [] } = {}) => {
  const bound = [...params]
  const clauses = []

  for (const name of ORDER_FILTER_NAMES) {
    const value = filters[name]
    if (value === undefined || value === null || value === '') continue
    // The pattern is built HERE, not in the parser: the escape and the
    // `ESCAPE '\'` that interprets it are one decision and live together.
    bound.push(TEXT_FILTERS.includes(name) ? `%${escapeLike(value)}%` : value)
    clauses.push(CLAUSES[name](ORDER_FILTER_COLUMNS[name], bound.length))
  }

  return { clauses, params: bound, where: clauses.join(' AND ') }
}
