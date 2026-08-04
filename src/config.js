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

// TRUST_PROXY accepts anything Fastify's trustProxy does: 'true', a hop count,
// or an address/keyword list ('127.0.0.1', 'loopback'). Prefer the address form
// in production — 'true' trusts client-supplied X-Forwarded-For wholesale.
const parseTrustProxy = (value) => {
  if (value === undefined || value === '' || value === 'false') return false
  if (value === 'true') return true
  const hops = Number(value)
  return Number.isInteger(hops) && hops > 0 ? hops : value
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
    smtpHost: env.SMTP_HOST ?? null,
    smtpPort: Number(env.SMTP_PORT ?? DEFAULT_SMTP_PORT),
    smtpSecure: env.SMTP_SECURE === 'true',
    smtpUser: env.SMTP_USER ?? null,
    smtpPass: env.SMTP_PASS ?? null,
    emailFrom: env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
    backofficeEmail: env.BACKOFFICE_EMAIL ?? DEFAULT_BACKOFFICE_EMAIL,
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
  })
}
