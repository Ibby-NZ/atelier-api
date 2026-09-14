// Sales and stock by colourway — the one table where what SOLD and what is ON
// THE SHELF sit on the same row.
//
// The client's ask, verbatim (CRM R-12): "a sales report on a product/stock
// (with colour) — how much is sold on a product (example: Nuage Ciel)". Every
// other money report here stops at the design; the colourway is the unit Atelier
// actually sells and stocks, and it is the grain at which sales and holdings
// can be read against each other — a colour selling out, a colour nobody buys
// sitting on the shelf, a colour allocated past what is on hand.
//
// It is the second report NOT rooted in the revenue scope, and it could not be:
// a colourway with stock and no sale is exactly the row this report exists to
// show, and the scope starts at `orders`. So it starts at the CATALOGUE and
// joins outwards — inventory for the holding, and the revenue scope (aggregated
// per colourway) for the sale — the stock report's shape and the scope's
// population, in one FROM.
//
// Four things it has to say out loud:
//
//   - THE POPULATION IS "SOLD IN THE WINDOW, OR HELD". Atelier runs an indent
//     model, so most colourways have neither; listing them would bury the
//     handful of real rows under thousands of nils. A colourway that sold OR
//     that has stock on hand or reserved is a row; one with neither is not.
//
//   - TWO CLOCKS. The sales figures are of the filtered window (a date range
//     narrows them like every scope-backed report); the stock figures are a
//     snapshot as at the request, because `inventory` holds no history. The
//     coverage block carries both, and the CSV's notes say so.
//
//   - EVERY FILTER IS HONOURED, IN THE HALF IT BELONGS TO. Catalogue filters
//     (house, design, SKU, collection, category, type, code, range) narrow the
//     rows; the lifecycle filters (dates, kind, status, rep) narrow what
//     "sold" means. Both reach the scope as well, so the two halves describe
//     one population.
//
//   - NO COST, NO VALUATION. The stock report's rule, for the stock report's
//     reason: nothing in this schema holds a landed cost (A1 is open), so the
//     row carries a sell value and quantities, and no `finance` column.

import { defineColumns } from './access.js'
import { dimensionCoverage, stockSource } from './coverage.js'
import { buildReportFilters, partitionFilters } from './filters.js'
import { buildRevenueScope, REVENUE_STATUSES, SCOPE_NAME } from './revenue-lines.js'
import { STOCK_FILTERS } from './stock.js'
import { clampLimit, DEFAULT_ROW_LIMIT } from './limits.js'

export const COLOURWAY_PERFORMANCE = 'colourway-performance'
export const COLOURWAY_PERFORMANCE_TITLE = 'Sales and stock by colourway'

// The filters that narrow the catalogue half — the same eight the stock report
// honours, because the FROM is the stock report's. The lifecycle filters reach
// the scope half through buildRevenueScope and are honoured there.
export const CATALOGUE_FILTERS = STOCK_FILTERS

// The order is the question: identity, then the unit, then what SOLD beside
// what is HELD — so the sold-against-stock reading is the first thing on screen
// in a table this wide, and the money, the counts and the merchandising axis
// follow. `product_type` stands right before the quantities (their unit) and
// `currency` right before the value, the two rules every money report keeps.
export const COLOURWAY_PERFORMANCE_COLUMNS = defineColumns([
  { key: 'sku', label: 'SKU' },
  { key: 'brand_name', label: 'House' },
  { key: 'product_name', label: 'Design' },
  { key: 'colourway_name', label: 'Colourway' },
  // The colour's first tone as a hex string — a swatch beside its name on the
  // screen, and a plain value in the file. NULL when the catalogue has none.
  { key: 'hex', label: 'Swatch' },
  { key: 'product_type', label: 'Type' },
  { key: 'qty', label: 'Sold', kind: 'number' },
  { key: 'on_hand', label: 'On hand', kind: 'number' },
  { key: 'allocated', label: 'Allocated', kind: 'number' },
  { key: 'available', label: 'Available', kind: 'number' },
  { key: 'currency', label: 'Currency' },
  { key: 'value_cents', label: 'Sales', kind: 'money' },
  { key: 'orders', label: 'Orders', kind: 'number' },
  { key: 'unpriced_lines', label: 'Unpriced lines', kind: 'number' },
  { key: 'last_sold_at', label: 'Last sold', kind: 'date' },
  { key: 'category', label: 'Category' },
  // Link columns (see product-performance.js): the CRM opens a row's insight by
  // these and does not draw them.
  { key: 'brand_slug', label: 'House slug' },
  { key: 'product_slug', label: 'Design slug' },
])

