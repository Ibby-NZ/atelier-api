// Orders awaiting an invoice — the back office's chase list.
//
// It selects out of the revenue scope rather than building a second join tree
// (src/reports/revenue-lines.js), which is what keeps the D365 union seam a
// single place: when legacy line data lands it becomes a source there and this
// report inherits it. What it changes is the population's lifecycle window —
// an order is awaiting an invoice from the moment it is placed, not from the
// moment it is paid — so it declares its own `statuses` default.
//
// Three definitions the payload has to state, because a reader cannot see them
// and each one silently changes who appears on the list:
//
//   - A CARD CHECKOUT IS NEVER INVOICED, so it is outside this population by
//     definition rather than by default. The money was taken at Stripe and
//     `xero_invoice_ref` on those rows stays null forever; counting them would
//     report every web sale on the platform as an unbilled receivable. That is
//     a definition, not an overridable default — a `kind=checkout` filter
//     therefore intersects to nothing rather than opening it back up, and
//     `meta.kinds` says which kinds the report is of.
//
//   - A QUOTE IS NOT AWAITING AN INVOICE until the client accepts it, a
//     cancelled or refunded order never will be, and archived orders are out
//     of the office's own lists — so none of them is here. Every invoiceable
//     status is (INVOICEABLE_STATUSES, the Xero push's own set), because
//     accepted, back-ordered and processing orders are exactly the stages a
//     chase list is for; `status` remains a filter, so one stage at a time is
//     a query.
//
//   - IT CANNOT SAY WHAT THE ORDERS ARE WORTH. Request-kind lines are created
//     at `unit_price_cents = 0` and nothing on this platform ever fills them
//     in: the invoice amount is typed into Xero by hand at confirmation, and
//     FR-8 forbids calling Xero from here. A "Value" column would therefore be
//     a column of zeros under a money heading, which is a wrong figure to every
//     human who reads it — so there is none, and `meta.unpriced_lines` says how
//     many lines carry no price.

import { defineColumns } from './access.js'
import { dimensionCoverage, stockSource } from './coverage.js'
import { buildRevenueScope, SCOPE_NAME } from './revenue-lines.js'
import { clampLimit, DEFAULT_ROW_LIMIT } from './limits.js'
import { INVOICEABLE_STATUSES } from '../orders/order-states.js'

export const NOT_INVOICED = 'not-invoiced'
export const NOT_INVOICED_TITLE = 'Orders awaiting invoice'

// The lifecycle window, replacing the revenue scope's paid/shipped default. A
// `status` filter still replaces THIS, the same way it replaces that one. It is
// the Xero push's own set (INVOICEABLE_STATUSES): a quote the client has not
// accepted is not awaiting an invoice, and a cancelled order never will be.
export const NOT_INVOICED_STATUSES = INVOICEABLE_STATUSES

// The kinds this platform invoices at all. A definition of the report, not a
// default — see the header.
// 'manual' belongs here: a sales order the office keyed is invoiced through Xero
// exactly like a request. Only 'checkout' is absent — it was paid at Stripe and
// is never invoiced through this platform.
export const INVOICEABLE_KINDS = Object.freeze([
  'order_request',
  'backorder_request',
  'manual',
])

// No `finance` column: what is owed is not a cost, and this report carries no
// money figure at all (see the header).
export const NOT_INVOICED_COLUMNS = defineColumns([
  { key: 'order_number', label: 'Order' },
  { key: 'placed_at', label: 'Placed', kind: 'date' },
  { key: 'status', label: 'Status' },
  { key: 'kind', label: 'Kind' },
  { key: 'client', label: 'Client' },
  { key: 'brand_name', label: 'House' },
  { key: 'product_name', label: 'Design' },
  { key: 'sku', label: 'SKU' },
  { key: 'product_type', label: 'Type' },
  { key: 'qty', label: 'Quantity', kind: 'number' },
  { key: 'on_hand', label: 'On hand', kind: 'number' },
])

export const NOT_INVOICED_COVERAGE_NOTE =
  'Live platform orders carrying no Xero invoice reference, oldest first. Card checkouts are ' +
  'paid at Stripe and are never invoiced through this platform, so they are outside this ' +
  'report however long their reference stays empty; quotes not yet accepted, cancelled and ' +
  'archived orders are out of it ' +
  'too. A request line is created with no price and the invoice amount is typed into Xero by ' +
  'hand, so this report states what is awaiting an invoice and never what it is worth. ' +
  'Atelier’s historic Dynamics 365 invoices are staged header-only, so nothing from before the ' +
  'platform opened appears here.'

export const NOT_INVOICED_TOTALS_LABELS = Object.freeze({
  order_number: 'All orders',
  product_name: 'All lines',
})

// `client` is a COALESCE because an order is placed either by an account or by
// a guest and never by both; `on_hand` is the colourway's current holding, so
// the office can see whether the line it is about to invoice can be cut.
const SELECT = `SELECT s.order_number,
          s.created_at AS placed_at,
          s.status,
          s.kind,
          COALESCE(u.name, u.email, s.guest_email) AS client,
          s.brand_name,
          s.product_name,
          s.sku,
          s.product_type,
          s.qty,
          inv.qty_available AS on_hand
     FROM ${SCOPE_NAME} s
     LEFT JOIN users u ON u.id = s.user_id
     LEFT JOIN inventory inv ON inv.colourway_id = s.colourway_id`

