// The revenue scope — one CTE, and the seam where D365 line data unions in.
//
// Every money report in Epic 5 answers a question about the same population of
// order lines, so the population is declared ONCE here and each report selects
// out of it (US-005 groups it by house and design, US-006 exports the same
// query, US-007's not-invoiced narrows it). Three things follow:
//
//   - When legacy line data exists it becomes a second entry in SOURCES,
//     unioned into this CTE — not a rewrite of each report. Nothing can be
//     unioned today: all four D365 transaction entities are header-only (see
//     CLAUDE.md § Legacy D365 staging), which is exactly why the seam is built
//     before there is anything to put through it.
//
//   - The default population is ONE frozen constant, because architecture.md
//     § Reporting says settling A2 ("what counts as a sale") is a change to
//     that constant and nothing else.
//
//   - A request-kind line is part of the population and contributes its
//     QUANTITY at zero value. Those lines are created at unit_price_cents = 0
//     and nothing ever fills them in — the invoice amount is typed into Xero by
//     a human — so each line carries `unpriced`, and a report that sums money
//     counts them rather than dropping them. Dropped, they would understate the
//     metreage sold; counted as money, they would understate the average price.
//
// Filtering is src/reports/filters.js's job; this module only says which
// filters each source can honour and where the population starts.
//
// The line-grain read at the bottom is also served over HTTP as the
// `revenue-lines` report — the orders behind every other report's figures — so
// the file holds the scope, its two readers and the one report that is nothing
// but a reader. Everything above the readers is the population and is shared;
// a report edit must not reach it.

import { defineColumns } from './access.js'
import { dimensionCoverage } from './coverage.js'
import { FILTER_COLUMNS, REPORT_FILTER_NAMES, buildReportFilters } from './filters.js'
import { clampLimit, DEFAULT_ROW_LIMIT } from './limits.js'

// The default revenue population, overridable by a `status` filter.
//
// Money has changed hands from `paid` on: a paid order, a shipped one, and one
// the office has closed as completed. `pending_payment` is deliberately absent —
// an invoice is not a sale until it is paid — and the quote statuses,
// `cancelled` and `refunded` are not sales at all.
export const REVENUE_STATUSES = Object.freeze(['paid', 'shipped', 'completed'])

// A report that asks a question about a different part of the lifecycle states
// its own set instead (US-007's not-invoiced covers every live status, because
// an order is awaiting an invoice from the moment it is placed). It is a
// DEFAULT like REVENUE_STATUSES is: a `status` filter still replaces it, and a
// report that declines the filter has no way to be asked for something else.
const defaultStatuses = (statuses) =>
  statuses === undefined ? REVENUE_STATUSES : statuses

// The CTE's name, so a report and its export cannot spell it differently.
export const SCOPE_NAME = 'scope'