export const COLOURWAY_PERFORMANCE_COVERAGE_NOTE =
  'One row per colourway that either sold in the window or is held in stock — live platform ' +
  'orders and live inventory only. Sales figures are of the filtered date range; on hand, ' +
  'allocated and available are a snapshot as at the moment of the request, because inventory ' +
  'holds no history. Available can be negative where a backorder has reserved stock that has ' +
  'not arrived. Colourways with no sale in the window and nothing on hand or allocated are not ' +
  'listed. No landed cost exists anywhere in this schema (A1 open), so there is no valuation. ' +
  'Atelier’s historic Dynamics 365 sales are staged header-only and appear here not at all.'

export const COLOURWAY_PERFORMANCE_TOTALS_LABELS = Object.freeze({
  sku: 'All colourways',
  brand_name: 'All houses',
})

// The scope, rolled up to one row per colourway. `value_raw` stays unrounded
// so the summary can round ONCE over the population; the row rounds its own.
const soldCte = `sold AS (
  SELECT colourway_id,
         COUNT(DISTINCT order_id)::int AS orders,
         SUM(qty) AS qty,
         SUM(line_value_cents) AS value_raw,
         COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines,
         MIN(created_at) AS first_sold_at,
         MAX(created_at) AS last_sold_at
    FROM ${SCOPE_NAME}
   GROUP BY colourway_id
)`

// The aliases src/reports/filters.js fixes: `c` colourways, `p` products, `b`
// brands, `col` collections. Inventory and the sold rollup are both LEFT: a
// colourway is a row for either reason.
const FROM = `FROM colourways c
             JOIN products p ON p.id = c.product_id
             JOIN brands b ON b.id = p.brand_id
             LEFT JOIN collections col ON col.id = p.collection_id
             LEFT JOIN inventory i ON i.colourway_id = c.id
             LEFT JOIN sold ON sold.colourway_id = c.id`

const HOLDING = '(i.qty_available > 0 OR i.qty_reserved > 0)'
const IN_POPULATION = `(sold.colourway_id IS NOT NULL OR ${HOLDING})`

const whereOf = (clauses) => [IN_POPULATION, ...clauses].join('\n         AND ')

const rowsSql = (cte, clauses, limitPlaceholder) => `WITH ${cte},
${soldCte}
   SELECT c.sku,
          b.name AS brand_name,
          p.name AS product_name,
          c.name AS colourway_name,
          c.hex_tones->>0 AS hex,
          p.product_type,
          p.category,
          p.currency,
          COALESCE(sold.orders, 0) AS orders,
          COALESCE(sold.qty, 0) AS qty,
          COALESCE(ROUND(sold.value_raw), 0) AS value_cents,
          COALESCE(sold.unpriced_lines, 0) AS unpriced_lines,
          sold.last_sold_at,
          i.qty_available AS on_hand,
          i.qty_reserved AS allocated,
          (i.qty_available - i.qty_reserved) AS available,
          b.slug AS brand_slug,
          p.slug AS product_slug
     ${FROM}
    WHERE ${whereOf(clauses)}
    ORDER BY value_cents DESC, qty DESC, on_hand DESC NULLS LAST, b.name, p.name, c.name
   ${limitPlaceholder ? `LIMIT ${limitPlaceholder}` : ''}`

