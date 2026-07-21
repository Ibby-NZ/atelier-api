import Stripe from 'stripe'
import { loadConfig } from './config.js'
import { createPool } from './db.js'
import { buildApp } from './app.js'

const start = async () => {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    console.error(`atelier-api failed to start: ${error.message}`)
    process.exit(1)
  }

  const pool = createPool(config.databaseUrl)
  // Card checkout stays disabled (POST /checkout/session → 503) until the key is set.
  const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null
  if (!stripe) {
    console.warn('STRIPE_SECRET_KEY unset — card checkout disabled.')
  }
  const app = buildApp({
    pool,
    cookieSecret: config.cookieSecret,
    stripe,
    stripeWebhookSecret: config.stripeWebhookSecret,
    storeBaseUrl: config.storeBaseUrl,
    logLevel: config.logLevel,
  })

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    await app.listen({ port: config.port, host: config.host })
  } catch (error) {
    app.log.error({ err: error }, 'failed to bind server')
    await pool.end()
    process.exit(1)
  }
}

start()
