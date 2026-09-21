import 'dotenv/config'

const DEFAULT_PORT = 3001
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_LOG_LEVEL = 'info'
const DEFAULT_STORE_BASE_URL = 'http://localhost:4321'
// The CRM is a separate Vite app on its own port, so it is a distinct CORS
// origin from the storefront. Both must be allowed by name — see app.js.
const DEFAULT_CRM_BASE_URL = 'http://localhost:5273'
const DEFAULT_SMTP_PORT = 587
const DEFAULT_EMAIL_FROM = 'Atelier Textiles <no-reply@ateliertextiles.example>'
const DEFAULT_BACKOFFICE_EMAIL = 'orders@ateliertextiles.example'
const MIN_COOKIE_SECRET_LENGTH = 32
// Xero defaults. The scopes are the code-flow set (offline_access is what
// yields the refresh token); a custom connection ignores the scope PARAM and
// uses the scopes configured on the Xero app itself. Account 200 is Xero's
// stock "Sales" revenue account; NZ trade invoices are conventionally quoted
// GST-exclusive, hence Exclusive.
const DEFAULT_XERO_SCOPES =
  'openid profile email offline_access accounting.transactions accounting.contacts accounting.settings'
const DEFAULT_XERO_SALES_ACCOUNT_CODE = '200'
const DEFAULT_XERO_LINE_AMOUNT_TYPES = 'Exclusive'
const DEFAULT_XERO_INVOICE_STATUS = 'AUTHORISED'
const DEFAULT_XERO_INVOICE_DUE_DAYS = 30
// Xero's stock "Purchases" expense account. A bill is DRAFT by default: a
// purchase order is what we ORDERED, and the accountant approves the bill
// once the house's own invoice arrives.
const DEFAULT_XERO_PURCHASES_ACCOUNT_CODE = '300'
const DEFAULT_XERO_BILL_STATUS = 'DRAFT'
const XERO_GRANT_TYPES = ['authorization_code', 'client_credentials']
const XERO_LINE_AMOUNT_TYPES = ['Exclusive', 'Inclusive', 'NoTax']
const XERO_INVOICE_STATUSES = ['DRAFT', 'AUTHORISED']

// TRUST_PROXY accepts anything Fastify's trustProxy does: 'true', a hop count,
// or an address/keyword list ('127.0.0.1', 'loopback'). Prefer the address form
// in production — 'true' trusts client-supplied X-Forwarded-For wholesale.
const parseTrustProxy = (value) => {
  if (value === undefined || value === '' || value === 'false') return false
  if (value === 'true') return true
  const hops = Number(value)
  return Number.isInteger(hops) && hops > 0 ? hops : value
}