// Over the whole population, never over the rows that survived the limit.
// `currencies` and `product_types` are of the SOLD rows only: an unsold
// holding in another currency has no value to add, and must not be the reason
// the totals row withholds one.
const summarySql = (cte, clauses) => `WITH ${cte},
${soldCte}
   SELECT COUNT(*)::int AS rows_total,
          COUNT(sold.colourway_id)::int AS colourways_sold,
          COUNT(*) FILTER (WHERE ${HOLDING})::int AS colourways_held,
          COUNT(*) FILTER (WHERE sold.colourway_id IS NULL)::int AS held_unsold,
          COUNT(*) FILTER (WHERE i.qty_available - i.qty_reserved < 0)::int AS over_allocated,
          COUNT(DISTINCT b.id)::int AS houses,
          COUNT(DISTINCT p.id)::int AS designs,
          COUNT(*) FILTER (WHERE b.brand_code IS NOT NULL)::int AS with_brand_code,
          COUNT(*) FILTER (WHERE p.product_range IS NOT NULL)::int AS with_range,
          (SELECT COUNT(DISTINCT order_id) FROM ${SCOPE_NAME})::int AS orders,
          COALESCE(SUM(sold.qty), 0) AS qty,
          COALESCE(ROUND(SUM(sold.value_raw)), 0) AS value_cents,
          COALESCE(SUM(sold.unpriced_lines), 0)::int AS unpriced_lines,
          COALESCE(SUM(i.qty_available), 0) AS on_hand,
          COALESCE(SUM(i.qty_reserved), 0) AS allocated,
          COALESCE(SUM(i.qty_available - i.qty_reserved), 0) AS available,
          COALESCE(array_agg(DISTINCT i.unit) FILTER (WHERE i.unit IS NOT NULL), '{}') AS units,
          COALESCE(
            array_agg(DISTINCT p.product_type) FILTER (WHERE sold.colourway_id IS NOT NULL),
            '{}'
          ) AS product_types,
          COALESCE(
            array_agg(DISTINCT p.currency) FILTER (WHERE sold.colourway_id IS NOT NULL AND p.currency IS NOT NULL),
            '{}'
          ) AS currencies,
          MIN(sold.first_sold_at) AS first_sold_at,
          MAX(sold.last_sold_at) AS last_sold_at
     ${FROM}
    WHERE ${whereOf(clauses)}`

// pg hands numeric back as a string. `null == null ? null` keeps a colourway
// with no inventory row honest: it has no holding figure, not a zero one.
const numberOr = (value) => (value === null || value === undefined ? null : Number(value))

const toRow = (row) =>
  Object.freeze({
    sku: row.sku,
    brand_name: row.brand_name,
    product_name: row.product_name,
    colourway_name: row.colourway_name,
    hex: row.hex ?? null,
    product_type: row.product_type,
    category: row.category ?? null,
    currency: row.currency ?? null,
    orders: row.orders,
    qty: Number(row.qty),
    value_cents: Number(row.value_cents),
    unpriced_lines: row.unpriced_lines,
    last_sold_at: row.last_sold_at ?? null,
    on_hand: numberOr(row.on_hand),
    allocated: numberOr(row.allocated),
    available: numberOr(row.available),
    brand_slug: row.brand_slug,
    product_slug: row.product_slug,
  })

const isoOr = (value) => (value ? new Date(value).toISOString() : null)

/**
 * The totals row. Three separate "can it be added" rules, because the row
 * carries three separately-denominated figures: the sold quantity totals while
 * the sold rows are one product_type, the value while they quote one currency,
 * and the three stock quantities while the holdings are in one unit.
 */
