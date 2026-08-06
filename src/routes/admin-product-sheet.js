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
  DEFAULT_BRAND_SLUG,
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

export const adminProductSheetRoutes = async (app, { pool }) => {
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
}
