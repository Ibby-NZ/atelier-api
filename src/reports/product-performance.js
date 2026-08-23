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
  // Rebecca-R1: the merchandising axis, riding on every row like the type does
  // — NULL is "uncategorised" and renders as a dash. A category filter alone
  // could not show the office WHICH categories a page of designs is, so the
  // column earns its place where brand_code and range (filters only) do not.
  { key: 'category', label: 'Category' },
  { key: 'currency', label: 'Currency' },
  { key: 'orders', label: 'Orders', kind: 'number' },
  { key: 'qty', label: 'Quantity', kind: 'number' },
  { key: 'value_cents', label: 'Sales', kind: 'money' },
  { key: 'unpriced_lines', label: 'Unpriced lines', kind: 'number' },
])

// Rebecca-R1's own grain: fabrics, trims and wallpapers reported SEPARATELY,
// as rows of one table rather than as four filtered requests. Still grouped by
// product_type and currency underneath, because a row's quantity needs a unit
// and its value a currency — the same two rules the by-design view lives by.
// The office's uncategorised backlog aggregates as its own NULL-category row:
// dropping it would silently understate every total until the category
// spreadsheet round trip has run.
export const PRODUCT_PERFORMANCE_CATEGORY_COLUMNS = defineColumns([
  { key: 'category', label: 'Category' },
  { key: 'product_type', label: 'Type' },
  { key: 'currency', label: 'Currency' },
  { key: 'orders', label: 'Orders', kind: 'number' },
  { key: 'qty', label: 'Quantity', kind: 'number' },
  { key: 'value_cents', label: 'Sales', kind: 'money' },
  { key: 'unpriced_lines', label: 'Unpriced lines', kind: 'number' },
])

// The groupings this report offers. A code-literal registry like the lifecycle
// one: the route's schema is what keeps an unknown value from a caller (Ajv
// strips or 400s it), so an unknown key HERE is a bug and throws plain.
export const PRODUCT_PERFORMANCE_GROUPINGS = Object.freeze(['category'])

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

export const CATEGORY_TOTALS_LABELS = Object.freeze({
  category: 'All categories',
})

// Everything that differs between the two grains, declared side by side so the
// query, the row mapper, the totals label and the rows_total identity cannot be
// mixed across grains. `identity` is what a row IS — the same tuple GROUP BY
// takes and rows_total counts, so the truncation arithmetic stays honest.
const GRAINS = Object.freeze({
  design: Object.freeze({
    columns: PRODUCT_PERFORMANCE_COLUMNS,
    select: `brand_name,
          product_name,
          product_type,
          category,
          currency`,
    groupBy: 'brand_id, brand_name, product_id, product_name, product_type, category, currency',
    order: 'value_cents DESC, qty DESC, brand_name, product_name',
    identity: '(brand_id, product_id, currency)',
    totalsLabels: TOTALS_LABELS,
  }),
  category: Object.freeze({
    columns: PRODUCT_PERFORMANCE_CATEGORY_COLUMNS,
    select: `category,
          product_type,
          currency`,
    // product_type and currency stay in the grain: a category can hold both
    // metres and units (a trimming and its fabric), and a quantity with no unit
    // or a value across two currencies is the figure this file refuses to emit.
    groupBy: 'category, product_type, currency',
    order: 'value_cents DESC, qty DESC, category',
    identity: '(category, product_type, currency)',
    totalsLabels: CATEGORY_TOTALS_LABELS,
  }),
})

const grainOf = (group) => {
  const grain = GRAINS[group === undefined || group === null ? 'design' : group]
  if (!grain) {
    // Unreachable from a caller — the route schema enumerates
    // PRODUCT_PERFORMANCE_GROUPINGS — so an unknown grouping is a bug in a
    // report and throws plain, the stockSource posture.
    throw new Error(`Unknown product-performance grouping: ${group}`)
  }
  return grain
}

