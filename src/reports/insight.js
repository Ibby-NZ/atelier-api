// The insight view — one subject, every angle, one round trip.
//
// The office's complaint about the library was that each report is one table
// and one table is one note: a house's sales say nothing about its stock, a
// design's stock nothing about which colours of it sell, and none of them says
// who buys it or when. This is the view that opens when a row is clicked, and
// it answers all of those at once for whatever the row was — a house, a
// collection, a design, a colourway — or for the whole platform when nothing is
// pinned.
//
// IT IS BUILT ENTIRELY OUT OF THE EXISTING REPORTS, deliberately. Every section
// is one of the library's builders called with the same filters (the grains of
// product-performance, colourway-performance, sales-by-rep, not-invoiced,
// revenue-lines), so a figure here can never disagree with the report it is
// also the answer to — the dashboard's rule ("never a second join tree"), at
// the scale of a whole screen. A section IS a report envelope
// (`{ key, report, title, columns, rows, totals, meta }`), so the CRM renders
// each with the cell pipeline it already has and a section's rows link onward
// exactly as the library's do.
//
// A SECTION WHOSE GRAIN IS PINNED IS OMITTED. With a design pinned, "by design"
// is one row repeating the header — a table that says nothing, costing a
// query. `sectionsFor` is pure so the rule is testable without a database.
//
// MASKING RUNS PER SECTION, on the way out (`maskInsight`), exactly as the
// route does for a single report: a finance column a section ever gains is
// deleted here too, and a section that is finance end to end is withheld and
// NAMED in `meta.withheld_sections` rather than failing the whole view — "no
// rows" and "you may not see this" have to stay distinguishable on a screen.
//
// No CSV route: the CRM exports the sections it drew, client-side, the way the
// reporting pack already does. A multi-table file has no single header row for
// src/reports/export.js to keep on line 1.

import { maskReport } from './access.js'
import { colourwayPerformanceReport } from './colourway-performance.js'
import { clampLimit, DEFAULT_ROW_LIMIT } from './limits.js'
import { notInvoicedReport } from './not-invoiced.js'
import { productPerformanceReport } from './product-performance.js'
import { buildRevenueScope, REVENUE_STATUSES, revenueLinesReport, SCOPE_NAME } from './revenue-lines.js'
import { salesByRepReport } from './sales-by-rep.js'

export const INSIGHT = 'insight'
export const INSIGHT_TITLE = 'Report insight'

// The orders section is a glance, not the ledger: R-13 is one click away with
// the same filters applied.
export const RECENT_ORDERS_LIMIT = 25

// A filter that narrows the population to ONE value of a grain. `brand` is
// multi-valued, so it pins only when it names exactly one house.
const pinned = (filters, name) =>
  name === 'brand' ? filters.brand?.length === 1 : filters[name] !== undefined

const grouped = (group) => (db, filters, options) =>
  productPerformanceReport(db, filters, { ...options, group })

// Every section, in the order the screen draws them. `pinnedBy` lists the
// filters that make the section redundant — a design pins its house, its
// collection and its category as well as itself.
export const INSIGHT_SECTIONS = Object.freeze([
  Object.freeze({ key: 'by_month', build: grouped('month') }),
  Object.freeze({
    key: 'by_house',
    pinnedBy: ['brand', 'collection', 'product', 'sku'],
    build: grouped('house'),
  }),
  Object.freeze({
    key: 'by_collection',
    pinnedBy: ['collection', 'product', 'sku'],
    build: grouped('collection'),
  }),
  Object.freeze({
    key: 'by_design',
    pinnedBy: ['product', 'sku'],
    build: (db, filters, options) => productPerformanceReport(db, filters, options),
  }),
  Object.freeze({
    key: 'by_category',
    pinnedBy: ['category', 'product', 'sku'],
    build: grouped('category'),
  }),
  Object.freeze({ key: 'by_colourway', build: colourwayPerformanceReport }),
  Object.freeze({ key: 'by_client', build: grouped('client') }),
  Object.freeze({ key: 'by_rep', pinnedBy: ['rep'], build: salesByRepReport }),
  Object.freeze({ key: 'by_status', pinnedBy: ['status'], build: grouped('status') }),
  Object.freeze({ key: 'awaiting_invoice', build: notInvoicedReport }),
  Object.freeze({
    key: 'recent_orders',
    build: (db, filters) => revenueLinesReport(db, filters, { limit: RECENT_ORDERS_LIMIT }),
  }),
])

