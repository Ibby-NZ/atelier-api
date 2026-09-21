import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyCors from '@fastify/cors'
import fastifyRateLimit from '@fastify/rate-limit'
import { createGuards } from './auth/guards.js'
import { isAdminPanelPath } from './admin/paths.js'
import { authRoutes } from './routes/auth.js'
import { catalogueRoutes } from './routes/catalogue.js'
import { shippingRoutes } from './routes/shipping.js'
import { checkoutRoutes } from './routes/checkout.js'
import { orderRoutes } from './routes/orders.js'
import { adminOrderRoutes } from './routes/admin-orders.js'
import { adminCatalogueRoutes } from './routes/admin-catalogue.js'
import { adminUsersRoutes } from './routes/admin-users.js'
import { adminTradeApplicationRoutes } from './routes/admin-trade-applications.js'
import { adminInventoryRoutes } from './routes/admin-inventory.js'
import { adminPriceListRoutes } from './routes/admin-price-lists.js'
import { adminPriceListImportRoutes } from './routes/admin-price-list-import.js'
import { adminSupplierRoutes } from './routes/admin-suppliers.js'
import { adminProductSheetRoutes } from './routes/admin-product-sheet.js'
import { adminFreightRoutes } from './routes/admin-freight.js'
import { adminPricingRoutes } from './routes/admin-pricing.js'
import { adminReportRoutes } from './routes/admin-reports.js'
import { adminDashboardRoutes } from './routes/admin-dashboard.js'
import { adminSampleRoutes } from './routes/admin-samples.js'
import { adminSampleRequestRoutes } from './routes/admin-sample-requests.js'
import { sampleRequestRoutes } from './routes/sample-requests.js'
import { adminSampleLoanRoutes } from './routes/admin-sample-loans.js'
import { adminEmailTemplateRoutes } from './routes/admin-email-templates.js'
import { adminPurchaseOrderRoutes } from './routes/admin-purchase-orders.js'
import { adminSupplierInvoiceRoutes } from './routes/admin-supplier-invoices.js'
import { adminReserveRoutes } from './routes/admin-reserves.js'
import { adminLegacyRoutes } from './routes/admin-legacy.js'
import { adminXeroRoutes } from './routes/admin-xero.js'
import { adminLegacyImportRoutes } from './routes/admin-legacy-import.js'
import { adminDynamicsArchiveRoutes } from './routes/admin-dynamics-archive.js'
import { adminTradeAccountRoutes } from './routes/admin-trade-accounts.js'
import { adminContactRoutes } from './routes/admin-contacts.js'
import { accountRoutes } from './routes/account.js'
import { contactRoutes } from './routes/contact.js'
import { newsletterRoutes } from './routes/newsletter.js'
import { webhookRoutes } from './routes/webhooks.js'

