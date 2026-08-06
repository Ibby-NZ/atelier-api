// The category round trip's export route. Backoffice-only (director inherits):
// the sheet lists every product of a house, hidden ones included, which is the
// back office's own view of the catalogue.
//
// Handler stays thin — the header contract, the query and the CSV live in
// ../products/product-sheet.js.
//
// `.csv` is its own path segment, per the house rule: hung off a `:param` route
// Fastify folds it into the parameter and every lookup 404s. Nothing is
// parameterised in this path today, but the import routes to come sit under the
// same `/admin/product-sheet` prefix.

import {
  getProductSheet,
  toProductSheetCsv,
  productSheetFilename,
  validateProductSheet,
  DEFAULT_BRAND_SLUG,
  MAX_REPORTED_ERRORS,
  MAX_REPORTED_CHANGES,
} from '../products/product-sheet.js'

// A slug is `[a-z0-9-]` by construction, so a value that is not one names no
// house and is a 400 here rather than a 404 from the database. The default is
// applied by Ajv (`useDefaults`), so an unparameterised download is Atelier's
// own workroom — see DEFAULT_BRAND_SLUG.
const exportQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand: {
      type: 'string',
      pattern: '^[a-z0-9-]+$',
      maxLength: 200,
      default: DEFAULT_BRAND_SLUG,
    },
  },
}

// The filled-in sheet comes back as the raw file. There is no multipart parser
// in this API and adding one is a dependency, so the CRM posts the bytes with
// the file's own content type — and a browser reports a .csv as any of these
// three depending on the machine, so all three are parsed as a Buffer. Nothing
// else about body handling changes: content-type parsers are ENCAPSULATED to
// this plugin, the same posture as the Stripe webhook and the legacy import.
const SHEET_CONTENT_TYPES = Object.freeze([
  'text/csv',
  // What Windows reports for a .csv while Excel owns the extension.
  'application/vnd.ms-excel',
  // What a client that will not guess sends.
  'application/octet-stream',
])

// A house's sheet is one row per product; the largest house in the catalogue is
// a few thousand designs at ~80 bytes a row. Fastify's 1 MB default would
// refuse a legitimate one on the biggest houses.
const IMPORT_BODY_LIMIT = 4 * 1024 * 1024

export const adminProductSheetRoutes = async (app, { pool }) => {
  app.addContentTypeParser(
    [...SHEET_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: IMPORT_BODY_LIMIT },
    (request, body, done) => done(null, body)
  )

  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/product-sheet/export.csv',
    { preHandler: backoffice, schema: { querystring: exportQuerySchema } },
    async (request, reply) => {
      const sheet = await getProductSheet(pool, request.query.brand)
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        // The filename carries the slug the DATABASE holds, not the one asked
        // for: the two are equal here, but resolving it through the row is what
        // keeps that true if the lookup ever widens (an alias, a redirect).
        .header(
          'content-disposition',
          `attachment; filename="${productSheetFilename(sheet.brand.slug)}"`
        )
      return toProductSheetCsv(sheet)
    }
  )

  // The dry run the office sees before anything is written. It is a separate
  // route from the apply (US-004) rather than a `?dry_run=` flag because the
  // CRM flow is literally two steps — read the report, then decide — and a
  // request that can write must never be one query parameter away from one
  // that cannot.
  //
  // A row-level failure is 422 carrying every row's own line number. It is
  // RETURNED, never thrown: Fastify's error serializer emits exactly
  // { statusCode, error, message } and drops custom properties, so a thrown
  // error cannot carry `errors` — the same reason the lifecycle module returns
  // its refusals. A file that is not a product sheet at all is a 400 from the
  // parser, because there is nothing to report per row.
  app.post(
    '/admin/product-sheet/validate',
    { preHandler: backoffice, bodyLimit: IMPORT_BODY_LIMIT },
    async (request, reply) => {
      const report = await validateProductSheet(pool, request.body)

      if (report.errors.length > 0) {
        reply.code(422)
        return {
          error: 'Unprocessable Entity',
          message:
            `${report.errors.length} row${report.errors.length === 1 ? '' : 's'} could not be ` +
            'read. Nothing has been written.',
          // Capped, and the true count sits beside it — sixty broken rows are
          // usually one mistake made sixty times.
          errors: report.errors.slice(0, MAX_REPORTED_ERRORS),
          error_count: report.errors.length,
          summary: report.summary,
        }
      }

      // `updates` is the apply step's seam and is deliberately not served: the
      // office decides from the counts and the preview, and US-004 re-reads the
      // file rather than trusting a list a client hands back.
      return {
        summary: report.summary,
        changes: report.changes.slice(0, MAX_REPORTED_CHANGES),
      }
    }
  )
}