const rowsSql = (cte, grain, limitPlaceholder) => `WITH ${cte}
   SELECT ${grain.select},
          COUNT(DISTINCT order_id)::int AS orders,
          COALESCE(SUM(qty), 0) AS qty,
          -- Rounded at the aggregate, never per line: qty is numeric(12,2), so a
          -- line can be worth 4997.5 cents and rounding each one multiplies the
          -- error by the row count.
          COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
          COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines
     FROM ${SCOPE_NAME}
    GROUP BY ${grain.groupBy}
    ORDER BY ${grain.order}
   ${limitPlaceholder ? `LIMIT ${limitPlaceholder}` : ''}`

// The totals and the coverage window are computed over the WHOLE population, not
// over the rows that survived the limit — a total that only added up the visible
// page would be wrong in exactly the way nobody checks.
const summarySql = (cte, grain) => `WITH ${cte}
   SELECT COUNT(*)::int AS lines,
          COUNT(*) FILTER (WHERE brand_code IS NOT NULL)::int AS with_brand_code,
          COUNT(*) FILTER (WHERE product_range IS NOT NULL)::int AS with_range,
          COUNT(DISTINCT order_id)::int AS orders,
          COUNT(DISTINCT brand_id)::int AS houses,
          COUNT(DISTINCT product_id)::int AS designs,
          COUNT(DISTINCT ${grain.identity})::int AS rows_total,
          COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
          COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines,
          COALESCE(
            array_agg(DISTINCT currency) FILTER (WHERE currency IS NOT NULL),
            '{}'
          ) AS currencies,
          MIN(created_at) AS first_order_at,
          MAX(created_at) AS last_order_at
     FROM ${SCOPE_NAME}`

// pg hands numeric back as a string; qty and value_cents are the two. Keyed by
// the grain's own columns IN ORDER, because the envelope contract is that every
// row's keys are the column keys in column order — one mapper per grain would
// be two chances to break that, so the columns drive it.
const toRow = (grain) => (row) =>
  Object.freeze(
    Object.fromEntries(
      grain.columns.map(({ key, kind }) => [
        key,
        kind === 'number' || kind === 'money'
          ? row[key] === null || row[key] === undefined
            ? row[key]
            : Number(row[key])
          : (row[key] ?? null),
      ])
    )
  )

const isoOr = (value) => (value ? new Date(value).toISOString() : null)

/**
 * The totals row. The quantity is deliberately absent (metres and units do not
 * add), and so is the value when the population quotes more than one currency —
 * a projected row simply has no such key, which the CRM renders as a dash and
 * the CSV as an empty cell.
 */
const totalsFrom = (summary, grain) => {
  const totals = {
    ...grain.totalsLabels,
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
 * `group: 'category'` (Rebecca-R1) swaps the grain: rows aggregate by category
 * rather than by house and design, columns and totals labels move with them,
 * and everything else — the scope, the filters, the coverage, the masking —
 * stays the one code path, so the grouped table and its export still cannot
 * disagree with the default one about what a sale is.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters] output of parseReportFilters
 * @param {{ limit?: number|null, group?: string|null }} [options]
 */
export const productPerformanceReport = async (db, filters = {}, { limit, group } = {}) => {
  const capped = clampLimit(limit === undefined ? DEFAULT_ROW_LIMIT : limit)
  const grain = grainOf(group)
  const { cte, params } = buildRevenueScope(filters)

  const [rowsResult, summaryResult] = await Promise.all([
    db.query(
      rowsSql(cte, grain, capped === null ? null : `$${params.length + 1}`),
      capped === null ? params : [...params, capped]
    ),
    db.query(summarySql(cte, grain), params),
  ])

  const summary = summaryResult.rows[0]
  const rows = rowsResult.rows.map(toRow(grain))

  return Object.freeze({
    report: PRODUCT_PERFORMANCE,
    title: PRODUCT_PERFORMANCE_TITLE,
    columns: grain.columns,
    rows,
    totals: totalsFrom(summary, grain),
    meta: Object.freeze({
      filters,
      // Which grain the rows are at, so a screen (and a reader of the CSV's
      // meta) can tell a category rollup from the by-design default.
      grouped_by: group ?? null,
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
