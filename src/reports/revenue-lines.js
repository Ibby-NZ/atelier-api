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

import { FILTER_COLUMNS, REPORT_FILTER_NAMES, buildReportFilters } from './filters.js'

// The default revenue population, overridable by a `status` filter.
//
// Only checkout orders carry money: the Stripe webhook inserts them `paid` with
// every price re-resolved from retail_price_cents. `confirmed` is deliberately
// absent — on this platform a confirmation is a Xero reference typed by a human
// and carries no amount — and `requested` / `declined` are not sales at all.
export const REVENUE_STATUSES = Object.freeze(['paid', 'shipped'])

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
    // What unit_price_cents is denominated in. `orders` carries no currency of
    // its own, so this is the only thing that says whether two line values may
    // be added — a report totalling across currencies would be a made-up
    // number, which is the same reason checkout refuses a mixed-currency cart.
    currency: 'p.currency',
    brand_id: 'b.id',
    brand_slug: 'b.slug',
    brand_name: 'b.name',
    collection_slug: 'col.slug',
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
             LEFT JOIN collections col ON col.id = p.collection_id`,
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
    // with it: an intersection would answer `status=requested` with zero rows,
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

// A report aggregates in SQL, so this line-grain read exists for the tests and
// for a future line-level export. It is bounded for that reason: nothing here
// should ever stream the whole ledger into memory by accident.
export const REVENUE_LINE_LIMIT = 1000

/**
 * The scope's own rows, newest order first.
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
     SELECT * FROM ${SCOPE_NAME}
      ORDER BY created_at DESC, order_id DESC, line_id
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
