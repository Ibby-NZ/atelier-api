// Stock holdings — what is on the shelf right now, by colourway.
//
// The first Epic 5 report that is NOT built on the revenue scope, and it could
// not be: the scope starts at `orders`, and a holding exists whether or not
// anybody has ever bought it. So this one starts at `inventory` and joins the
// catalogue outwards, which is also why it honours only the three filters whose
// columns it actually has (src/reports/filters.js's `names`).
//
// Four things it has to say out loud, because each of them changes what a
// figure means:
//
//   - IT IS A SNAPSHOT, NOT A RANGE. `inventory` carries current quantities and
//     no history — there is no stock ledger in this schema — so "stock as at
//     last month" is a question nothing here can answer. A `from`/`to` in the
//     CRM's shared filter bar is therefore reported as IGNORED rather than
//     silently narrowing nothing, and `meta.coverage.as_at` is the only date
//     the report has.
//
//   - THERE IS NO COST HERE, AND NONE IS INVENTED. The CRM's R-10 fixture shows
//     "Landed /m" and "Value" columns; nothing in this schema holds a landed
//     cost, and the only cost data Atelier has (`price_list_items`) keys on a
//     supplier code that CLAUDE.md forbids joining to a colourway. A1 (the cost
//     source) is still open, so the honest report carries no valuation at all —
//     writing a placeholder here is the mistake `duty_percent` is kept empty to
//     avoid. The consequence to know: this report declares no `finance` column,
//     so masking removes nothing from it.
//
//   - A ZERO ROW IS NOT A HOLDING. Atelier runs an indent model and most
//     colourways carry an inventory row at zero, so listing them would bury the
//     handful of real holdings under thousands of nils. The catalogue is where
//     a design with no stock is looked up; this is a report of what is held.
//
//   - AVAILABLE CAN BE NEGATIVE, AND MUST STAY SO. A backorder request reserves
//     stock that has not arrived (src/orders/order-request.js), so a colourway
//     can be allocated past what is on hand. Clamping that at zero would hide
//     exactly the over-allocation a stock report exists to surface.

import { defineColumns } from './access.js'
import { dimensionCoverage, stockSource } from './coverage.js'
import { buildReportFilters, partitionFilters } from './filters.js'
import { clampLimit, DEFAULT_ROW_LIMIT } from './limits.js'

export const STOCK = 'stock'
export const STOCK_TITLE = 'Stock holdings by colourway'

// The filters this report can honour: its FROM has the catalogue in it and no
// `orders` at all, so `from`, `to`, `kind` and `status` are questions about a
// lifecycle this report does not touch. buildReportFilters throws on an unknown
// name here, which is what makes this list a declaration rather than a comment.
// `brand_code` and `range` join it because both columns are already in this
// FROM (`b` and `p`), and `category` (Rebecca-R1) for the same reason; the
// four it still declines are the ones about a lifecycle it does not touch.
export const STOCK_FILTERS = Object.freeze([
  'brand',
  'brand_code',
  'range',
  'product_type',
  'category',
  'collection',
])

// No `finance` column, deliberately — see the header. Order is the table's and
// the CSV header's; maskReport builds every row from this list.
export const STOCK_COLUMNS = defineColumns([
  { key: 'sku', label: 'SKU' },
  { key: 'brand_name', label: 'House' },
  { key: 'product_name', label: 'Design' },
  // Rebecca-R1: the office reads fabrics, trims and wallpapers as separate
  // stock, so the axis rides on every row (a filter alone would answer one
  // category at a time and never show the split). NULL renders as a dash —
  // "uncategorised", not "none".
  { key: 'category', label: 'Category' },
  { key: 'colourway_name', label: 'Colourway' },
  { key: 'unit', label: 'Unit' },
  { key: 'on_hand', label: 'On hand', kind: 'number' },
  { key: 'allocated', label: 'Allocated', kind: 'number' },
  { key: 'available', label: 'Available', kind: 'number' },
])

export const STOCK_COVERAGE_NOTE =
  'A snapshot of live inventory as at the moment of the request — `inventory` holds current ' +
  'quantities and no history, so a date range is a question this report cannot answer and any ' +
  'date filter supplied is listed as ignored. Colourways with nothing on hand and nothing ' +
  'allocated are not holdings and are not listed. No landed cost exists anywhere in this schema ' +
  '(A1, the cost source, is still open), so this report carries no valuation and no cost column.'

export const STOCK_TOTALS_LABELS = Object.freeze({
  sku: 'All holdings',
  brand_name: 'All houses',
})

// `col` is joined for the collection filter alone; `p`/`b` carry the other two.
// The aliases are the ones src/reports/filters.js fixes.
const FROM = `FROM inventory i
             JOIN colourways c ON c.id = i.colourway_id
             JOIN products p ON p.id = c.product_id
             JOIN brands b ON b.id = p.brand_id
             LEFT JOIN collections col ON col.id = p.collection_id`

// A holding is stock on hand or stock spoken for. An archived design's stock is
// still on the shelf — archiving is a catalogue decision, not a stock movement —
// which is the same reason the revenue scope keeps an archived product's sales.
const HOLDING = '(i.qty_available > 0 OR i.qty_reserved > 0)'

const whereOf = (clauses) => [HOLDING, ...clauses].join('\n         AND ')

