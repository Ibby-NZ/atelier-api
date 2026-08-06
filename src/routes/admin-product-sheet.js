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
  applyProductSheet,
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

// The dry run and the apply refuse a broken sheet in exactly the same words, so
// the CRM renders one report and the office reads one message whichever button
// it pressed. Both say "Nothing has been written", and for the apply that is a
// statement about a transaction that rolled back rather than about a route that
// never writes.
const refusalBody = (report) => ({
  error: 'Unprocessable Entity',
  message:
    `${report.errors.length} row${report.errors.length === 1 ? '' : 's'} could not be read. ` +
    'Nothing has been written.',
  // Capped, and the true count sits beside it — sixty broken rows are usually
  // one mistake made sixty times.
  errors: report.errors.slice(0, MAX_REPORTED_ERRORS),
  error_count: report.errors.length,
  summary: report.summary,
})

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
        return refusalBody(report)
      }

      // `updates` is the apply step's seam and is deliberately not served: the
      // office decides from the counts and the preview, and the apply re-reads
      // the file rather than trusting a list a client hands back.
      return {
        summary: report.summary,
        changes: report.changes.slice(0, MAX_REPORTED_CHANGES),
      }
    }
  )

  // The write. It takes the FILE again rather than the validate step's report:
  // a list of updates handed back by a client is a list the client could have
  // edited, and re-reading the bytes costs one parse and is the only version of
  // this route that cannot be driven to write something the office never saw.
  // The consequence — the office may have changed the catalogue between the two
  // requests — is why the counts are recomputed here and returned, rather than
  // the validate step's being echoed.
  app.post(
    '/admin/product-sheet/apply',
    { preHandler: backoffice, bodyLimit: IMPORT_BODY_LIMIT },
    async (request, reply) => {
      const report = await applyProductSheet(pool, request.body)

      if (report.errors.length > 0) {
        reply.code(422)
        return refusalBody(report)
      }

      return {
        // What the database actually wrote. `summary.changed` is what the sheet
        // asked for and the two agree by construction, but a count the office
        // reads as "done" should be the statement's own.
        applied: report.applied,
        summary: report.summary,
        changes: report.changes.slice(0, MAX_REPORTED_CHANGES),
      }
    }
  )
}
