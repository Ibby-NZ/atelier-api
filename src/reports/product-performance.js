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
//
// THE GRAINS ARE ONE REGISTRY. `group=` swaps which columns the one population
// is rolled up to — house, collection, design (the default), category, month,
// client, lifecycle status — and everything else (the scope, the filters, the
// coverage, the masking, the export) stays the one code path. The insight view
// (src/reports/insight.js) is built out of these grains, which is why they live
// here rather than in a file per section: a grain is a projection of the SAME
// sale, and two files would be two chances to disagree about what one is.

import { defineColumns } from './access.js'
import { dimensionCoverage } from './coverage.js'
import { ORDER_STATUSES } from './filters.js'
import { buildRevenueScope, REVENUE_STATUSES, SCOPE_NAME } from './revenue-lines.js'
import { clampLimit, DEFAULT_ROW_LIMIT } from './limits.js'

export const PRODUCT_PERFORMANCE = 'product-performance'
export const PRODUCT_PERFORMANCE_TITLE = 'Product performance by house and design'

// The four figures every grain carries, in the order every grain's table ends
// with. Declared once so a grain cannot spell a count differently from its
// neighbours.
const MEASURES = Object.freeze([
  { key: 'orders', label: 'Orders', kind: 'number' },
  { key: 'qty', label: 'Quantity', kind: 'number' },
  { key: 'value_cents', label: 'Sales', kind: 'money' },
  { key: 'unpriced_lines', label: 'Unpriced lines', kind: 'number' },
])

// Declared at module load, so a malformed column throws while this file is
// loading rather than as a response. Order is the table's order and the CSV's
// header order — maskReport builds every row from this list.
//
// Nothing here is `finance`. A sell value is money and is not a cost (the
// distinction access.js states): the CRM's own policy leaves a sell "Value"
// column open to every staff login and masks the landed/cost ones, which is what
// US-007's stock report will declare. Masking still runs over this report, so it
// carries `meta.masked_columns` like every other.
//
// The two slugs at the end are LINK columns: the CRM needs a stable identity to
// open a row's insight (`?brand=…&product=…`), and maskReport projects rows onto
// the declared columns, so an undeclared key would never reach the screen. They
// are declared last so the visible table reads as it always did; the CRM does
// not draw them, and in the CSV they are the identities a spreadsheet can key on.
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
  ...MEASURES,
  { key: 'brand_slug', label: 'House slug' },
  { key: 'product_slug', label: 'Design slug' },
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
  ...MEASURES,
])

// One row per house: how many designs and colours of it sold, and what for.
export const PRODUCT_PERFORMANCE_HOUSE_COLUMNS = defineColumns([
  { key: 'brand_name', label: 'House' },
  { key: 'product_type', label: 'Type' },
  { key: 'currency', label: 'Currency' },
  { key: 'designs', label: 'Designs sold', kind: 'number' },
  { key: 'colourways', label: 'Colourways sold', kind: 'number' },
  ...MEASURES,
  { key: 'brand_slug', label: 'House slug' },
])

// One row per collection within a house. A design need not belong to one, so
// the uncollected designs of a house aggregate as their own row rather than
// vanishing from the house's total.
export const PRODUCT_PERFORMANCE_COLLECTION_COLUMNS = defineColumns([
  { key: 'brand_name', label: 'House' },
  { key: 'collection_name', label: 'Collection' },
  { key: 'product_type', label: 'Type' },
  { key: 'currency', label: 'Currency' },
  { key: 'designs', label: 'Designs sold', kind: 'number' },
  ...MEASURES,
  { key: 'brand_slug', label: 'House slug' },
  { key: 'collection_slug', label: 'Collection slug' },
])

// The trend: one row per calendar month the population sold in. Months with
// no sale are simply absent — a gap is honest where a zero row would state a
// month the report never observed.
export const PRODUCT_PERFORMANCE_MONTH_COLUMNS = defineColumns([
  { key: 'month', label: 'Month' },
  { key: 'product_type', label: 'Type' },
  { key: 'currency', label: 'Currency' },
  ...MEASURES,
])

// Who buys it. An order is placed by an account or by a guest and never both,
// so `client` is the COALESCE every line-grain report already makes and
// `account` says which of the two a row is.
export const PRODUCT_PERFORMANCE_CLIENT_COLUMNS = defineColumns([
  { key: 'client', label: 'Client' },
  { key: 'account', label: 'Account' },
  { key: 'product_type', label: 'Type' },
  { key: 'currency', label: 'Currency' },
  ...MEASURES,
  { key: 'last_order_at', label: 'Last order', kind: 'date' },
])

