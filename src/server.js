import Stripe from 'stripe'
import { loadConfig } from './config.js'
import { createPool } from './db.js'
import { buildApp } from './app.js'
import { createMailTransport } from './email/transport.js'
import { createMailer } from './email/mailer.js'
import { createXeroHttp } from './xero/xero-http.js'
import { createXeroService } from './xero/service.js'
import { notifyOrderTransition } from './email/notifications.js'

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
  // Email: real SMTP when SMTP_HOST is set, otherwise a capture transport that
  // prints each letter to this console and delivers nothing (mailer.delivers
  // false; the password reset routes answer 503).
  const mailer = createMailer({
    transport: createMailTransport(config),
    from: config.emailFrom,
    backofficeEmail: config.backofficeEmail,
    redirectTo: config.emailRedirectTo,
    log: { info: () => {}, error: (details, message) => console.error(message, details) },
  })
  if (config.emailRedirectTo) {
    console.warn(
      `EMAIL_REDIRECT_TO is set — EVERY letter, including purchase orders and ` +
        `reserve requests addressed to SUPPLIERS, is delivered to ` +
        `${config.emailRedirectTo} and to nobody else. Unset it to go live.`
    )
  }

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
        // An invoice paid at the accountant's desk marks its order paid here
        // — with the same letter the CRM's Mark paid button sends.
        notifyOrderTransition: (order) => notifyOrderTransition(mailer, pool, order),
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
    newsletter: config.newsletter,
    tradePriceListsEnabled: config.tradePriceListsEnabled,
    logLevel: config.logLevel,
    trustProxy: config.trustProxy,
    lineAmountTypes: config.lineAmountTypes,
    adminPanel: {
      databaseUrl: config.databaseUrl,
      sessionSecret: config.adminSessionSecret,
    },
  })

  // The scheduled Xero → platform pull. Off (0) means the CRM's Pull buttons
  // are the only trigger; a failure is logged and the next tick tries again,
  // because a pull that throws must never take the API down with it.
  const pullEvery = xero ? config.xero.pullIntervalMinutes : 0
  const pullTimer = pullEvery
    ? setInterval(() => {
        xero
          .pullAll()
          .then((result) => app.log.info({ result }, 'xero pull'))
          .catch((err) => app.log.error({ err }, 'xero pull failed'))
      }, pullEvery * 60_000)
    : null
  pullTimer?.unref()

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down')
    if (pullTimer) clearInterval(pullTimer)
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