// One source of revenue lines. Every source must emit SCOPE_COLUMNS in the same
// order (a UNION ALL matches by position, not by name), declare which filters it
// can honour, and say which column carries its lifecycle status — or null, for a
// future source that has none, in which case the default population cannot be
// applied to it and it contributes its rows whole.
const LIVE_ORDER_LINES = Object.freeze({
  name: 'live order lines',
  columns: Object.freeze({
    // Which source a row came from. Cast, because the first branch of a UNION
    // fixes the column's type and an untyped literal is `unknown`.
    source: "'live'::text",
    order_id: 'o.id',
    order_number: 'o.order_number',
    kind: 'o.kind',
    status: 'o.status',
    created_at: 'o.created_at',
    // Who the order is for and whether it has been billed. The three of them
    // are what makes an invoice queue answerable out of this one population
    // (src/reports/not-invoiced.js) rather than out of a second join tree that
    // a future D365 source would then have to be unioned into twice.
    // `user_id` is null on a guest order and `guest_email` on an account one,
    // so a client name is a COALESCE of the two and never a join alone.
    user_id: 'o.user_id',
    guest_email: 'o.guest_email',
    invoice_ref: 'o.xero_invoice_ref',
    line_id: 'ol.id',
    colourway_id: 'ol.colourway_id',
    sku: 'c.sku',
    product_id: 'p.id',
    product_slug: 'p.slug',
    product_name: 'p.name',
    product_type: 'p.product_type',
    // Rebecca-R1's merchandising axis (fabric / wallpaper / trimming /
    // accessory). In the scope for the same reason the W21 dimensions below
    // are: every money report can filter and group on it without a second
    // join. Nullable — every product predates the column — and a NULL here is
    // "uncategorised", which the category report keeps as its own row rather
    // than dropping revenue nobody has filed yet.
    category: 'p.category',
    // W21's two reporting dimensions. They are in the scope rather than in each
    // report because both are filterable everywhere the scope reaches, and
    // because every report states how much of ITS population carries them
    // (src/reports/coverage.js) — a count each report would otherwise re-derive
    // from a second join.
    product_range: 'p.product_range',
    // What unit_price_cents is denominated in. `orders` carries no currency of
    // its own, so this is the only thing that says whether two line values may
    // be added — a report totalling across currencies would be a made-up
    // number, which is the same reason checkout refuses a mixed-currency cart.
    currency: 'p.currency',
    brand_id: 'b.id',
    brand_slug: 'b.slug',
    brand_name: 'b.name',
    brand_code: 'b.brand_code',
    collection_slug: 'col.slug',
    // The collection grain (insight's by-collection section) groups by the id
    // and displays the name, the sales-by-rep rule — a slug alone cannot label
    // a row and (brand_id, slug) is the unique key, not slug.
    collection_id: 'col.id',
    collection_name: 'col.name',
    // Staff-asserted sales attribution (A6 groundwork). Both ride the scope so
    // sales-by-rep groups and every report filters (`rep`) without a second
    // join tree; the name comes off the join, so a departed rep still displays.
    sales_rep_user_id: 'o.sales_rep_user_id',
    sales_rep: 'rep.name',
    qty: 'ol.qty',
    unit_price_cents: 'ol.unit_price_cents',
    // numeric, because qty is numeric(12,2) — 2.5 m at NZ$19.99 is 4997.5
    // cents. A report rounds when it aggregates rather than per line, or the
    // rounding error is multiplied by the row count.
    line_value_cents: '(ol.qty * ol.unit_price_cents)',
    unpriced: '(ol.unit_price_cents = 0)',
  }),
  // The aliases filters.js fixes: `o` orders, `b` brands, `p` products,
  // `col` collections. The collections join is LEFT because a product need not
  // belong to one; a `collection` filter therefore narrows to the collected
  // ones, which is what the filter means.
  from: `FROM orders o
             JOIN order_lines ol ON ol.order_id = o.id
             JOIN colourways c ON c.id = ol.colourway_id
             JOIN products p ON p.id = c.product_id
             JOIN brands b ON b.id = p.brand_id
             LEFT JOIN collections col ON col.id = p.collection_id
             LEFT JOIN users rep ON rep.id = o.sales_rep_user_id`,
  // An archived order is one the back office has taken out of its own lists and
  // must not keep contributing to revenue. Archived PRODUCTS and BRANDS are the
  // opposite case and are deliberately NOT excluded: the sale happened, and a
  // catalogue tidy-up must never rewrite last quarter's figures.
  conditions: Object.freeze(['o.archived_at IS NULL']),
  statusColumn: FILTER_COLUMNS.status,
  filters: REPORT_FILTER_NAMES,
})

const SOURCES = Object.freeze([LIVE_ORDER_LINES])

// The contract every source emits, in order.
export const SCOPE_COLUMNS = Object.freeze(Object.keys(LIVE_ORDER_LINES.columns))

const COLUMN_NAME = /^[a-z][a-z0-9_]*$/

/**
 * Checked at module load over every source, so a drifted union fails while the
 * file is loading rather than as a column of the wrong figures. Exported so the
 * unit tests can prove it actually rejects one.
 *
 * @param {object} source
 */
export const assertScopeSource = (source) => {
  const where = `Revenue scope source "${source?.name ?? 'unnamed'}"`
  if (!source?.name || typeof source.from !== 'string' || source.from.trim() === '') {
    throw new Error(`${where} needs a name and a FROM clause.`)
  }
  const columns = Object.keys(source.columns ?? {})
  // Positional, not set-wise: a UNION ALL lines its branches up by position, so
  // two sources agreeing on the NAMES while disagreeing on the order would put
  // one house's revenue under another's heading.
  if (columns.join(',') !== SCOPE_COLUMNS.join(',')) {
    throw new Error(
      `${where} must emit exactly [${SCOPE_COLUMNS.join(', ')}] in that order, got [${columns.join(', ')}].`
    )
  }
  for (const name of columns) {
    if (!COLUMN_NAME.test(name)) {
      throw new Error(`${where} has a malformed column name: ${name}`)
    }
  }
  for (const filter of source.filters ?? []) {
    if (!REPORT_FILTER_NAMES.includes(filter)) {
      throw new Error(`${where} claims an unknown filter: ${filter}`)
    }
  }
  if (source.statusColumn !== null && typeof source.statusColumn !== 'string') {
    throw new Error(`${where} must name its status column or state null.`)
  }
}