/**
 * The sections a filter set warrants — every one whose grain the filters have
 * not already pinned to a single value.
 *
 * @param {object} [filters] output of parseReportFilters
 * @returns {ReadonlyArray<object>}
 */
export const sectionsFor = (filters = {}) =>
  Object.freeze(
    INSIGHT_SECTIONS.filter(
      (section) => !(section.pinnedBy ?? []).some((name) => pinned(filters, name))
    )
  )

/**
 * What the pinned filters point at, as the kind of thing it is. The deepest
 * pin wins: a SKU is one colour of one design of one house.
 *
 * @param {object} [filters]
 * @returns {'colourway'|'design'|'collection'|'house'|'houses'|'all'}
 */
export const subjectKind = (filters = {}) => {
  if (filters.sku !== undefined) return 'colourway'
  if (filters.product !== undefined) return 'design'
  if (filters.collection !== undefined) return 'collection'
  if (filters.brand?.length === 1) return 'house'
  if (filters.brand?.length > 1) return 'houses'
  return 'all'
}

// The catalogue records behind the pins, so the screen can title itself by
// name rather than by slug. Each is a scalar subquery keyed on the pin's
// value; an unpinned or mistyped pin resolves to null / [], which the screen
// shows as the raw filter. `collections.slug` is unique per house, not
// globally, so it comes back as a list.
const SUBJECT_SQL = `SELECT
  (SELECT COALESCE(json_agg(json_build_object('slug', slug, 'name', name) ORDER BY name), '[]'::json)
     FROM brands WHERE slug = ANY($1::text[])) AS brands,
  (SELECT json_build_object(
            'slug', p.slug, 'name', p.name, 'product_type', p.product_type, 'category', p.category,
            'brand_slug', b.slug, 'brand_name', b.name,
            'collection_slug', col.slug, 'collection_name', col.name)
     FROM products p
     JOIN brands b ON b.id = p.brand_id
     LEFT JOIN collections col ON col.id = p.collection_id
    WHERE p.slug = $2) AS product,
  (SELECT json_build_object(
            'sku', c.sku, 'name', c.name, 'hex', c.hex_tones->>0,
            'product_slug', p.slug, 'product_name', p.name,
            'brand_slug', b.slug, 'brand_name', b.name)
     FROM colourways c
     JOIN products p ON p.id = c.product_id
     JOIN brands b ON b.id = p.brand_id
    WHERE c.sku = $3) AS colourway,
  (SELECT COALESCE(json_agg(json_build_object(
            'slug', col.slug, 'name', col.name, 'brand_slug', b.slug, 'brand_name', b.name) ORDER BY b.name), '[]'::json)
     FROM collections col
     JOIN brands b ON b.id = col.brand_id
    WHERE col.slug = $4) AS collections`

const resolveSubject = async (db, filters) => {
  const { rows } = await db.query(SUBJECT_SQL, [
    [...(filters.brand ?? [])],
    filters.product ?? null,
    filters.sku ?? null,
    filters.collection ?? null,
  ])
  const row = rows[0]
  return Object.freeze({
    kind: subjectKind(filters),
    brands: Object.freeze(row.brands ?? []),
    product: row.product ?? null,
    colourway: row.colourway ?? null,
    collections: Object.freeze(row.collections ?? []),
  })
}

