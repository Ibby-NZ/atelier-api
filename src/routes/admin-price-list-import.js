// The CRM import wizard's back end — the three routes behind "we don't have to
// come to you".
//
//   POST /admin/price-lists/import/validate   the dry run. Writes nothing.
//   POST /admin/price-lists/import/apply      the write. One transaction.
//   GET  /admin/price-lists/imports           who imported what, when.
//
// TWO ROUTES RATHER THAN ONE `?dry_run=` FLAG, the product sheet's rule: the
// office's flow is literally two steps — read the report, then decide — and a
// request that can write must never be one query parameter away from one that
// cannot.
//
// NO MULTIPART PARSER, and that is a decision rather than an omission. There is
// none in this API; adding one is a dependency, and
// `src/routes/admin-product-sheet.js` already solved file upload with
// `addContentTypeParser` over the raw bytes. This route is that pattern with ONE
// more MIME on it, for .xlsx — because roughly two-fifths of the supplier drops
// are workbooks and asking the office to re-save each as CSV is how a file
// becomes cp1252 with nothing declaring it. Parsers are ENCAPSULATED to a
// plugin, so registering these four types here changes no other route's body
// handling (the same posture as the Stripe webhook and the legacy import).
//
// FINANCE-GATED, NOT MERELY BACKOFFICE. A wholesale rate is Atelier's buy side —
// cost data — and a dry run reports the old rate beside the new one, which is
// the same disclosure `GET /admin/price-list-items/:id/price-history` sits
// behind. The gate is `requireFinance(pool, …)` from src/reports/access.js,
// which resolves the flag through the DATABASE; reading
// `request.user.can_view_finance` answers `undefined` for everyone, because the
// guards' projection does not carry the column.

import {
  validatePriceListFile,
  applyPriceListFile,
  listPriceListImports,
  IMPORT_CATEGORIES,
  MAX_REPORTED_ERRORS,
  MAX_REPORTED_CHANGES,
} from '../pricing/price-list-import.js'
import { requireFinance } from '../reports/access.js'

// A browser reports a spreadsheet as any of these depending on the machine, and
// a client that will not guess sends octet-stream. The format is sniffed from
// the BYTES either way (a .xlsx is a zip: "PK\x03\x04"), so this list only has
// to be permissive enough to let the file through the parser.
//
// Do NOT add `text/plain` or `application/json`: the root instance already
// parses both, and re-registering an inherited type throws at boot.
const IMPORT_CONTENT_TYPES = Object.freeze([
  'text/csv',
  // What Windows reports for a .csv while Excel owns the extension.
  'application/vnd.ms-excel',
  // .xlsx — the one addition this story makes to the product sheet's pattern.
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
])

// The largest drop in the corpus is a few thousand rows of workbook. Fastify's
// 1 MB default would refuse a legitimate supplier file outright.
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024

// A filename is stored (`price_list_imports.filename`, and every row's
// `price_list_items.source_file`) and echoed back in error messages, so it is
// bounded and stripped of the two things that would let it forge a log line or a
// path: control characters, and any directory component. `pattern` is the gate —
// Ajv's removeAdditional does not validate, it only strips unknown keys.
const filenameProp = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[^\\u0000-\\u001f/\\\\]+$',
}

// Both are FALLBACKS, exactly as the filename is for the CLI converter:
//   - `supplier` is required in effect for a v1 file (it has no Supplier
//     column); a v3 file's own Supplier CELL wins over it, per row.
//   - `category` fills a BLANK Item Type cell only. A cell that SAYS something
//     the four-value vocabulary has no word for is reported with its row number
//     and never absorbed — that is US-004, and it is enforced in the parser
//     rather than here so it holds for every caller.
const importQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['filename'],
  properties: {
    filename: filenameProp,
    supplier: { type: 'string', minLength: 1, maxLength: 200 },
    category: { type: 'string', enum: [...IMPORT_CATEGORIES] },
  },
}