export const buildApp = ({
  pool,
  cookieSecret,
  stripe = null,
  stripeWebhookSecret = null,
  storeBaseUrl = 'http://localhost:4321',
  crmBaseUrl = 'http://localhost:5273',
  mailer = null,
  // Mailchimp audience config (src/config.js `newsletter`). null = POST
  // /newsletter answers 503.
  newsletter = null,
  // The Xero service (src/xero/service.js). null = not configured; the
  // /admin/xero routes answer 503, same posture as checkout without Stripe.
  xero = null,
  // Client-facing trade price lists (GET /account/price-lists). Off unless the
  // numbers behind trade_price_cents are real — see src/config.js.
  tradePriceListsEnabled = false,
  logLevel = 'info',
  logger = true,
  trustProxy = false,
  adminPanel = null,
  // How the Xero invoice states its totals (config.lineAmountTypes); the admin
  // order read model derives its GST figures from the same setting.
  lineAmountTypes = 'Exclusive',
} = {}) => {
  if (!pool) {
    throw new Error('buildApp requires a pg pool')
  }
  if (!cookieSecret) {
    throw new Error('buildApp requires a cookieSecret (COOKIE_SECRET env var)')
  }

  const app = Fastify({
    logger: logger ? { level: logLevel } : false,
    trustProxy,
  })

  app.register(fastifyCookie, { secret: cookieSecret })
  // global: false — only routes that opt in via config.rateLimit are limited.
  app.register(fastifyRateLimit, { global: false })

  // request.user is set by guards.requireAuth / guards.requireRole preHandlers.
  app.decorateRequest('user', null)
  app.decorate('guards', createGuards(pool))

  // Two browser apps fetch cross-origin with the session cookie: the storefront
  // islands (:4321 → api :3001) and the back-office CRM (:5273 → api :3001).
  // Both are separate origins, so both must be allowed by name and with
  // credentials. Same-site across ports means the SameSite=Lax session cookie
  // still flows. Omitting the CRM origin does not degrade it gracefully — the
  // browser blocks every response, so the CRM cannot even sign in.
  //
  // The allowance is an exact-match allowlist and the request's own origin is
  // echoed back only when it is on it. `origin: true` (reflect whatever asked)
  // plus `credentials: true` would let ANY site drive the API with a logged-in
  // staff cookie, so the list is closed by construction. A request with no
  // Origin (curl, same-origin navigation, the webhook) is unaffected.
  //
  // The AdminJS panel is excluded entirely: it is same-origin by construction,
  // and a credentialed CORS allowance would let any script on either app's
  // origin read and drive it with a logged-in staff cookie. A delegator is
  // required because @fastify/cors hoists to the root instance (fastify-plugin),
  // so encapsulating it in a child scope would not keep it off the panel — and
  // it also covers the CORS-registered wildcard `OPTIONS *` route, which a
  // route-membership check could not.
  //
  // `methods` MUST be spelled out. @fastify/cors defaults to GET,HEAD,POST, so a
  // PATCH or PUT is refused at the preflight and NEVER REACHES THIS SERVER — the
  // browser drops it. Every admin edit is a PATCH (products, brands, colourways,
  // inventory, price-list items, users, order lines) and shipping rates are a
  // PUT, so omitting them silently breaks every write in both browser apps while
  // curl and the test suite (which do not preflight) keep passing. Guarded by
  // test/cors.test.js.
  const allowedOrigins = [storeBaseUrl, crmBaseUrl].filter(Boolean)
  const allowedMethods = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']
  app.register(fastifyCors, {
    delegator: (request, callback) => {
      if (isAdminPanelPath(request.url)) {
        callback(null, { origin: false })
        return
      }
      const origin = request.headers.origin
      callback(null, {
        origin: origin && allowedOrigins.includes(origin) ? origin : storeBaseUrl,
        credentials: true,
        methods: allowedMethods,
      })
    },
  })

  app.register(async (api) => {
    api.register(authRoutes, { pool, mailer, storeBaseUrl, crmBaseUrl })
    api.register(catalogueRoutes, { pool })
    api.register(shippingRoutes, { pool })
    api.register(checkoutRoutes, { pool, stripe, storeBaseUrl })
    api.register(orderRoutes, { pool, mailer })
    // The storefront's sample enquiry cart (public, honeypotted, rate-limited).
    api.register(sampleRequestRoutes, { pool, mailer })
    // /account/* — the approved-trade client portal (dashboard, sample history,
    // invoice record, price lists). requireRole('trade') throughout: staff are
    // excluded exactly as they are from trade pricing.
    api.register(accountRoutes, { pool, mailer, tradePriceListsEnabled })
    // /admin/orders — called by the storefront's AdminOrders island, so it needs
    // the same CORS allowance. Unrelated to the AdminJS panel below.
    api.register(adminOrderRoutes, { pool, mailer, lineAmountTypes, xero })
    // /admin/brands|collections|products|colourways — catalogue CRUD for the
    // storefront admin islands. Same CORS allowance, same backoffice guard.
    api.register(adminCatalogueRoutes, { pool })
    // /admin/users — client/user management; /admin/inventory — stock edits;
    // /admin/price-list-items — supplier pricing. All storefront admin islands,
    // same CORS + backoffice guard.
    api.register(adminUsersRoutes, { pool, mailer, storeBaseUrl, crmBaseUrl })
    // /admin/trade-applications — read-only review of submitted trade forms
    // (the CRM's Users -> Applicants tab). Approval stays on /admin/users/:id.
    api.register(adminTradeApplicationRoutes, { pool })
    // /admin/trade-accounts — links a storefront login to its D365 customer, so
    // the portal can serve that company's invoices and cuttings. Manual by
    // design: an email match is a suggestion, never an automatic grant.
    api.register(adminTradeAccountRoutes, { pool })
    // /admin/contacts — the whole address book across companies (the per-company
    // book stays under /admin/trade-accounts/:id/contacts).
    api.register(adminContactRoutes, { pool })
    api.register(adminInventoryRoutes, { pool })
    api.register(adminPriceListRoutes, { pool })
    // /admin/price-lists/import/* — the office's own way in for a supplier price
    // list, beside `npm run import:pricing`. Its own plugin scope because it
    // registers a raw-body content-type parser (.csv AND .xlsx), which is
    // encapsulated and must not reach any other route.
    api.register(adminPriceListImportRoutes, { pool })
    // /admin/suppliers — who INVOICES Atelier, and which houses they invoice.
    // Back-office only: the record carries the freight terms, the PO address and
    // each house's discount, none of which may reach a client-facing response.
    api.register(adminSupplierRoutes, { pool })
    // /admin/product-sheet/* — the spreadsheet round trip that fills in
    // products.category. Backoffice-only; the export is a CSV download.
    api.register(adminProductSheetRoutes, { pool })
    // /admin/freight/* — the incumbent's pricing parameters, the freight-letter
    // recovery report, the append-only rate ledger and the landed-cost preview.
    // Backoffice throughout; the parameter, recovery and preview routes are
    // gated a second time on finance visibility, and the preview is the first
    // payload in the platform where masking actually deletes a column.
    api.register(adminFreightRoutes, { pool })
    // /admin/pricing/* — the platform's OWN waterfall and the parameters behind
    // it (per supplier, per house, FX by currency). Finance-gated throughout,
    // reads included: every figure is a cost input.
    api.register(adminPricingRoutes, { pool })
    // /admin/reports/* — the report library the CRM's Reporting screen reads.
    // Back-office only, masked server-side before the payload exists, and the
    // only admin routes here that opt into the rate limiter (a report is an
    // unbounded aggregate over the order ledger).
    api.register(adminReportRoutes, { pool })
    // /admin/dashboard — the CRM's landing tiles (sales MTD out of the revenue
    // scope, the open order book, inbound POs, the newest orders), one round
    // trip. Shares the reports' rate-limit posture: the MTD figure is an
    // aggregate over the same ledger.
    api.register(adminDashboardRoutes, { pool })
    // /admin/samples — the physical sample register (what is on the shelf, what
    // is out, what is late back) plus the scanner's by-barcode lookup. Back
    // office only, same CORS allowance as every other CRM screen.
    api.register(adminSampleRoutes, { pool })
    api.register(adminSampleRequestRoutes, { pool })
    // /admin/sample-loans — the cross-register outstanding read and the
    // reminders composed off it. Its own plugin because it is the one samples
    // surface that needs the mailer: a reminder is a staff action off a work
    // queue, sent on a click, never by a scheduler (there is none).
    api.register(adminSampleLoanRoutes, { pool, mailer })
    // /admin/email-templates — the staff-editable "set letter" behind those
    // reminders. A row overrides the code template; deleting it reverts.
    api.register(adminEmailTemplateRoutes, { pool })
    // /admin/purchase-orders + /admin/purchase-order-lines/:id/{allocations,receipts}
    // — the buying desk: the day's confirmed demand grouped by house, sent,
    // receipted against and closed. Back office only, and every cost figure on
    // it is finance-gated on top of that guard.
    api.register(adminPurchaseOrderRoutes, { pool, mailer })
    // /admin/supplier-invoices — one house's bill across a 2-4 week cycle, and
    // which purchase orders it covers. Back office only, every money figure on
    // it finance-gated, and the variance between the bill and what those orders
    // said they would cost is reported and never written.
    api.register(adminSupplierInvoiceRoutes, { pool })
    // /admin/reserves — reserve & cutting dockets (account-first, lines with a
    // per-line status machine) and the per-supplier report jette closes a
    // shipment against. Back office only; replaces the D365 fulmar_reserve and
    // cutting forms. Deliberately does NOT touch inventory.qty_reserved — a
    // reserve here asks a HOUSE to hold stock at their end.
    api.register(adminReserveRoutes, { pool, mailer })
    // /admin/legacy/* — read-only window on the Dynamics-365 staging tables the
    // CRM browses (real customers/orders/stock/prices). Same CORS + guard.
    // /admin/xero/* — connection lifecycle, contact/item sync, invoice push
    // (C4). The service may be null (unconfigured) — the routes say so with
    // a 503 rather than the plugin being absent and answering 404.
    api.register(adminXeroRoutes, { pool, xero, crmBaseUrl })
    api.register(adminLegacyRoutes, { pool })
    // POST /admin/legacy/import/:entity — the only write path into those same
    // tables, director-only. Its own plugin scope: it parses application/gzip
    // as a Buffer and that parser must not leak onto any other route.
    api.register(adminLegacyImportRoutes, { pool })
    // /admin/dynamics/* — the whole D365 corpus for the CRM's Archive page,
    // every table and column, read-only.
    api.register(adminDynamicsArchiveRoutes, { pool })
    // POST /contact (public) + /admin/contact-enquiries (backoffice) — the
    // storefront contact form posts here; both need the storefront CORS scope.
    api.register(contactRoutes, { pool, mailer })
    // POST /newsletter (public) — the footer sign-up, forwarded to Mailchimp.
    api.register(newsletterRoutes, { newsletter })

    api.get('/health', async (request, reply) => {
      try {
        await pool.query('SELECT 1')
        return { ok: true, db: true }
      } catch (error) {
        request.log.error({ err: error }, 'health check: database unreachable')
        reply.code(503)
        return { ok: false, db: false }
      }
    })
  })

  // Stripe calls this server-to-server; no browser origin, so no CORS.
  app.register(webhookRoutes, { pool, stripe, stripeWebhookSecret, mailer })

  // AdminJS panel at /admin. Dynamic import keeps the heavy adminjs tree out
  // of the module graph unless enabled; the wrapper scope encapsulates its
  // session/form parsers away from the JSON API.
  if (adminPanel) {
    app.register(async (instance) => {
      // The panel must never be able to take the API down. It has boot-time
      // failure modes the JSON API does not share: a missing adminjs dependency
      // (five heavy packages — a deploy that skips `npm ci` has none of them),
      // AdminJS bundling user components into `.adminjs/` in an unwritable cwd
      // under NODE_ENV=production, and @adminjs/sql's introspection, which
      // throws if ANY table in the database lacks a primary key. Unguarded,
      // each of those rejected during registration, `start()` threw, the
      // process exited, and every storefront request 502'd — a back-office CRUD
      // screen took down the shop. Log loudly and keep serving.
      try {
        const { adminPanelPlugin } = await import('./admin/panel.js')
        await adminPanelPlugin(instance, {
          pool,
          cookieSecret,
          adminSessionSecret: adminPanel.sessionSecret ?? null,
          databaseUrl: adminPanel.databaseUrl,
        })
      } catch (error) {
        instance.log.error(
          { err: error },
          'AdminJS panel failed to start — /panel is unavailable, the rest of the API is unaffected. ' +
            'Common causes: dependencies not installed (run `npm ci`), an unwritable working ' +
            'directory during component bundling (set ADMIN_JS_SKIP_BUNDLE=true), or a table with ' +
            'no primary key.'
        )
      }
    })
  }

  return app
}