// The headline figures, over the default revenue population (a `status` filter
// replaces it, as everywhere). `clients` counts accounts and guest addresses
// alike — an order is placed by one or the other and never both.
const summarySql = (cte) => `WITH ${cte}
   SELECT COUNT(*)::int AS lines,
          COUNT(DISTINCT order_id)::int AS orders,
          COALESCE(SUM(qty), 0) AS qty,
          COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
          COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines,
          COUNT(DISTINCT brand_id)::int AS houses,
          COUNT(DISTINCT product_id)::int AS designs,
          COUNT(DISTINCT colourway_id)::int AS colourways,
          COUNT(DISTINCT COALESCE(user_id::text, guest_email))::int AS clients,
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

const isoOr = (value) => (value ? new Date(value).toISOString() : null)

const sectionByKey = (sections, key) => sections.find((section) => section.key === key) ?? null

// The two rules every totals row here lives by, applied to the tiles: a
// quantity is withheld across units and a value across currencies — null with
// the flag set, never a summed lie.
const summaryFrom = (row, filters, sections) => {
  const mixedUnits = row.product_types.length > 1
  const mixedCurrency = row.currencies.length > 1
  const colourways = sectionByKey(sections, 'by_colourway')
  const awaiting = sectionByKey(sections, 'awaiting_invoice')
  const stockUnits = colourways?.meta.units ?? []
  return Object.freeze({
    orders: row.orders,
    lines: row.lines,
    qty: mixedUnits ? null : Number(row.qty),
    product_type: mixedUnits ? null : (row.product_types[0] ?? null),
    mixed_units: mixedUnits,
    value_cents: mixedCurrency ? null : Number(row.value_cents),
    currency: mixedCurrency ? null : (row.currencies[0] ?? null),
    mixed_currency: mixedCurrency,
    unpriced_lines: row.unpriced_lines,
    houses: row.houses,
    designs: row.designs,
    colourways_sold: row.colourways,
    clients: row.clients,
    first_order_at: isoOr(row.first_order_at),
    last_order_at: isoOr(row.last_order_at),
    statuses: filters.status ? Object.freeze([filters.status]) : REVENUE_STATUSES,
    // Read off the colourway section rather than re-queried: one statement of
    // what is on the shelf for this subject.
    stock: Object.freeze({
      colourways_held: colourways?.meta.colourways_held ?? null,
      held_unsold: colourways?.meta.held_unsold ?? null,
      over_allocated: colourways?.meta.over_allocated ?? null,
      unit: stockUnits.length === 1 ? stockUnits[0] : null,
      mixed_units: stockUnits.length > 1,
      on_hand: colourways?.totals?.on_hand ?? null,
      allocated: colourways?.totals?.allocated ?? null,
      available: colourways?.totals?.available ?? null,
      as_at: colourways?.meta.coverage.as_at ?? null,
    }),
    awaiting_invoice: Object.freeze({
      lines: awaiting?.meta.lines ?? null,
      orders: awaiting?.meta.orders ?? null,
    }),
  })
}

/**
 * Build the insight view: the subject, the headline figures and every section
 * the filters warrant, in parallel.
 *
 * @param {import('pg').Pool} db
 * @param {object} [filters] output of parseReportFilters
 * @param {{ limit?: number|null }} [options] per-section row limit
 */
export const insightReport = async (db, filters = {}, { limit } = {}) => {
  const capped = clampLimit(limit === undefined ? DEFAULT_ROW_LIMIT : limit)
  const wanted = sectionsFor(filters)
  const { cte, params } = buildRevenueScope(filters)

  const [subject, summaryResult, ...built] = await Promise.all([
    resolveSubject(db, filters),
    db.query(summarySql(cte), params),
    ...wanted.map((section) => section.build(db, filters, { limit: capped })),
  ])

  const sections = built.map((report, index) =>
    Object.freeze({ key: wanted[index].key, ...report })
  )

  return Object.freeze({
    report: INSIGHT,
    title: INSIGHT_TITLE,
    subject,
    summary: summaryFrom(summaryResult.rows[0], filters, sections),
    sections,
    meta: Object.freeze({
      filters,
      row_limit: capped,
      sections: Object.freeze(sections.map((section) => section.key)),
      omitted_sections: Object.freeze(
        INSIGHT_SECTIONS.filter((section) => !wanted.includes(section)).map((section) => section.key)
      ),
    }),
  })
}

const uniqueLabels = (sections) =>
  Object.freeze([...new Set(sections.flatMap((section) => section.meta.masked_columns))])

/**
 * Narrow every section to what this login may see. A section refused outright
 * (finance end to end) is withheld and named rather than failing the view.
 *
 * @param {object} insight output of insightReport
 * @param {{ finance?: boolean }} access output of loadReportAccess
 */
export const maskInsight = (insight, access) => {
  const sections = []
  const withheld = []
  for (const section of insight.sections) {
    try {
      sections.push(maskReport(section, access))
    } catch (error) {
      if (error?.statusCode !== 403) throw error
      withheld.push(section.key)
    }
  }
  return Object.freeze({
    ...insight,
    sections: Object.freeze(sections),
    meta: Object.freeze({
      ...insight.meta,
      masked_columns: uniqueLabels(sections),
      withheld_sections: Object.freeze(withheld),
    }),
  })
}