// The dry run and the apply refuse a broken file in exactly the same words, so
// the CRM renders one report and the office reads one message whichever button
// it pressed. "Nothing has been written" is a statement about a rolled-back
// transaction on the apply and about a route that cannot write on the validate.
const refusalBody = (report) => ({
  error: 'Unprocessable Entity',
  message:
    `${report.errors.length} row${report.errors.length === 1 ? '' : 's'} of `
    + `"${report.summary.file}" could not be read. Nothing has been written.`,
  errors: report.errors.slice(0, MAX_REPORTED_ERRORS),
  error_count: report.errors.length,
  // US-004 — the unmappable category values, called out apart from the rest.
  // A typo is the office's to fix; "Leather" is a word their vocabulary does not
  // have, and whether it should is their decision and not this importer's.
  unmappable_categories: report.unmappable_categories.slice(0, MAX_REPORTED_ERRORS),
  unmappable_category_count: report.unmappable_categories.length,
  summary: report.summary,
})

// What a clean file is answered with, dry run and apply alike.
const reportBody = (report) => ({
  summary: report.summary,
  changes: report.changes.slice(0, MAX_REPORTED_CHANGES),
  // Unpriced rows (rate 0 — price on application) are a legitimate omission and
  // never fatal, but they are the counts staff most often ask about, so they are
  // listed rather than merely totalled.
  skipped: report.skipped.slice(0, MAX_REPORTED_ERRORS),
})

export const adminPriceListImportRoutes = async (app, { pool }) => {
  app.addContentTypeParser(
    [...IMPORT_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: IMPORT_BODY_LIMIT },
    (request, body, done) => done(null, body)
  )

  const backoffice = app.guards.requireRole('backoffice')
  const financeOnly = requireFinance(
    pool,
    'Importing a supplier price list means reading and writing buy-side rates, '
    + 'which needs finance access. Ask a director.'
  )

  app.post(
    '/admin/price-lists/import/validate',
    {
      preHandler: [backoffice, financeOnly],
      bodyLimit: IMPORT_BODY_LIMIT,
      schema: { querystring: importQuerySchema },
    },
    async (request, reply) => {
      const report = await validatePriceListFile(pool, request.body, request.query)

      if (report.errors.length > 0) {
        reply.code(422)
        return refusalBody(report)
      }
      return reportBody(report)
    }
  )

  // The write takes the FILE again, never the dry run's report: a list of rates
  // handed back by a client is a list the client could have edited. Re-reading
  // the bytes costs one parse and is the only version of this route that cannot
  // be driven to write something the office never saw. The consequence — the
  // ledger may have moved between the two requests — is why the counts are
  // recomputed here and returned rather than the dry run's being echoed.
  app.post(
    '/admin/price-lists/import/apply',
    {
      preHandler: [backoffice, financeOnly],
      bodyLimit: IMPORT_BODY_LIMIT,
      schema: { querystring: importQuerySchema },
    },
    async (request, reply) => {
      const report = await applyPriceListFile(pool, request.body, {
        ...request.query,
        user: request.user,
      })

      if (report.errors.length > 0) {
        reply.code(422)
        return refusalBody(report)
      }

      request.log.info(
        {
          import_id: report.import.id,
          file: report.summary.file,
          template_version: report.summary.template_version,
          rows: report.summary.rows,
          applied: report.applied,
          changed: report.summary.changed,
        },
        'supplier price list imported'
      )

      return { applied: report.applied, import: report.import, ...reportBody(report) }
    }
  )

  // The import history the CRM lists (US-008): who, when, which file, how the
  // file accounted for itself. Only APPLIED imports are here — a refused upload
  // writes nothing and leaves no trace, or the screen would be a list of typos.
  app.get(
    '/admin/price-lists/imports',
    { preHandler: [backoffice, financeOnly] },
    async () => ({ imports: await listPriceListImports(pool) })
  )
}
