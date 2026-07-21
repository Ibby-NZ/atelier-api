import Stripe from 'stripe'
import { loadConfig } from './config.js'
import { createPool } from './db.js'
import { buildApp } from './app.js'
import { createMailTransport } from './email/transport.js'
import { createMailer } from './email/mailer.js'

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
  // Email: real SMTP when SMTP_HOST is set, otherwise a capturing jsonTransport.
  const mailer = createMailer({
    transport: createMailTransport(config),
    from: config.emailFrom,
    backofficeEmail: config.backofficeEmail,
  })

  const app = buildApp({
    pool,
    cookieSecret: config.cookieSecret,
    stripe,
    stripeWebhookSecret: config.stripeWebhookSecret,
    storeBaseUrl: config.storeBaseUrl,
    mailer,
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