for (const source of SOURCES) {
  assertScopeSource(source)
}

const selectFor = (source, conditions) => {
  const projection = SCOPE_COLUMNS.map(
    (name) => `${source.columns[name]} AS ${name}`
  ).join(',\n             ')
  return `  SELECT ${projection}\n        ${source.from}\n       WHERE ${conditions.join('\n         AND ')}`
}

/**
 * Build the revenue scope CTE and its bound params.
 *
 * `params` lets a report bind placeholders of its own first; the array is
 * copied, never mutated. The result is used as `WITH ${cte} SELECT … FROM
 * scope`, so a report never restates the population.
 *
 * `statuses` is the default lifecycle window, defaulting to REVENUE_STATUSES —
 * a report about a different part of the lifecycle declares its own rather than
 * building a second join tree.
 *
 * @param {object} [filters] output of parseReportFilters
 * @param {{ params?: unknown[], statuses?: readonly string[] }} [options]
 * @returns {{ cte: string, params: unknown[] }}
 */
export const buildRevenueScope = (filters = {}, { params = [], statuses } = {}) => {
  let bound = [...params]
  const selects = []
  const population = defaultStatuses(statuses)

  for (const source of SOURCES) {
    const conditions = [...source.conditions]

    // The default population is REPLACED by a status filter, never intersected
    // with it: an intersection would answer `status=quote_requested` with zero rows,
    // which reads as "no trade" rather than "not in the default population".
    if (source.statusColumn && filters.status === undefined) {
      bound = [...bound, [...population]]
      conditions.push(`${source.statusColumn} = ANY($${bound.length}::text[])`)
    }

    const built = buildReportFilters(filters, { params: bound, names: source.filters })
    bound = built.params
    conditions.push(...built.clauses)

    selects.push(selectFor(source, conditions))
  }

  return {
    cte: `${SCOPE_NAME} AS (\n${selects.join('\n  UNION ALL\n')}\n)`,
    params: bound,
  }
}

// pg hands numeric back as a string; qty and line_value_cents are the two.
const toRevenueLine = (row) =>
  Object.freeze({
    ...row,
    qty: Number(row.qty),
    line_value_cents: Number(row.line_value_cents),
  })

// A report aggregates in SQL, so this line-grain read is the one that does not.
// It is bounded for that reason: nothing here should ever stream the whole
// ledger into memory by accident, and the `revenue-lines` report below inherits
// the bound rather than being the exception to it.
export const REVENUE_LINE_LIMIT = 1000

/**
 * The scope's own rows, newest order first.
 *
 * `client` is a COALESCE and not a second join tree — the scope carries
 * `user_id` and `guest_email` for exactly this, because an order is placed by an
 * account or by a guest and never by both (the same read src/reports/not-invoiced.js
 * makes of the same two columns).
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters]
 * @param {{ limit?: number }} [options]
 */
export const listRevenueLines = async (db, filters = {}, { limit } = {}) => {
  const requested = Number(limit)
  const capped = Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.trunc(requested)), REVENUE_LINE_LIMIT)
    : REVENUE_LINE_LIMIT
  const { cte, params } = buildRevenueScope(filters)

  const { rows } = await db.query(
    `WITH ${cte}
     SELECT s.*, COALESCE(u.name, u.email, s.guest_email) AS client
       FROM ${SCOPE_NAME} s
       LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC, s.order_id DESC, s.line_id
      LIMIT $${params.length + 1}`,
    [...params, capped]
  )
  return rows.map(toRevenueLine)
}

/**
 * The whole population in one row: how many lines, how much was sold, what it
 * came to, and how many of those lines carry no price. `unpriced_lines` is the
 * report's honesty column — without it a total that includes request-kind lines
 * looks like a discount.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters]
 */