// Xero (C4). null unless BOTH id and secret are set — the integration is
// disabled whole, never half-configured. Validation throws here, at boot,
// because a bad enum value would otherwise surface as a Xero 400 on the
// first invoice push, days later and on somebody else's screen.
const parseXero = (env, port) => {
  const clientId = env.XERO_CLIENT_ID
  const clientSecret = env.XERO_CLIENT_SECRET
  if (!clientId && !clientSecret) return null
  if (!clientId || !clientSecret) {
    throw new Error('Set both XERO_CLIENT_ID and XERO_CLIENT_SECRET, or neither.')
  }
  const grantType = env.XERO_GRANT_TYPE ?? 'authorization_code'
  if (!XERO_GRANT_TYPES.includes(grantType)) {
    throw new Error(`XERO_GRANT_TYPE must be one of: ${XERO_GRANT_TYPES.join(', ')}.`)
  }
  const lineAmountTypes = env.XERO_LINE_AMOUNT_TYPES ?? DEFAULT_XERO_LINE_AMOUNT_TYPES
  if (!XERO_LINE_AMOUNT_TYPES.includes(lineAmountTypes)) {
    throw new Error(`XERO_LINE_AMOUNT_TYPES must be one of: ${XERO_LINE_AMOUNT_TYPES.join(', ')}.`)
  }
  const invoiceStatus = env.XERO_INVOICE_STATUS ?? DEFAULT_XERO_INVOICE_STATUS
  if (!XERO_INVOICE_STATUSES.includes(invoiceStatus)) {
    throw new Error(`XERO_INVOICE_STATUS must be one of: ${XERO_INVOICE_STATUSES.join(', ')}.`)
  }
  const invoiceDueDays = Number(env.XERO_INVOICE_DUE_DAYS ?? DEFAULT_XERO_INVOICE_DUE_DAYS)
  if (!Number.isInteger(invoiceDueDays) || invoiceDueDays < 0) {
    throw new Error('XERO_INVOICE_DUE_DAYS must be a non-negative integer.')
  }
  const billStatus = env.XERO_BILL_STATUS ?? DEFAULT_XERO_BILL_STATUS
  if (!XERO_INVOICE_STATUSES.includes(billStatus)) {
    throw new Error(`XERO_BILL_STATUS must be one of: ${XERO_INVOICE_STATUSES.join(', ')}.`)
  }
  const pullIntervalMinutes = Number(env.XERO_PULL_INTERVAL_MINUTES ?? 0)
  if (!Number.isInteger(pullIntervalMinutes) || pullIntervalMinutes < 0) {
    throw new Error('XERO_PULL_INTERVAL_MINUTES must be a non-negative integer.')
  }
  return Object.freeze({
    clientId,
    clientSecret,
    grantType,
    // Must match a redirect URI registered on the Xero app EXACTLY. The
    // default only fits local dev; production sets the public API origin.
    redirectUri: env.XERO_REDIRECT_URI ?? `http://localhost:${port}/admin/xero/callback`,
    scopes: env.XERO_SCOPES ?? DEFAULT_XERO_SCOPES,
    salesAccountCode: env.XERO_SALES_ACCOUNT_CODE ?? DEFAULT_XERO_SALES_ACCOUNT_CODE,
    lineAmountTypes,
    invoiceStatus,
    invoiceDueDays,
    // The Xero BANK account a payment is recorded against when an order is
    // marked paid (a Payment needs an account; the sales account above is
    // revenue and cannot take one). Unset = invoices are pushed but never
    // marked paid from here; the mark-paid route says so in its answer.
    paymentAccountCode: env.XERO_PAYMENT_ACCOUNT_CODE ?? null,
    // The expense account a purchase order's bill posts to, and the status
    // it lands in (DRAFT until the house's invoice arrives, by default).
    purchasesAccountCode: env.XERO_PURCHASES_ACCOUNT_CODE ?? DEFAULT_XERO_PURCHASES_ACCOUNT_CODE,
    billStatus,
    // Xero → platform pull cadence (contacts, invoice + bill statuses).
    // 0 = manual only, from the CRM's Xero screen.
    pullIntervalMinutes,
  })
}

