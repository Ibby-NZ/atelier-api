// Sales by staff member — "how many sales has Rebecca made".
//
// It selects out of the revenue scope like every money report here, so its
// figures cannot disagree with product performance or the revenue lines; the
// rep columns ride the scope itself (src/reports/revenue-lines.js), not a
// second join tree.
//
// Three definitions the payload states, because each silently changes whose
// number this is:
//
//   - ATTRIBUTION IS STAFF-ASSERTED, AND A6 IS STILL OPEN. The rep on an order
//     is what a person set in the CRM — never derived from the legacy owner
//     column (72% of it is a shared login). Until the office assigns reps,
//     most of this report IS the Unassigned row, and that is the honest state.
//   - NULL IS AN EXPLICIT 'Unassigned' ROW, never dropped. Every order raised
//     before the column existed and every web checkout is unassigned; hiding
//     them would overstate everyone else's share of the same total.
//   - GROUPED BY THE ID, DISPLAYED BY THE NAME. Two staff called Rebecca stay
//     two rows; a deleted account's orders fall back to Unassigned (the FK is
//     SET NULL), which the note says out loud.
//
// `value_cents` is not a finance column — a sell value is money and is not a
// cost, the same call product performance and revenue-lines make.

import { defineColumns } from './access.js'
import { dimensionCoverage } from './coverage.js'
import { buildRevenueScope, SCOPE_NAME, REVENUE_STATUSES } from './revenue-lines.js'
import { clampLimit, DEFAULT_ROW_LIMIT } from './limits.js'

export const SALES_BY_REP = 'sales-by-rep'
export const SALES_BY_REP_TITLE = 'Sales by staff member'

export const SALES_BY_REP_COLUMNS = defineColumns([
  { key: 'sales_rep', label: 'Staff member' },
  // A value needs its currency on the row, the rule every money report lives
  // by — one rep selling in two currencies is two rows, not one made-up sum.
  { key: 'currency', label: 'Currency' },
  { key: 'orders', label: 'Orders', kind: 'number' },
  { key: 'value_cents', label: 'Value', kind: 'money' },
  { key: 'unpriced_lines', label: 'Unpriced lines', kind: 'number' },
])

export const SALES_BY_REP_COVERAGE_NOTE =
  'Sales attributed to each staff member — live platform orders only, paid or shipped unless a ' +
  'status filter says otherwise. Attribution is set per order by staff in the CRM: orders raised ' +
  'before it existed, and every web checkout nobody has claimed, appear as “Unassigned” rather ' +
  'than being dropped. It is NOT derived from the Dynamics owner field, 72% of which is a shared ' +
  'login. A request line is created with no price and the invoice amount is typed into Xero by ' +
  'hand, so it counts under “unpriced lines” at nil value. Atelier’s historic Dynamics 365 sales ' +
  'are staged header-only and appear here not at all.'

export const SALES_BY_REP_TOTALS_LABELS = Object.freeze({
  sales_rep: 'All staff',
})

// Grouped by the ID (two same-named reps stay apart), displayed by the name.
// The FK is SET NULL, so a null id always means a null name — one COALESCE.
const rowsSql = (cte, limitPlaceholder) => `WITH ${cte}
   SELECT COALESCE(sales_rep, 'Unassigned') AS sales_rep,
          currency,
          COUNT(DISTINCT order_id)::int AS orders,
          COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
          COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines
     FROM ${SCOPE_NAME}
    GROUP BY sales_rep_user_id, sales_rep, currency
    ORDER BY value_cents DESC, sales_rep ASC
   ${limitPlaceholder ? `LIMIT ${limitPlaceholder}` : ''}`

const summarySql = (cte) => `WITH ${cte}
   SELECT COUNT(DISTINCT (sales_rep_user_id, currency))::int AS groups,
          COUNT(DISTINCT order_id)::int AS orders,
          COUNT(*)::int AS lines,
          COUNT(*) FILTER (WHERE brand_code IS NOT NULL)::int AS with_brand_code,
          COUNT(*) FILTER (WHERE product_range IS NOT NULL)::int AS with_range,
          COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
          COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines,
          COALESCE(
            array_agg(DISTINCT currency) FILTER (WHERE currency IS NOT NULL),
            '{}'
          ) AS currencies,
          MIN(created_at) AS first_order_at,
          MAX(created_at) AS last_order_at
     FROM ${SCOPE_NAME}`

const toRow = (row) =>
  Object.freeze({
    sales_rep: row.sales_rep,
    currency: row.currency,
    orders: row.orders,
    // pg hands numeric back as a string; rounded at the aggregate, never per line.
    value_cents: Number(row.value_cents),
    unpriced_lines: row.unpriced_lines,
  })

const isoOr = (value) => (value ? new Date(value).toISOString() : null)

// The value is present only while the population quotes ONE currency — a
// figure that cannot honestly be added is absent, never summed.
const totalsFrom = (summary) => {
  const totals = { ...SALES_BY_REP_TOTALS_LABELS, orders: summary.orders }
  if (summary.currencies.length <= 1) {
    totals.currency = summary.currencies[0] ?? null
    totals.value_cents = Number(summary.value_cents)
  }
  totals.unpriced_lines = summary.unpriced_lines
  return Object.freeze(totals)
}

/**
 * Build the sales-by-rep report. One builder, so the export runs the same
 * query as the table and the two cannot answer differently.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters] output of parseReportFilters
 * @param {{ limit?: number|null }} [options]
 */
export const salesByRepReport = async (db, filters = {}, { limit } = {}) => {
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
    report: SALES_BY_REP,
    title: SALES_BY_REP_TITLE,
    columns: SALES_BY_REP_COLUMNS,
    rows,
    totals: totalsFrom(summary),
    meta: Object.freeze({
      filters,
      orders: summary.orders,
      lines: summary.lines,
      unpriced_lines: summary.unpriced_lines,
      rows_total: summary.groups,
      row_limit: capped,
      truncated: rows.length < summary.groups,
      currencies: Object.freeze([...summary.currencies]),
      mixed_currency: summary.currencies.length > 1,
      statuses: filters.status ? Object.freeze([filters.status]) : REVENUE_STATUSES,
      coverage: Object.freeze({
        source: 'live platform orders, attribution staff-asserted per order',
        from: isoOr(summary.first_order_at),
        to: isoOr(summary.last_order_at),
        requested_from: filters.from ?? null,
        requested_to: filters.to ?? null,
        dimensions: dimensionCoverage({
          rows: summary.lines,
          with_brand_code: summary.with_brand_code,
          with_range: summary.with_range,
        }),
        note: SALES_BY_REP_COVERAGE_NOTE,
      }),
    }),
  })
}
