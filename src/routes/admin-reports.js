// The report library's JSON API. Back-office only (director inherits), and
// every handler is three lines: parse the querystring into filters, build the
// report, mask it against the caller.
//
// MASKING IS NOT OPTIONAL AND IS NOT PER REPORT. `maskReport` runs on the way
// out of every route here, even for a report that declares no finance column —
// it is what puts `meta.masked_columns` on the payload, and a route that skipped
// it would be the one that silently ships a finance column the day its report
// declares one. Access comes from `request.user` alone (src/reports/access.js);
// nothing a caller can send reaches it.
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

import { parseReportFilters, PRODUCT_TYPES, ORDER_KINDS, ORDER_STATUSES } from '../reports/filters.js'
import { reportAccess, maskReport } from '../reports/access.js'
import {
  productPerformanceReport,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
} from '../reports/product-performance.js'

// Generous for a screen that re-reads on every filter change, tight enough that
// a loop hammering a full-ledger aggregate is stopped.
const REPORT_RATE_LIMIT = { max: 60, timeWindow: '1 minute' }

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
const reportQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', maxLength: 32 },
    to: { type: 'string', maxLength: 32 },
    brand: brandFilter,
    product_type: { type: 'string', enum: [...PRODUCT_TYPES] },
    collection: { type: 'string', maxLength: 200 },
    kind: { type: 'string', enum: [...ORDER_KINDS] },
    status: { type: 'string', enum: [...ORDER_STATUSES] },
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

export const adminReportRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  // The payload IS the envelope — `{ report, title, columns, rows, totals, meta }`
  // — rather than being wrapped in a named key like the list routes. A report is
  // one document, and its own name is already the `report` field the CRM keys
  // its renderer on.
  app.get(
    '/admin/reports/product-performance',
    {
      preHandler: backoffice,
      config: { rateLimit: REPORT_RATE_LIMIT },
      schema: { querystring: reportQuerySchema },
    },
    async (request) => {
      const filters = parseReportFilters(request.query)
      const report = await productPerformanceReport(pool, filters, {
        limit: request.query.limit,
      })
      return maskReport(report, reportAccess(request.user))
    }
  )
}