export const summariseRevenue = async (db, filters = {}) => {
  const { cte, params } = buildRevenueScope(filters)

  const { rows } = await db.query(
    `WITH ${cte}
     SELECT COUNT(*)::int AS lines,
            COALESCE(SUM(qty), 0) AS qty,
            COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
            COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines
       FROM ${SCOPE_NAME}`,
    params
  )

  const row = rows[0]
  return Object.freeze({
    lines: row.lines,
    qty: Number(row.qty),
    value_cents: Number(row.value_cents),
    unpriced_lines: row.unpriced_lines,
  })
}

// ---------------------------------------------------------------------------
// The report: the orders behind every other report's figures.
//
// Every other report in the library answers with an aggregate, and the office's
// next question is always the same one — which orders is that made of. So this
// one is the population itself, one row per line, selecting out of the same
// scope so it cannot disagree with the totals it explains.
//
// Two things it does differently from its neighbours, both forced:
//
//   - IT IS CAPPED AT REVENUE_LINE_LIMIT, THE EXPORT INCLUDED. `limit: null` is
//     the every-row contract everywhere else here, and this is the one report
//     that must not honour it: an unbounded line-grain read of the ledger is
//     precisely what that constant exists to prevent. `meta.truncated` and
//     `meta.rows_total` say when the cap bit, and the coverage note says it in
//     the file — a truncated CSV read as a complete one is the failure.
//
//   - IT NAMES THE CLIENT, which no aggregate report can. That is a COALESCE
//     over the scope's own `user_id`/`guest_email` (see listRevenueLines), not a
//     second join tree.
//
// `value_cents` is NOT a finance column, matching product performance: a sell
// value is money and is not a cost, which is the distinction access.js draws and
// the one the CRM's own policy already applies.

export const REVENUE_LINES = 'revenue-lines'
export const REVENUE_LINES_TITLE = 'Orders placed, line by line'

export const REVENUE_LINES_COLUMNS = defineColumns([
  { key: 'order_number', label: 'Order' },
  { key: 'placed_at', label: 'Placed', kind: 'date' },
  { key: 'status', label: 'Status' },
  { key: 'kind', label: 'Kind' },
  { key: 'client', label: 'Client' },
  { key: 'brand_name', label: 'House' },
  { key: 'product_name', label: 'Design' },
  { key: 'sku', label: 'SKU' },
  // A quantity needs its unit and a value needs its currency, the two rules
  // every money report here lives by — so both ride on the row rather than being
  // implied by the heading.
  { key: 'product_type', label: 'Type' },
  { key: 'currency', label: 'Currency' },
  { key: 'qty', label: 'Quantity', kind: 'number' },
  { key: 'value_cents', label: 'Value', kind: 'money' },
])

export const REVENUE_LINES_COVERAGE_NOTE =
  'The order lines behind the revenue figures, newest first — live platform orders only. ' +
  'Atelier’s historic Dynamics 365 sales are staged header-only, so no order placed before the ' +
  'platform opened appears here at any grain. A request line is created with no price and the ' +
  'invoice amount is typed into Xero by hand, so it contributes its quantity at nil value and ' +
  `is counted under “unpriced lines”. This report is line-grain and is capped at ` +
  `${REVENUE_LINE_LIMIT} rows, the export included: narrow the window or the house rather than ` +
  'reading a truncated file as a complete one.'

export const REVENUE_LINES_TOTALS_LABELS = Object.freeze({
  order_number: 'All orders',
  product_name: 'All lines',
})

// Over the whole population, never over the page that survived the cap — a
// total that added up only the visible rows agrees with everything on screen and
// is wrong.
const summarySql = (cte) => `WITH ${cte}
   SELECT COUNT(*)::int AS lines,
          COUNT(*) FILTER (WHERE brand_code IS NOT NULL)::int AS with_brand_code,
          COUNT(*) FILTER (WHERE product_range IS NOT NULL)::int AS with_range,
          COUNT(DISTINCT order_id)::int AS orders,
          COALESCE(SUM(qty), 0) AS qty,
          -- Rounded at the aggregate, never per line: qty is numeric(12,2), so a
          -- line can be worth 4997.5 cents and rounding each one multiplies the
          -- error by the row count.
          COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
          COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines,
          COALESCE(
            array_agg(DISTINCT product_type) FILTER (WHERE product_type IS NOT NULL),
            '{}'
          ) AS product_types,
          COALESCE(
            array_agg(DISTINCT currency) FILTER (WHERE currency IS NOT NULL),
            '{}'
          ) AS currencies,
          MIN(created_at) AS first_order_at,
          MAX(created_at) AS last_order_at
     FROM ${SCOPE_NAME}`

