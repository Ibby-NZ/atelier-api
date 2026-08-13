// Product performance — which houses and designs sell, grouped out of the
// revenue scope. The first Epic 5 report served over HTTP, so it is also the
// shape US-006's export and US-007's two reports copy.
//
// It selects out of the scope CTE rather than restating the population, which is
// what makes the table and its CSV incapable of disagreeing about what a sale is
// (src/reports/revenue-lines.js). Everything below is a projection of that one
// population: group it by house and design, sum the quantity and the line value,
// and count the lines that carry no price.
//
// Three things the payload has to say out loud, because a reader cannot see
// them and every one of them makes a figure mean something different:
//
//   - WHAT IT COVERS. These are live platform orders only. All four D365
//     transaction entities are header-only (CLAUDE.md § Legacy D365 staging), so
//     no pre-launch sale can be in here at any grain — a house Atelier sold for
//     years reads as nil until it sells through this platform. `meta.coverage`
//     carries the observed window and says so.
//
//   - WHAT THE QUANTITY IS IN. A fabric is metres and a finished good is units,
//     so `product_type` rides on every row and the totals row carries NO
//     quantity: one number adding metres to units is a figure with no unit, the
//     same reason the CRM's by-design view omits its quantity column.
//
//   - WHAT THE MONEY IS IN. `order_lines.unit_price_cents` is in the product's
//     own currency and `orders` carries none, so a total across two currencies
//     is a made-up number. Checkout refuses a mixed-currency cart for exactly
//     this reason; here the row keeps its currency and the totals row omits the
//     value when the population holds more than one.

import { defineColumns } from './access.js'
import { dimensionCoverage } from './coverage.js'
import { buildRevenueScope, SCOPE_NAME } from './revenue-lines.js'
import { clampLimit, DEFAULT_ROW_LIMIT } from './limits.js'

export const PRODUCT_PERFORMANCE = 'product-performance'
export const PRODUCT_PERFORMANCE_TITLE = 'Product performance by house and design'

// Declared at module load, so a malformed column throws while this file is
// loading rather than as a response. Order is the table's order and the CSV's
// header order — maskReport builds every row from this list.
//
// Nothing here is `finance`. A sell value is money and is not a cost (the
// distinction access.js states): the CRM's own policy leaves a sell "Value"
// column open to every staff login and masks the landed/cost ones, which is what
// US-007's stock report will declare. Masking still runs over this report, so it
// carries `meta.masked_columns` like every other.
export const PRODUCT_PERFORMANCE_COLUMNS = defineColumns([
  { key: 'brand_name', label: 'House' },
  { key: 'product_name', label: 'Design' },
  { key: 'product_type', label: 'Type' },
  { key: 'currency', label: 'Currency' },
  { key: 'orders', label: 'Orders', kind: 'number' },
  { key: 'qty', label: 'Quantity', kind: 'number' },
  { key: 'value_cents', label: 'Sales', kind: 'money' },
  { key: 'unpriced_lines', label: 'Unpriced lines', kind: 'number' },
])

// What the figures are of, in the payload rather than in a screen's footnote:
// the CSV is the copy that leaves the building, and a file that does not say
// what it covers is read as covering everything.
export const COVERAGE_NOTE =
  'Live platform orders only. Atelier’s historic Dynamics 365 sales are staged header-only — ' +
  'no export carries line items — so no pre-launch sale is included at any grain, and a house ' +
  'sold for years before the platform opened reads as nil here.'

// The label the totals row puts in the first two columns. A totals row is a row,
// so its label travels as data — that is what lets one cell pipeline render it
// and one CSV writer append it without a second rule.
export const TOTALS_LABELS = Object.freeze({
  brand_name: 'All houses',
  product_name: 'All designs',
})

const rowsSql = (cte, limitPlaceholder) => `WITH ${cte}
   SELECT brand_name,
          product_name,
          product_type,
          currency,
          COUNT(DISTINCT order_id)::int AS orders,
          COALESCE(SUM(qty), 0) AS qty,
          -- Rounded at the aggregate, never per line: qty is numeric(12,2), so a
          -- line can be worth 4997.5 cents and rounding each one multiplies the
          -- error by the row count.
          COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
          COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines
     FROM ${SCOPE_NAME}
    GROUP BY brand_id, brand_name, product_id, product_name, product_type, currency
    ORDER BY value_cents DESC, qty DESC, brand_name, product_name
   ${limitPlaceholder ? `LIMIT ${limitPlaceholder}` : ''}`