// An order with a Xero reference has been invoiced; the kinds are the report's
// own definition and bind as a placeholder like every other value.
const conditionsSql = (kindPlaceholder) =>
  `WHERE s.invoice_ref IS NULL\n      AND s.kind = ANY(${kindPlaceholder}::text[])`

// Oldest first: a chase list is read from the order that has been waiting
// longest, which is the opposite of every other list in this API.
const rowsSql = (cte, kindPlaceholder, limitPlaceholder) => `WITH ${cte}
   ${SELECT}
    ${conditionsSql(kindPlaceholder)}
    ORDER BY s.created_at, s.order_number, s.line_id
   ${limitPlaceholder ? `LIMIT ${limitPlaceholder}` : ''}`

const summarySql = (cte, kindPlaceholder) => `WITH ${cte}
   SELECT COUNT(*)::int AS lines,
          COUNT(*) FILTER (WHERE s.brand_code IS NOT NULL)::int AS with_brand_code,
          COUNT(*) FILTER (WHERE s.product_range IS NOT NULL)::int AS with_range,
          COUNT(DISTINCT s.order_id)::int AS orders,
          COALESCE(SUM(s.qty), 0) AS qty,
          COUNT(*) FILTER (WHERE s.unpriced)::int AS unpriced_lines,
          COALESCE(
            array_agg(DISTINCT s.product_type) FILTER (WHERE s.product_type IS NOT NULL),
            '{}'
          ) AS product_types,
          MIN(s.created_at) AS oldest,
          MAX(s.created_at) AS newest
     FROM ${SCOPE_NAME} s
    ${conditionsSql(kindPlaceholder)}`

// pg hands numeric back as a string; qty and the inventory snapshot are the two.
// An absent inventory row (a colourway that has never been stocked) stays null
// rather than becoming 0 — "none held" and "no stock record" are different
// answers, and only the first is a quantity.
const toRow = (row) =>
  Object.freeze({
    order_number: row.order_number,
    placed_at: row.placed_at,
    status: row.status,
    kind: row.kind,
    client: row.client,
    brand_name: row.brand_name,
    product_name: row.product_name,
    sku: row.sku,
    product_type: row.product_type,
    qty: Number(row.qty),
    on_hand: row.on_hand === null ? null : Number(row.on_hand),
  })

const isoOr = (value) => (value ? new Date(value).toISOString() : null)

/**
 * The totals row.
 *
 * `on_hand` is deliberately absent: it is a snapshot of one colourway repeated
 * on every line that mentions it, so a column of them does not sum to anything.
 * `qty` is present only while the population is one unit — a fabric is metres
 * and a finished good is units, the same rule product performance applies.
 */
const totalsFrom = (summary) => {
  const totals = { ...NOT_INVOICED_TOTALS_LABELS }
  if (summary.product_types.length === 1) {
    totals.product_type = summary.product_types[0]
    totals.qty = Number(summary.qty)
  }
  return Object.freeze(totals)
}

/**
 * Build the not-invoiced report. One builder, so the export runs the same query
 * as the table and the two cannot answer differently.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters] output of parseReportFilters
 * @param {{ limit?: number|null }} [options]
 */
export const notInvoicedReport = async (db, filters = {}, { limit } = {}) => {
  const capped = clampLimit(limit === undefined ? DEFAULT_ROW_LIMIT : limit)
  const { cte, params } = buildRevenueScope(filters, { statuses: NOT_INVOICED_STATUSES })
  const kinds = `$${params.length + 1}`
  const bound = [...params, [...INVOICEABLE_KINDS]]

  const [rowsResult, summaryResult] = await Promise.all([
    db.query(
      rowsSql(cte, kinds, capped === null ? null : `$${bound.length + 1}`),
      capped === null ? bound : [...bound, capped]
    ),
    db.query(summarySql(cte, kinds), bound),
  ])

  const summary = summaryResult.rows[0]
  const rows = rowsResult.rows.map(toRow)

  return Object.freeze({
    report: NOT_INVOICED,
    title: NOT_INVOICED_TITLE,
    columns: NOT_INVOICED_COLUMNS,
    rows,
    totals: totalsFrom(summary),
    meta: Object.freeze({
      filters,
      orders: summary.orders,
      lines: summary.lines,
      // How many of those lines carry no price. Every one of them does today —
      // which is the point: it is what makes the missing money column a stated
      // fact rather than an omission.
      unpriced_lines: summary.unpriced_lines,
      rows_total: summary.lines,
      row_limit: capped,
      truncated: rows.length < summary.lines,
      product_types: Object.freeze([...summary.product_types]),
      mixed_units: summary.product_types.length > 1,
      kinds: INVOICEABLE_KINDS,
      statuses: filters.status ? Object.freeze([filters.status]) : NOT_INVOICED_STATUSES,
      coverage: Object.freeze({
        source: 'live platform orders with no invoice reference',
        // The window the rows actually came from, not the one that was asked
        // for — an empty population has neither.
        from: isoOr(summary.oldest),
        to: isoOr(summary.newest),
        requested_from: filters.from ?? null,
        requested_to: filters.to ?? null,
        value: 'not stated — request lines carry no price until Xero',
        // `on_hand` is a stock figure, so it names its source like every other
        // one in this API while the two staged D365 totals disagree by 2.65×.
        stock_source: stockSource('inventory'),
        dimensions: dimensionCoverage({
          rows: summary.lines,
          with_brand_code: summary.with_brand_code,
          with_range: summary.with_range,
        }),
        note: NOT_INVOICED_COVERAGE_NOTE,
      }),
    }),
  })
}