// Where the demand sits in the lifecycle. This grain is the one that does NOT
// default to the paid/shipped population: its whole question is how much is
// quoted, back-ordered, invoiced, paid, shipped or cancelled, so it declares
// every status as its default — a `status` filter still replaces it like any
// other.
export const PRODUCT_PERFORMANCE_STATUS_COLUMNS = defineColumns([
  { key: 'status', label: 'Status' },
  { key: 'kind', label: 'Kind' },
  { key: 'product_type', label: 'Type' },
  { key: 'currency', label: 'Currency' },
  { key: 'lines', label: 'Lines', kind: 'number' },
  ...MEASURES,
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

export const CATEGORY_TOTALS_LABELS = Object.freeze({
  category: 'All categories',
})

// The four common aggregates, spelled once. Rounded at the aggregate, never per
// line: qty is numeric(12,2), so a line can be worth 4997.5 cents and rounding
// each one multiplies the error by the row count.
const MEASURES_SQL = `COUNT(DISTINCT order_id)::int AS orders,
          COALESCE(SUM(qty), 0) AS qty,
          COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
          COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines`

// Everything that differs between the grains, declared side by side so the
// query, the row mapper, the totals label and the rows_total identity cannot be
// mixed across grains. `identity` is what a row IS — the same tuple GROUP BY
// takes and rows_total counts, so the truncation arithmetic stays honest.
// `join` is the one extra join a grain may need beyond the scope (the client
// grain reads names off `users`); `statuses` is a grain's own default
// population, absent for every grain that means "a sale".
const GRAINS = Object.freeze({
  design: Object.freeze({
    title: PRODUCT_PERFORMANCE_TITLE,
    columns: PRODUCT_PERFORMANCE_COLUMNS,
    select: `brand_name,
          product_name,
          product_type,
          category,
          currency,
          ${MEASURES_SQL},
          brand_slug,
          product_slug`,
    groupBy:
      'brand_id, brand_name, brand_slug, product_id, product_name, product_slug, product_type, category, currency',
    order: 'value_cents DESC, qty DESC, brand_name, product_name',
    identity: '(brand_id, product_id, currency)',
    totalsLabels: TOTALS_LABELS,
  }),
  category: Object.freeze({
    title: PRODUCT_PERFORMANCE_TITLE,
    columns: PRODUCT_PERFORMANCE_CATEGORY_COLUMNS,
    select: `category,
          product_type,
          currency,
          ${MEASURES_SQL}`,
    // product_type and currency stay in the grain: a category can hold both
    // metres and units (a trimming and its fabric), and a quantity with no unit
    // or a value across two currencies is the figure this file refuses to emit.
    groupBy: 'category, product_type, currency',
    order: 'value_cents DESC, qty DESC, category',
    identity: '(category, product_type, currency)',
    totalsLabels: CATEGORY_TOTALS_LABELS,
  }),
  house: Object.freeze({
    title: 'Sales by house',
    columns: PRODUCT_PERFORMANCE_HOUSE_COLUMNS,
    select: `brand_name,
          product_type,
          currency,
          COUNT(DISTINCT product_id)::int AS designs,
          COUNT(DISTINCT colourway_id)::int AS colourways,
          ${MEASURES_SQL},
          brand_slug`,
    groupBy: 'brand_id, brand_name, brand_slug, product_type, currency',
    order: 'value_cents DESC, qty DESC, brand_name',
    identity: '(brand_id, product_type, currency)',
    totalsLabels: Object.freeze({ brand_name: 'All houses' }),
  }),
  collection: Object.freeze({
    title: 'Sales by collection',
    columns: PRODUCT_PERFORMANCE_COLLECTION_COLUMNS,
    // A design outside any collection is a real row of its house, labelled so —
    // a NULL here would render as a dash beside a figure with no explanation.
    select: `brand_name,
          COALESCE(collection_name, 'No collection') AS collection_name,
          product_type,
          currency,
          COUNT(DISTINCT product_id)::int AS designs,
          ${MEASURES_SQL},
          brand_slug,
          collection_slug`,
    groupBy:
      'brand_id, brand_name, brand_slug, collection_id, collection_name, collection_slug, product_type, currency',
    order: 'value_cents DESC, qty DESC, brand_name, collection_name',
    identity: '(brand_id, collection_id, product_type, currency)',
    totalsLabels: Object.freeze({ brand_name: 'All houses', collection_name: 'All collections' }),
  }),
  month: Object.freeze({
    title: 'Sales by month',
    columns: PRODUCT_PERFORMANCE_MONTH_COLUMNS,
    // The month resolves in the database session's timezone, like every date
    // bound in src/reports/filters.js — nothing here pins one.
    select: `to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
          product_type,
          currency,
          ${MEASURES_SQL}`,
    groupBy: `date_trunc('month', created_at), product_type, currency`,
    order: 'month, product_type, currency',
    identity: `(date_trunc('month', created_at), product_type, currency)`,
    totalsLabels: Object.freeze({ month: 'All months' }),
  }),
  client: Object.freeze({
    title: 'Sales by client',
    columns: PRODUCT_PERFORMANCE_CLIENT_COLUMNS,
    // Grouped by the identity (user id, or the guest's address), displayed by
    // the name — two accounts sharing a display name stay two rows.
    select: `COALESCE(u.name, u.email, guest_email) AS client,
          CASE WHEN ${SCOPE_NAME}.user_id IS NULL THEN 'guest' ELSE 'account' END AS account,
          product_type,
          currency,
          ${MEASURES_SQL},
          MAX(${SCOPE_NAME}.created_at) AS last_order_at`,
    // `users` carries a created_at of its own, hence the qualified column above.
    join: `LEFT JOIN users u ON u.id = ${SCOPE_NAME}.user_id`,
    groupBy: `${SCOPE_NAME}.user_id, guest_email, u.name, u.email, product_type, currency`,
    order: 'value_cents DESC, qty DESC, client',
    identity: `(${SCOPE_NAME}.user_id, guest_email, product_type, currency)`,
    totalsLabels: Object.freeze({ client: 'All clients' }),
  }),
  status: Object.freeze({
    title: 'Orders by lifecycle status',
    columns: PRODUCT_PERFORMANCE_STATUS_COLUMNS,
    select: `status,
          kind,
          product_type,
          currency,
          COUNT(*)::int AS lines,
          ${MEASURES_SQL}`,
    groupBy: 'status, kind, product_type, currency',
    order: 'status, kind, product_type, currency',
    identity: '(status, kind, product_type, currency)',
    totalsLabels: Object.freeze({ status: 'All statuses' }),
    statuses: ORDER_STATUSES,
  }),
})

// The groupings this report offers. A code-literal registry like the lifecycle
// one: the route's schema is what keeps an unknown value from a caller (Ajv
// strips or 400s it), so an unknown key HERE is a bug and throws plain. The
// default grain is not in it — it is what no `group` means.
export const PRODUCT_PERFORMANCE_GROUPINGS = Object.freeze(
  Object.keys(GRAINS).filter((key) => key !== 'design')
)

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
   SELECT ${grain.select}
     FROM ${SCOPE_NAME}
     ${grain.join ?? ''}
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
 * `group` swaps the grain (see GRAINS): rows aggregate by house, collection,
 * category, month, client or status rather than by house and design, columns
 * and totals labels move with them, and everything else — the scope, the
 * filters, the coverage, the masking — stays the one code path, so a grouped
 * table and its export still cannot disagree with the default one about what a
 * sale is.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters] output of parseReportFilters
 * @param {{ limit?: number|null, group?: string|null }} [options]
 */
export const productPerformanceReport = async (db, filters = {}, { limit, group } = {}) => {
  const capped = clampLimit(limit === undefined ? DEFAULT_ROW_LIMIT : limit)
  const grain = grainOf(group)
  const { cte, params } = buildRevenueScope(filters, { statuses: grain.statuses })

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
    title: grain.title,
    columns: grain.columns,
    rows,
    totals: totalsFrom(summary, grain),
    meta: Object.freeze({
      filters,
      // Which grain the rows are at, so a screen (and a reader of the CSV's
      // meta) can tell a rollup from the by-design default.
      grouped_by: group ?? null,
      houses: summary.houses,
      designs: summary.designs,
      lines: summary.lines,
      orders: summary.orders,
      unpriced_lines: summary.unpriced_lines,
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
      // Which lifecycle window the rows are of. A `status` filter replaces the
      // grain's default rather than narrowing it, so an empty answer can be
      // told from one outside the default.
      statuses: filters.status
        ? Object.freeze([filters.status])
        : (grain.statuses ?? REVENUE_STATUSES),
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