export const loadConfig = (env = process.env) => {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy atelier-api/.env.example to atelier-api/.env and set it.'
    )
  }

  const cookieSecret = env.COOKIE_SECRET
  if (!cookieSecret) {
    throw new Error(
      'COOKIE_SECRET is not set. Generate one with `openssl rand -hex 32` and add it to atelier-api/.env.'
    )
  }
  if (cookieSecret.length < MIN_COOKIE_SECRET_LENGTH) {
    throw new Error(
      `COOKIE_SECRET must be at least ${MIN_COOKIE_SECRET_LENGTH} characters. Generate one with \`openssl rand -hex 32\`.`
    )
  }

  // With SMTP configured the mail is REAL, and Postmark refuses a From it has
  // not verified (sender signature / domain): the placeholder defaults would
  // turn every letter into a 4xx at the relay, or every alert into a bounce.
  // Fail at boot instead of on the first order.
  const smtpHost = env.SMTP_HOST ?? null
  if (smtpHost && !(env.EMAIL_FROM && env.BACKOFFICE_EMAIL)) {
    throw new Error(
      'SMTP_HOST is set but EMAIL_FROM and/or BACKOFFICE_EMAIL are not. Set both to real addresses on the verified sending domain (see .env.example).'
    )
  }

  const adminSessionSecret = env.ADMIN_SESSION_SECRET ?? null
  if (adminSessionSecret && adminSessionSecret.length < MIN_COOKIE_SECRET_LENGTH) {
    throw new Error(
      `ADMIN_SESSION_SECRET must be at least ${MIN_COOKIE_SECRET_LENGTH} characters. Generate one with \`openssl rand -hex 32\`.`
    )
  }

  return Object.freeze({
    databaseUrl,
    cookieSecret,
    // Optional: signs the AdminJS panel session. Unset, a distinct key is
    // derived from COOKIE_SECRET so the panel and the customer session cookie
    // never share a signing key. Set it to rotate the panel on its own.
    adminSessionSecret,
    // Optional: card checkout is disabled until STRIPE_SECRET_KEY is set. The
    // secret comes from the environment only — never a literal in the repo.
    stripeSecretKey: env.STRIPE_SECRET_KEY ?? null,
    // Optional: the Stripe webhook returns 503 until this is set. Used to verify
    // the signature on POST /webhooks/stripe; from the environment only.
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    storeBaseUrl: env.STORE_BASE_URL ?? DEFAULT_STORE_BASE_URL,
    // The back-office CRM origin. It is a second browser app calling the same
    // API with the session cookie, so it needs its own CORS allowance; without
    // it every CRM screen is blocked and the CRM cannot even sign in.
    crmBaseUrl: env.CRM_BASE_URL ?? DEFAULT_CRM_BASE_URL,
    // Email (US-015). With no SMTP_HOST the transport captures mail instead of
    // sending it (dev/test). from/backoffice have sensible non-secret defaults.
    smtpHost,
    smtpPort: Number(env.SMTP_PORT ?? DEFAULT_SMTP_PORT),
    smtpSecure: env.SMTP_SECURE === 'true',
    smtpUser: env.SMTP_USER ?? null,
    smtpPass: env.SMTP_PASS ?? null,
    emailFrom: env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
    backofficeEmail: env.BACKOFFICE_EMAIL ?? DEFAULT_BACKOFFICE_EMAIL,

    // Newsletter (Mailchimp). null until all three are set; POST /newsletter
    // answers 503 meanwhile. MAILCHIMP_SERVER is the key's `-usNN` suffix.
    newsletter:
      env.MAILCHIMP_API_KEY && env.MAILCHIMP_SERVER && env.MAILCHIMP_AUDIENCE_ID
        ? {
            apiKey: env.MAILCHIMP_API_KEY,
            server: env.MAILCHIMP_SERVER,
            audienceId: env.MAILCHIMP_AUDIENCE_ID,
          }
        : null,
    port: Number(env.PORT ?? DEFAULT_PORT),
    host: env.HOST ?? DEFAULT_HOST,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    // Client-facing per-house trade price lists (GET /account/price-lists).
    // OFF by default and that is a deliberate business gate, not a rollout
    // convenience: `products.trade_price_cents` is still seeded from the demo
    // pricing snapshot (8 of 12 fabrics share one placeholder figure, finished
    // goods have none), and a downloadable price list is a document a designer
    // quotes a job from. Turn it on when the numbers are real.
    tradePriceListsEnabled: env.TRADE_PRICE_LISTS_ENABLED === 'true',
    // Behind a reverse proxy request.ip is the proxy, so the per-IP login rate
    // limit collapses to one shared bucket. Set TRUST_PROXY (e.g. '127.0.0.1'
    // for same-host nginx) so Fastify reads the real client from X-Forwarded-For.
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // Xero (C4): null disables the integration (routes answer 503).
    xero: parseXero(env, Number(env.PORT ?? DEFAULT_PORT)),
  })
}