// The scope's column names are the population's; the report's are the table's.
// qty and line_value_cents arrive already coerced by toRevenueLine.
const toRow = (line) =>
  Object.freeze({
    order_number: line.order_number,
    placed_at: line.created_at,
    status: line.status,
    kind: line.kind,
    client: line.client,
    brand_name: line.brand_name,
    product_name: line.product_name,
    sku: line.sku,
    product_type: line.product_type,
    currency: line.currency,
    qty: line.qty,
    value_cents: line.line_value_cents,
  })

const isoOr = (value) => (value ? new Date(value).toISOString() : null)

/**
 * The totals row. The quantity is absent while the population holds both metres
 * and units, and the value while it quotes more than one currency — the same two
 * rules product performance applies, for the same reason: a projected row simply
 * has no such key, which renders as a dash and exports as an empty cell.
 */
const totalsFrom = (summary) => {
  const totals = { ...REVENUE_LINES_TOTALS_LABELS }
  if (summary.product_types.length === 1) {
    totals.product_type = summary.product_types[0]
    totals.qty = Number(summary.qty)
  }
  if (summary.currencies.length <= 1) {
    totals.currency = summary.currencies[0] ?? null
    totals.value_cents = Number(summary.value_cents)
  }
  return Object.freeze(totals)
}

/**
 * Build the revenue-lines report. One builder, so the export runs the same query
 * as the table and the two cannot answer differently.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters] output of parseReportFilters
 * @param {{ limit?: number|null }} [options]
 */
export const revenueLinesReport = async (db, filters = {}, { limit } = {}) => {
  // `limit: null` is the export's every-row contract, and this is the one report
  // that answers it with the bound instead. clampLimit's own ceiling is the same
  // number today; listRevenueLines re-applies REVENUE_LINE_LIMIT either way, so
  // the cap holds even if the two constants ever part company.
  const capped =
    limit === null
      ? REVENUE_LINE_LIMIT
      : clampLimit(limit === undefined ? DEFAULT_ROW_LIMIT : limit)
  const { cte, params } = buildRevenueScope(filters)

  const [lines, summaryResult] = await Promise.all([
    listRevenueLines(db, filters, { limit: capped }),
    db.query(summarySql(cte), params),
  ])

  const summary = summaryResult.rows[0]
  const rows = lines.map(toRow)

  return Object.freeze({
    report: REVENUE_LINES,
    title: REVENUE_LINES_TITLE,
    columns: REVENUE_LINES_COLUMNS,
    rows,
    totals: totalsFrom(summary),
    meta: Object.freeze({
      filters,
      orders: summary.orders,
      lines: summary.lines,
      unpriced_lines: summary.unpriced_lines,
      rows_total: summary.lines,
      row_limit: capped,
      // Said rather than implied: this report cannot answer with every row, so
      // the flag is the difference between a page and the population.
      truncated: rows.length < summary.lines,
      currencies: Object.freeze([...summary.currencies]),
      mixed_currency: summary.currencies.length > 1,
      product_types: Object.freeze([...summary.product_types]),
      mixed_units: summary.product_types.length > 1,
      // Which lifecycle window the rows are of. A `status` filter replaces the
      // default population rather than narrowing it, so an empty answer can be
      // told from one outside the default.
      statuses: filters.status ? Object.freeze([filters.status]) : REVENUE_STATUSES,
      coverage: Object.freeze({
        source: 'live platform order lines',
        // The window the rows actually came from, not the one that was asked
        // for — an empty population has neither.
        from: isoOr(summary.first_order_at),
        to: isoOr(summary.last_order_at),
        requested_from: filters.from ?? null,
        requested_to: filters.to ?? null,
        historic_sales: 'header-only, not included',
        row_cap: REVENUE_LINE_LIMIT,
        dimensions: dimensionCoverage({
          rows: summary.lines,
          with_brand_code: summary.with_brand_code,
          with_range: summary.with_range,
        }),
        note: REVENUE_LINES_COVERAGE_NOTE,
      }),
    }),
  })
}
