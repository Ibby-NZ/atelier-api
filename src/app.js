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
import { adminInventoryRoutes } from './routes/admin-inventory.js'
import { adminPriceListRoutes } from './routes/admin-price-lists.js'
import { adminLegacyRoutes } from './routes/admin-legacy.js'
import { contactRoutes } from './routes/contact.js'
import { webhookRoutes } from './routes/webhooks.js'

export const buildApp = ({
  pool,
  cookieSecret,
  stripe = null,
  stripeWebhookSecret = null,
  storeBaseUrl = 'http://localhost:4321',
  mailer = null,
  logLevel = 'info',
  logger = true,
  trustProxy = false,
  adminPanel = null,
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

  // Storefront islands fetch cross-origin (browser :4321 → api :3001) with the
  // session cookie, so allow that exact origin and credentials. Same-site across
  // ports means the SameSite=Lax session cookie still flows.
  //
  // The AdminJS panel is excluded: it is same-origin by construction, and a
  // credentialed CORS allowance would let any script on the storefront origin
  // read and drive it with a logged-in staff cookie. A delegator is required
  // because @fastify/cors hoists to the root instance (fastify-plugin), so
  // encapsulating it in a child scope would not keep it off the panel.
  app.register(fastifyCors, {
    delegator: (request, callback) => {
      if (isAdminPanelPath(request.url)) {
        callback(null, { origin: false })
        return
      }
      callback(null, { origin: storeBaseUrl, credentials: true })
    },
  })

  app.register(async (api) => {
    api.register(authRoutes, { pool })
    api.register(catalogueRoutes, { pool })
    api.register(shippingRoutes, { pool })
    api.register(checkoutRoutes, { pool, stripe, storeBaseUrl })
    api.register(orderRoutes, { pool, mailer })
    // /admin/orders — called by the storefront's AdminOrders island, so it needs
    // the same CORS allowance. Unrelated to the AdminJS panel below.
    api.register(adminOrderRoutes, { pool, mailer })
    // /admin/brands|collections|products|colourways — catalogue CRUD for the
    // storefront admin islands. Same CORS allowance, same backoffice guard.
    api.register(adminCatalogueRoutes, { pool })
    // /admin/users — client/user management; /admin/inventory — stock edits;
    // /admin/price-list-items — supplier pricing. All storefront admin islands,
    // same CORS + backoffice guard.
    api.register(adminUsersRoutes, { pool })
    api.register(adminInventoryRoutes, { pool })
    api.register(adminPriceListRoutes, { pool })
    // /admin/legacy/* — read-only window on the Dynamics-365 staging tables the
    // CRM browses (real customers/orders/stock/prices). Same CORS + guard.
    api.register(adminLegacyRoutes, { pool })
    // POST /contact (public) + /admin/contact-enquiries (backoffice) — the
    // storefront contact form posts here; both need the storefront CORS scope.
    api.register(contactRoutes, { pool, mailer })

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
