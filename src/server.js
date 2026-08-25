import Stripe from 'stripe'
import { loadConfig } from './config.js'
import { createPool } from './db.js'
import { buildApp } from './app.js'
import { createMailTransport } from './email/transport.js'
import { createMailer } from './email/mailer.js'
import { createXeroHttp } from './xero/xero-http.js'
import { createXeroService } from './xero/service.js'

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

  // Xero stays disabled (every /admin/xero route → 503) until both
  // XERO_CLIENT_ID and XERO_CLIENT_SECRET are set.
  const xero = config.xero
    ? createXeroService({
        pool,
        config: config.xero,
        http: createXeroHttp({
          clientId: config.xero.clientId,
          clientSecret: config.xero.clientSecret,
        }),
      })
    : null
  if (!xero) {
    console.warn('XERO_CLIENT_ID unset — Xero integration disabled.')
  }

  const app = buildApp({
    pool,
    cookieSecret: config.cookieSecret,
    stripe,
    xero,
    stripeWebhookSecret: config.stripeWebhookSecret,
    storeBaseUrl: config.storeBaseUrl,
    crmBaseUrl: config.crmBaseUrl,
    mailer,
    tradePriceListsEnabled: config.tradePriceListsEnabled,
    logLevel: config.logLevel,
    trustProxy: config.trustProxy,
    adminPanel: {
      databaseUrl: config.databaseUrl,
      sessionSecret: config.adminSessionSecret,
    },
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
