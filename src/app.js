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
      const { adminPanelPlugin } = await import('./admin/panel.js')
      await adminPanelPlugin(instance, {
        pool,
        cookieSecret,
        adminSessionSecret: adminPanel.sessionSecret ?? null,
        databaseUrl: adminPanel.databaseUrl,
      })
    })
  }

  return app
}