const totalsFrom = (summary) => {
  const totals = {
    ...COLOURWAY_PERFORMANCE_TOTALS_LABELS,
    orders: summary.orders,
    unpriced_lines: summary.unpriced_lines,
  }
  if (summary.product_types.length <= 1) {
    totals.product_type = summary.product_types[0] ?? null
    totals.qty = Number(summary.qty)
  }
  if (summary.currencies.length <= 1) {
    totals.currency = summary.currencies[0] ?? null
    totals.value_cents = Number(summary.value_cents)
  }
  if (summary.units.length <= 1) {
    totals.on_hand = Number(summary.on_hand)
    totals.allocated = Number(summary.allocated)
    totals.available = Number(summary.available)
  }
  return Object.freeze(totals)
}

/**
 * Build the report. One builder, so the export runs the same query as the
 * table and the two cannot answer differently.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters] output of parseReportFilters
 * @param {{ limit?: number|null }} [options]
 */
export const colourwayPerformanceReport = async (db, filters = {}, { limit } = {}) => {
  const capped = clampLimit(limit === undefined ? DEFAULT_ROW_LIMIT : limit)
  // The scope binds every filter first (its own numbering), then the catalogue
  // half appends the eight it repeats on the outer FROM.
  const scope = buildRevenueScope(filters)
  const { honoured } = partitionFilters(filters, CATALOGUE_FILTERS)
  const { clauses, params } = buildReportFilters(honoured, {
    params: scope.params,
    names: CATALOGUE_FILTERS,
  })

  const [rowsResult, summaryResult] = await Promise.all([
    db.query(
      rowsSql(scope.cte, clauses, capped === null ? null : `$${params.length + 1}`),
      capped === null ? params : [...params, capped]
    ),
    db.query(summarySql(scope.cte, clauses), params),
  ])

  const summary = summaryResult.rows[0]
  const rows = rowsResult.rows.map(toRow)

  return Object.freeze({
    report: COLOURWAY_PERFORMANCE,
    title: COLOURWAY_PERFORMANCE_TITLE,
    columns: COLOURWAY_PERFORMANCE_COLUMNS,
    rows,
    totals: totalsFrom(summary),
    meta: Object.freeze({
      filters,
      houses: summary.houses,
      designs: summary.designs,
      colourways_sold: summary.colourways_sold,
      colourways_held: summary.colourways_held,
      // Held but not sold in the window — the shelf the window did not move.
      held_unsold: summary.held_unsold,
      // Allocated past what is on hand: a real state (a backorder reserving
      // stock that has not arrived), counted because the office acts on it.
      over_allocated: summary.over_allocated,
      orders: summary.orders,
      unpriced_lines: summary.unpriced_lines,
      rows_total: summary.rows_total,
      row_limit: capped,
      truncated: rows.length < summary.rows_total,
      units: Object.freeze([...summary.units]),
      mixed_units: summary.units.length > 1,
      product_types: Object.freeze([...summary.product_types]),
      currencies: Object.freeze([...summary.currencies]),
      mixed_currency: summary.currencies.length > 1,
      statuses: filters.status ? Object.freeze([filters.status]) : REVENUE_STATUSES,
      coverage: Object.freeze({
        source: 'live platform orders and live inventory',
        stock_source: stockSource('inventory'),
        population: 'colourways sold in the window or held in stock',
        // Two clocks: the sales window observed, and the stock snapshot.
        from: isoOr(summary.first_sold_at),
        to: isoOr(summary.last_sold_at),
        requested_from: filters.from ?? null,
        requested_to: filters.to ?? null,
        as_at: new Date().toISOString(),
        historic_sales: 'header-only, not included',
        valuation: 'none — no landed cost source (A1 open)',
        dimensions: dimensionCoverage({
          rows: summary.rows_total,
          with_brand_code: summary.with_brand_code,
          with_range: summary.with_range,
        }),
        note: COLOURWAY_PERFORMANCE_COVERAGE_NOTE,
      }),
    }),
  })
}