const rowsSql = (clauses, limitPlaceholder) => `SELECT c.sku,
          b.name AS brand_name,
          p.name AS product_name,
          p.category,
          c.name AS colourway_name,
          i.unit,
          i.qty_available AS on_hand,
          i.qty_reserved AS allocated,
          (i.qty_available - i.qty_reserved) AS available
     ${FROM}
    WHERE ${whereOf(clauses)}
    ORDER BY i.qty_available DESC, b.name, p.name, c.name
   ${limitPlaceholder ? `LIMIT ${limitPlaceholder}` : ''}`

// Over the whole population, never over the rows that survived the limit: a
// total that only added up the visible page agrees with everything on screen
// and is wrong.
const summarySql = (clauses) => `SELECT COUNT(*)::int AS rows_total,
          COUNT(*) FILTER (WHERE b.brand_code IS NOT NULL)::int AS with_brand_code,
          COUNT(*) FILTER (WHERE p.product_range IS NOT NULL)::int AS with_range,
          COUNT(DISTINCT b.id)::int AS houses,
          COUNT(DISTINCT p.id)::int AS designs,
          COALESCE(SUM(i.qty_available), 0) AS on_hand,
          COALESCE(SUM(i.qty_reserved), 0) AS allocated,
          COALESCE(SUM(i.qty_available - i.qty_reserved), 0) AS available,
          COALESCE(array_agg(DISTINCT i.unit) FILTER (WHERE i.unit IS NOT NULL), '{}') AS units,
          COUNT(*) FILTER (WHERE i.qty_available - i.qty_reserved < 0)::int AS over_allocated
     ${FROM}
    WHERE ${whereOf(clauses)}`

// pg hands numeric back as a string; all three quantities are numeric(12,2).
const toRow = (row) =>
  Object.freeze({
    sku: row.sku,
    brand_name: row.brand_name,
    product_name: row.product_name,
    category: row.category ?? null,
    colourway_name: row.colourway_name,
    unit: row.unit,
    on_hand: Number(row.on_hand),
    allocated: Number(row.allocated),
    available: Number(row.available),
  })

/**
 * The totals row. Metres and units do not add, so the three quantities are
 * ABSENT whenever the population holds more than one unit — a projected row
 * simply has no such key, which the CRM renders as a dash and the CSV as an
 * empty cell. The same rule product performance applies to a mixed-currency
 * value.
 */
const totalsFrom = (summary) => {
  const totals = { ...STOCK_TOTALS_LABELS }
  if (summary.units.length <= 1) {
    totals.unit = summary.units[0] ?? null
    totals.on_hand = Number(summary.on_hand)
    totals.allocated = Number(summary.allocated)
    totals.available = Number(summary.available)
  }
  return Object.freeze(totals)
}

/**
 * Build the stock report. One builder, so the export runs the same query as the
 * table and the two cannot answer differently.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters] output of parseReportFilters
 * @param {{ limit?: number|null }} [options]
 */
export const stockReport = async (db, filters = {}, { limit } = {}) => {
  const capped = clampLimit(limit === undefined ? DEFAULT_ROW_LIMIT : limit)
  // Only what this report can honour reaches the SQL, and only what it honoured
  // is echoed back as `meta.filters` — the CSV's notes are built from that, so
  // an ignored filter listed there would read as one that had narrowed the file.
  const { honoured, ignored } = partitionFilters(filters, STOCK_FILTERS)
  const { clauses, params } = buildReportFilters(honoured, { names: STOCK_FILTERS })

  const [rowsResult, summaryResult] = await Promise.all([
    db.query(
      rowsSql(clauses, capped === null ? null : `$${params.length + 1}`),
      capped === null ? params : [...params, capped]
    ),
    db.query(summarySql(clauses), params),
  ])

  const summary = summaryResult.rows[0]
  const rows = rowsResult.rows.map(toRow)

  return Object.freeze({
    report: STOCK,
    title: STOCK_TITLE,
    columns: STOCK_COLUMNS,
    rows,
    totals: totalsFrom(summary),
    meta: Object.freeze({
      filters: honoured,
      ignored_filters: ignored,
      houses: summary.houses,
      designs: summary.designs,
      rows_total: summary.rows_total,
      row_limit: capped,
      truncated: rows.length < summary.rows_total,
      units: Object.freeze([...summary.units]),
      mixed_units: summary.units.length > 1,
      // Allocated past what is on hand: a backorder request reserves stock that
      // has not arrived, so this is a real state and not a data fault. Counted
      // rather than hidden, because it is the number the office acts on.
      over_allocated: summary.over_allocated,
      coverage: Object.freeze({
        source: 'live inventory',
        // Which table the three quantities were read out of. Every stock figure
        // this API reports says so while the two staged D365 totals disagree by
        // 2.65× and cannot be reconciled — see src/reports/coverage.js.
        stock_source: stockSource('inventory'),
        as_at: new Date().toISOString(),
        holdings_only: true,
        valuation: 'none — no landed cost source (A1 open)',
        dimensions: dimensionCoverage({
          rows: summary.rows_total,
          with_brand_code: summary.with_brand_code,
          with_range: summary.with_range,
        }),
        note: STOCK_COVERAGE_NOTE,
      }),
    }),
  })
}
