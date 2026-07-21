import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import { createGuards } from './auth/guards.js'
import { authRoutes } from './routes/auth.js'
import { catalogueRoutes } from './routes/catalogue.js'
import { shippingRoutes } from './routes/shipping.js'
import { checkoutRoutes } from './routes/checkout.js'
import { orderRoutes } from './routes/orders.js'
import { webhookRoutes } from './routes/webhooks.js'

export const buildApp = ({
  pool,
  cookieSecret,
  stripe = null,
  stripeWebhookSecret = null,
  storeBaseUrl = 'http://localhost:4321',
  logLevel = 'info',
  logger = true,
} = {}) => {
  if (!pool) {
    throw new Error('buildApp requires a pg pool')
  }
  if (!cookieSecret) {
    throw new Error('buildApp requires a cookieSecret (COOKIE_SECRET env var)')
  }

  const app = Fastify({
    logger: logger ? { level: logLevel } : false,
  })

  app.register(fastifyCookie, { secret: cookieSecret })
  // global: false — only routes that opt in via config.rateLimit are limited.
  app.register(fastifyRateLimit, { global: false })

  // request.user is set by guards.requireAuth / guards.requireRole preHandlers.
  app.decorateRequest('user', null)
  app.decorate('guards', createGuards(pool))

  app.register(authRoutes, { pool })
  app.register(catalogueRoutes, { pool })
  app.register(shippingRoutes, { pool })
  app.register(checkoutRoutes, { pool, stripe, storeBaseUrl })
  app.register(orderRoutes, { pool })
  app.register(webhookRoutes, { pool, stripe, stripeWebhookSecret })

  app.get('/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1')
      return { ok: true, db: true }
    } catch (error) {
      request.log.error({ err: error }, 'health check: database unreachable')
      reply.code(503)
      return { ok: false, db: false }
    }
  })

  return app
}
