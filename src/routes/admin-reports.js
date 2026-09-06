// The report library's JSON API. Back-office only (director inherits), and
// every handler is three lines: parse the querystring into filters, build the
// report, mask it against the caller.
//
// MASKING IS NOT OPTIONAL AND IS NOT PER REPORT. `maskReport` runs on the way
// out of every route here, even for a report that declares no finance column —
// it is what puts `meta.masked_columns` on the payload, and a route that skipped
// it would be the one that silently ships a finance column the day its report
// declares one. Access comes from `request.user` alone (src/reports/access.js);
// nothing a caller can send reaches it. `loadReportAccess` rather than
// `reportAccess`, because the guard's projection carries no `can_view_finance`
// and a route reading it off `request.user` would answer `finance: false` to
// everyone — see that function's own note.
//
// ERRORS TRAVEL AS THEMSELVES. `parseReportFilters` throws a 400 and
// `maskReport` a 403, both as `Object.assign(new Error(msg), { statusCode })`,
// which Fastify serialises as `{ statusCode, error, message }` — so there is no
// try/catch here, the same posture src/checkout/checkout.js takes.
//
// RATE LIMITS. Admin routes in this API do not usually opt in (the limiter is
// `global: false` and the backoffice guard is the gate), and these do: a report
// is an unbounded aggregate over the whole order ledger, so it is the one
// back-office surface where a stuck screen or a script is a database problem
// rather than a permissions one.
//
// ONE DECLARATION SERVES THE TABLE AND ITS EXPORT. `registerReport` below takes
// a single builder and registers both routes off it, so "the export shares one
// query builder with the table" is structural rather than a convention two
// handlers have to keep. The export differs in exactly three ways: it asks for
// every row, it accepts no `limit`, and it has its own tighter bucket.

import {
  parseReportFilters,
  PRODUCT_TYPES,
  PRODUCT_CATEGORIES,
  ORDER_KINDS,
  ORDER_STATUSES,
} from '../reports/filters.js'
import { loadReportAccess, maskReport } from '../reports/access.js'
import {
  toReportCsv,
  reportCsvFilename,
  REPORT_CSV_CONTENT_TYPE,
} from '../reports/export.js'
import {
  productPerformanceReport,
  PRODUCT_PERFORMANCE_GROUPINGS,
} from '../reports/product-performance.js'
import { stockReport } from '../reports/stock.js'
import { notInvoicedReport } from '../reports/not-invoiced.js'
import { revenueLinesReport } from '../reports/revenue-lines.js'
import { salesByRepReport } from '../reports/sales-by-rep.js'
import { DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT } from '../reports/limits.js'

// Generous for a screen that re-reads on every filter change, tight enough that
// a loop hammering a full-ledger aggregate is stopped.
const REPORT_RATE_LIMIT = { max: 60, timeWindow: '1 minute' }

// Tighter than the table's, deliberately. An export runs the same aggregate with
// no row limit and then serialises the whole of it, so it is the more expensive
// of the two by the margin the limit was providing — and it is a download a
// person clicks, not a screen that re-reads on every keystroke.
const EXPORT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' }

// `brand` is the one multi-valued filter, so it arrives either as a repeated
// param (an array, from the CRM) or as one comma-separated value (a hand-typed
// URL). Declaring only `string` would 400 the first of those before
// parseReportFilters ever saw it.
const brandFilter = {
  anyOf: [
    { type: 'string', maxLength: 400 },
    { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } },
  ],
}

// The schema is a shape check, not the whitelist: src/reports/filters.js is what
// decides which filters exist and what a value may be (an unknown name is
// ignored, an unusable value is a 400 naming it). The enums are here so a typo
// is refused at the boundary as well, and `additionalProperties: false` only
// strips unknown keys — Ajv's removeAdditional never rejects one.
const FILTER_PROPERTIES = {
  from: { type: 'string', maxLength: 32 },
  to: { type: 'string', maxLength: 32 },
  brand: brandFilter,
  // Free text, not slugs — a brand code is `CF` and a range is
  // `RAMM, SON & CROCKER`. Ajv's removeAdditional STRIPS a property this object
  // does not name, so a filter added to src/reports/filters.js and not to here
  // would answer 200 having filtered nothing. The length cap is the boundary
  // check; the shape rule is still the filter module's.
  brand_code: { type: 'string', maxLength: 100 },
  range: { type: 'string', maxLength: 100 },
  product_type: { type: 'string', enum: [...PRODUCT_TYPES] },
  category: { type: 'string', enum: [...PRODUCT_CATEGORIES] },
  collection: { type: 'string', maxLength: 200 },
  kind: { type: 'string', enum: [...ORDER_KINDS] },
  status: { type: 'string', enum: [...ORDER_STATUSES] },
  // A staff id (A6 groundwork). Integer at the boundary; the filter module
  // still owns the shape rule, as with every other name here.
  rep: { type: 'integer', minimum: 1 },
}

const reportQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FILTER_PROPERTIES,
    // MAX_ROW_LIMIT as the schema maximum, so an over-large limit is a 400
    // rather than a silent clamp reporting a page size nobody asked for.
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ROW_LIMIT,
      default: DEFAULT_ROW_LIMIT,
    },
  },
}

// The export takes the same filters and NO `limit`: a file that was the current
// page is the failure this story exists to prevent, so the parameter that could
// ask for one is simply not part of its vocabulary. Ajv strips a `limit` a
// caller sends rather than 400ing it, which is the right outcome here — the
// export's answer is every row either way.
const exportQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { ...FILTER_PROPERTIES },
}

export const adminReportRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  /**
   * Register a report's table and its export off ONE builder.
   *
   * `groupings` is declared per report and reaches BOTH schemas: a report that
   * offers none never declares `group` at all, so Ajv strips one a caller sends
   * rather than a builder silently ignoring it — the same posture the export
   * takes with `limit`. The grouped export stays the grouped table's file,
   * because both hand the same `group` to the same builder.
   *
   * @param {string} path the table's path; the file is `<path>/export.csv`
   * @param {(db: unknown, filters: object, options: object) => Promise<object>} build
   * @param {{ groupings?: readonly string[] }} [options]
   */
  const registerReport = (path, build, { groupings } = {}) => {
    const groupProperty = groupings ? { group: { type: 'string', enum: [...groupings] } } : {}
    const tableSchema = {
      ...reportQuerySchema,
      properties: { ...reportQuerySchema.properties, ...groupProperty },
    }
    const fileSchema = {
      ...exportQuerySchema,
      properties: { ...exportQuerySchema.properties, ...groupProperty },
    }
    // The payload IS the envelope — `{ report, title, columns, rows, totals, meta }`
    // — rather than being wrapped in a named key like the list routes. A report
    // is one document, and its own name is already the `report` field the CRM
    // keys its renderer on.
    app.get(
      path,
      {
        preHandler: backoffice,
        config: { rateLimit: REPORT_RATE_LIMIT },
        schema: { querystring: tableSchema },
      },
      async (request) => {
        const filters = parseReportFilters(request.query)
        const report = await build(pool, filters, {
          limit: request.query.limit,
          group: request.query.group,
        })
        return maskReport(report, await loadReportAccess(pool, request.user))
      }
    )

    // `.csv` is its own path segment, never a suffix on a param: Fastify would
    // otherwise fold it into the preceding `:param` and every lookup 404s.
    app.get(
      `${path}/export.csv`,
      {
        preHandler: backoffice,
        config: { rateLimit: EXPORT_RATE_LIMIT },
        schema: { querystring: fileSchema },
      },
      async (request, reply) => {
        const filters = parseReportFilters(request.query)
        // `limit: null` is the every-row contract. It is unreachable from the
        // table route (whose schema caps at MAX_ROW_LIMIT), which is what makes
        // "the export is not the current page" true while both share a builder.
        const report = await build(pool, filters, {
          limit: null,
          group: request.query.group,
        })

        // Masked BEFORE the writer sees a row, and before either header is set:
        // maskReport throws 403 for a report a caller may not have, and that
        // refusal has to leave as JSON rather than as a CSV attachment.
        const masked = maskReport(report, await loadReportAccess(pool, request.user))

        reply
          .header('content-type', REPORT_CSV_CONTENT_TYPE)
          // The filename comes from the report's own name — a module constant,
          // `[a-z0-9-]` and checked as such — so nothing a caller sends can
          // reach this header.
          .header('content-disposition', `attachment; filename="${reportCsvFilename(masked)}"`)

        return toReportCsv(masked)
      }
    )
  }

  // One line per report, table and file alike. A report that could not be
  // registered this way would be one whose export did not share its builder.
  registerReport('/admin/reports/product-performance', productPerformanceReport, {
    groupings: PRODUCT_PERFORMANCE_GROUPINGS,
  })
  registerReport('/admin/reports/stock', stockReport)
  registerReport('/admin/reports/not-invoiced', notInvoicedReport)
  // The orders behind the other three. It is the one report whose export is
  // still capped (REVENUE_LINE_LIMIT) — see src/reports/revenue-lines.js — and
  // it needs no other special case here.
  registerReport('/admin/reports/revenue-lines', revenueLinesReport)
  // Order-grain attribution over the same scope. NULL reps are an explicit
  // 'Unassigned' row — see the module header for the A6 caveats it states.
  registerReport('/admin/reports/sales-by-rep', salesByRepReport)
}
