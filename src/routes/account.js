// The approved-trade client portal (`/account/*`).
//
// GUARD. Every route here uses `app.guards.requireRole('trade')` and nothing
// else. GRANTING_ROLES.trade is frozen as ['trade'] and `effectiveRole` collapses
// an unapproved trade account to 'customer', so that one preHandler already
// means "an approved trade account, not a customer, not staff" — which is
// exactly the audience. Re-deriving the same predicate in each handler is how
// the archived-user and CORS-methods regressions in this repo happened; there is
// one gate and it is the preHandler.
//
// Staff are excluded on purpose, consistently with the trade-pricing gate. A
// member of staff has the CRM and /admin/legacy/* for this data, and letting a
// backoffice session through would mean these handlers had to answer "whose
// portal am I looking at?", which they must never have to.
//
// SCOPING. The client's D365 identity is derived inside SQL from the session
// user id (src/trade-accounts/viewer.js). No handler here passes a customer name
// to a read model, and no read model here accepts one.
//
// RATE LIMITS. The limiter is registered `global: false`, so a route with no
// `config.rateLimit` is unmetered. Every route below opts in: the reads because
// the CSV export is the highest-value scrape target the portal adds, and the
// copy-request because it sends mail to the back office.

import {
  listClientSamples,
  listClientInvoices,
  getClientInvoice,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../trade-accounts/client-legacy.js'
import { loadViewerTradeAccount } from '../trade-accounts/viewer.js'
import { getAccountSummary } from '../account/summary.js'
import {
  APPLICATION_EDITABLE_COLUMNS,
  getTradeApplicationForUser,
  updateTradeApplicationForUser,
  newsletterOptInAddress,
} from '../users/trade-applications.js'
import { subscribeQuietly } from '../newsletter/mailchimp.js'
import {
  listTradePriceListBrands,
  getTradePriceList,
  toTradePriceListCsv,
  csvFilename,
} from '../pricing/trade-price-lists.js'

// Generous enough that a client paging through ten years of invoices never sees
// it, tight enough that scripted enumeration does.
const READ_RATE_LIMIT = { max: 240, timeWindow: '1 minute' }
// Each one sends two emails. Ten an hour is more copies than anyone needs.
const COPY_REQUEST_RATE_LIMIT = { max: 10, timeWindow: '1 hour' }

const pageQuerySchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

// D365 record ids are uuids. A malformed one is a 400 by schema rather than a
// `invalid input syntax for type uuid` 500 out of pg.
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

const invoiceParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
  },
}

const brandParamsSchema = {
  type: 'object',
  required: ['brandSlug'],
  properties: {
    brandSlug: { type: 'string', minLength: 1, maxLength: 200 },
  },
}

// The client's own trade form, editable from the portal (16 Sep 2026). The
// schema is structural (types + lengths); the field rules are the same
// validator the form was submitted under, so a 422 names the field.
const APPLICATION_TEXT = { type: ['string', 'null'], maxLength: 2000 }
const tradeDetailsPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: Object.fromEntries(
    APPLICATION_EDITABLE_COLUMNS.map((column) => [
      column,
      ['mailchimp_opt_in', 'wants_showroom_visit', 'wants_account_manager', 'cash_account_acceptable'].includes(column)
        ? { type: 'boolean' }
        : APPLICATION_TEXT,
    ])
  ),
}
const TRADE_DETAILS_RATE_LIMIT = { max: 30, timeWindow: '15 minutes' }