// The totals and the coverage window are computed over the WHOLE population, not
// over the rows that survived the limit — a total that only added up the visible
// page would be wrong in exactly the way nobody checks.
const summarySql = (cte) => `WITH ${cte}
   SELECT COUNT(*)::int AS lines,
          COUNT(*) FILTER (WHERE brand_code IS NOT NULL)::int AS with_brand_code,
          COUNT(*) FILTER (WHERE product_range IS NOT NULL)::int AS with_range,
          COUNT(DISTINCT order_id)::int AS orders,
          COUNT(DISTINCT brand_id)::int AS houses,
          COUNT(DISTINCT product_id)::int AS designs,
          COUNT(DISTINCT (brand_id, product_id, currency))::int AS rows_total,
          COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
          COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines,
          COALESCE(
            array_agg(DISTINCT currency) FILTER (WHERE currency IS NOT NULL),
            '{}'
          ) AS currencies,
          MIN(created_at) AS first_order_at,
          MAX(created_at) AS last_order_at
     FROM ${SCOPE_NAME}`

// pg hands numeric back as a string; qty and value_cents are the two.
const toRow = (row) =>
  Object.freeze({
    brand_name: row.brand_name,
    product_name: row.product_name,
    product_type: row.product_type,
    currency: row.currency,
    orders: row.orders,
    qty: Number(row.qty),
    value_cents: Number(row.value_cents),
    unpriced_lines: row.unpriced_lines,
  })

const isoOr = (value) => (value ? new Date(value).toISOString() : null)

/**
 * The totals row. The quantity is deliberately absent (metres and units do not
 * add), and so is the value when the population quotes more than one currency —
 * a projected row simply has no such key, which the CRM renders as a dash and
 * the CSV as an empty cell.
 */
const totalsFrom = (summary) => {
  const totals = {
    ...TOTALS_LABELS,
    orders: summary.orders,
    unpriced_lines: summary.unpriced_lines,
  }
  if (summary.currencies.length <= 1) {
    totals.currency = summary.currencies[0] ?? null
    totals.value_cents = Number(summary.value_cents)
  }
  return Object.freeze(totals)
}

/**
 * Build the report. One builder, so US-006's export runs the same query as the
 * table and the two cannot answer differently.
 *
 * The envelope is `{ report, title, columns, rows, totals, meta }` — the shape
 * maskReport narrows and the CRM's cell pipeline renders: `columns` carries the
 * labels and kinds, every row is keyed by column key in column order, and
 * `totals` is a row of the same shape.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters] output of parseReportFilters
 * @param {{ limit?: number|null }} [options]
 */
export const productPerformanceReport = async (db, filters = {}, { limit } = {}) => {
  const capped = clampLimit(limit === undefined ? DEFAULT_ROW_LIMIT : limit)
  const { cte, params } = buildRevenueScope(filters)

  const [rowsResult, summaryResult] = await Promise.all([
    db.query(
      rowsSql(cte, capped === null ? null : `$${params.length + 1}`),
      capped === null ? params : [...params, capped]
    ),
    db.query(summarySql(cte), params),
  ])

  const summary = summaryResult.rows[0]
  const rows = rowsResult.rows.map(toRow)

  return Object.freeze({
    report: PRODUCT_PERFORMANCE,
    title: PRODUCT_PERFORMANCE_TITLE,
    columns: PRODUCT_PERFORMANCE_COLUMNS,
    rows,
    totals: totalsFrom(summary),
    meta: Object.freeze({
      filters,
      houses: summary.houses,
      designs: summary.designs,
      rows_total: summary.rows_total,
      row_limit: capped,
      // Said rather than implied: a table cut at the limit with totals covering
      // everything is honest only while it admits which of the two it is.
      truncated: rows.length < summary.rows_total,
      currencies: Object.freeze([...summary.currencies]),
      // More than one currency in the population means the totals row carries no
      // value. The flag is what lets a screen explain the gap instead of drawing
      // a blank cell.
      mixed_currency: summary.currencies.length > 1,
      coverage: Object.freeze({
        source: 'live platform orders',
        // The window the figures actually came from, not the window that was
        // asked for — an empty population has neither.
        from: isoOr(summary.first_order_at),
        to: isoOr(summary.last_order_at),
        requested_from: filters.from ?? null,
        requested_to: filters.to ?? null,
        historic_sales: 'header-only, not included',
        // How much of THIS population carries W21's two dimensions. Without it
        // a `range` filter that matched nothing is indistinguishable from a
        // range that sold nothing — and today the first is the likely answer.
        dimensions: dimensionCoverage({
          rows: summary.lines,
          with_brand_code: summary.with_brand_code,
          with_range: summary.with_range,
        }),
        note: COVERAGE_NOTE,
      }),
    }),
  })
}