export const accountRoutes = async (
  app,
  { pool, mailer = null, newsletter = null, fetchImpl = fetch, tradePriceListsEnabled = false }
) => {
  const trade = app.guards.requireRole('trade')

  // The dashboard. Always 200, even for a login the back office has not linked
  // to a Dynamics customer yet — `trade_account.linked` says which.
  app.get(
    '/account/summary',
    { preHandler: trade, config: { rateLimit: READ_RATE_LIMIT } },
    async (request) =>
      getAccountSummary(pool, request.user, { priceListsEnabled: tradePriceListsEnabled })
  )

  // The client's own trade application — what they typed on the day, kept
  // current by them. 404 when the office created the login by hand.
  app.get(
    '/account/trade-application',
    { preHandler: trade, config: { rateLimit: READ_RATE_LIMIT } },
    async (request, reply) => {
      const application = await getTradeApplicationForUser(pool, request.user.id)
      if (!application) {
        reply.code(404)
        return { error: 'Not Found', message: 'No trade application is on file for this account.' }
      }
      return { application }
    }
  )

  app.patch(
    '/account/trade-application',
    {
      preHandler: trade,
      schema: { body: tradeDetailsPatchSchema },
      config: { rateLimit: TRADE_DETAILS_RATE_LIMIT },
    },
    async (request, reply) => {
      try {
        // Read first so the newsletter sign-up below can tell a switch to Yes
        // (or a new address) from a re-save of the whole form.
        const before = await getTradeApplicationForUser(pool, request.user.id)
        const application = await updateTradeApplicationForUser(pool, request.user.id, request.body)
        if (!application) {
          reply.code(404)
          return { error: 'Not Found', message: 'No trade application is on file for this account.' }
        }
        const optInAddress = newsletterOptInAddress(before, application)
        if (optInAddress) {
          await subscribeQuietly(newsletter, optInAddress, { fetchImpl, log: request.log })
        }
        return { application }
      } catch (error) {
        if (error.statusCode === 422) {
          reply.code(422)
          return { error: 'Unprocessable Entity', message: error.message, errors: error.errors }
        }
        throw error
      }
    }
  )

  // Sample history: the client's own cuttings out of the D365 register.
  app.get(
    '/account/samples',
    {
      preHandler: trade,
      config: { rateLimit: READ_RATE_LIMIT },
      schema: { querystring: pageQuerySchema },
    },
    async (request) =>
      listClientSamples(pool, request.user.id, {
        page: request.query.page,
        limit: request.query.limit,
      })
  )

  // Invoice RECORD — headers only. There are no lines to serve (the D365 export
  // is header-grain and line import is shelved) and no payment state (FR-8
  // forbids calling Xero, and the staged `status_reason` is a dispatch state).
  // The storefront must not present this as a statement.
  app.get(
    '/account/invoices',
    {
      preHandler: trade,
      config: { rateLimit: READ_RATE_LIMIT },
      schema: { querystring: pageQuerySchema },
    },
    async (request) =>
      listClientInvoices(pool, request.user.id, {
        page: request.query.page,
        limit: request.query.limit,
      })
  )

  // Ask the back office to email a copy of one invoice — what replaces the PDF
  // download the portal cannot offer.
  //
  // The id in the path is re-resolved through the caller's OWN scoped query. A
  // D365 GUID is not a secret (it appears in staff screens and exports), so the
  // path may not be trusted to identify an entitlement; an invoice belonging to
  // anyone else is a 404, not a 403, because a 403 confirms it exists. Without
  // this the back office would receive "client X wants invoice <guid>" with no
  // way to tell it was not theirs, and would post it.
  app.post(
    '/account/invoices/:id/copy-request',
    {
      preHandler: trade,
      config: { rateLimit: COPY_REQUEST_RATE_LIMIT },
      schema: { params: invoiceParamsSchema },
    },
    async (request, reply) => {
      const invoice = await getClientInvoice(pool, request.user.id, request.params.id)
      if (!invoice) {
        reply.code(404)
        return { error: 'Not Found', message: 'No matching invoice found.' }
      }
      const account = await loadViewerTradeAccount(pool, request.user.id)
      if (mailer) {
        // The mailer never throws; a delivery failure must not fail the request
        // the client just made.
        await mailer.send({
          template: 'backoffice_invoice_copy_request',
          to: mailer.backofficeEmail,
          data: {
            invoice_number: invoice.number,
            invoice_date: invoice.invoice_date,
            company_name: account?.company_name ?? null,
            requested_by: request.user.email,
          },
        })
        await mailer.send({
          template: 'invoice_copy_requested',
          to: request.user.email,
          data: { invoice_number: invoice.number },
        })
      }
      reply.code(202)
      return { requested: true, invoice_number: invoice.number }
    }
  )

  // Price lists ship DISABLED — see src/pricing/trade-price-lists.js. The routes
  // are simply not registered when the flag is off, so an unauthorised probe
  // gets a 404 with no hint that the feature exists.
  if (!tradePriceListsEnabled) {
    return
  }

  app.get(
    '/account/price-lists',
    { preHandler: trade, config: { rateLimit: READ_RATE_LIMIT } },
    async () => listTradePriceListBrands(pool)
  )

  app.get(
    '/account/price-lists/:brandSlug',
    {
      preHandler: trade,
      config: { rateLimit: READ_RATE_LIMIT },
      schema: { params: brandParamsSchema },
    },
    async (request) => getTradePriceList(pool, request.params.brandSlug)
  )

  // The download. `.csv` is a path segment rather than a suffix on the param —
  // Fastify would otherwise fold it into the slug and every lookup would 404.
  app.get(
    '/account/price-lists/:brandSlug/export.csv',
    {
      preHandler: trade,
      config: { rateLimit: READ_RATE_LIMIT },
      schema: { params: brandParamsSchema },
    },
    async (request, reply) => {
      const list = await getTradePriceList(pool, request.params.brandSlug)
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        // Filename is built from the slug, which is `[a-z0-9-]` by construction,
        // so nothing staff typed can reach this header.
        .header('content-disposition', `attachment; filename="${csvFilename(list.brand.slug)}"`)
      return toTradePriceListCsv(list)
    }
  )
}
