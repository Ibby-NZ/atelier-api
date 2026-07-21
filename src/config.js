import 'dotenv/config'

const DEFAULT_PORT = 3001
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_LOG_LEVEL = 'info'
const DEFAULT_STORE_BASE_URL = 'http://localhost:4321'
const DEFAULT_SMTP_PORT = 587
const DEFAULT_EMAIL_FROM = 'Atelier Textiles <no-reply@ateliertextiles.example>'
const DEFAULT_BACKOFFICE_EMAIL = 'orders@ateliertextiles.example'
const MIN_COOKIE_SECRET_LENGTH = 32

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

  return Object.freeze({
    databaseUrl,
    cookieSecret,
    // Optional: card checkout is disabled until STRIPE_SECRET_KEY is set. The
    // secret comes from the environment only — never a literal in the repo.
    stripeSecretKey: env.STRIPE_SECRET_KEY ?? null,
    // Optional: the Stripe webhook returns 503 until this is set. Used to verify
    // the signature on POST /webhooks/stripe; from the environment only.
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    storeBaseUrl: env.STORE_BASE_URL ?? DEFAULT_STORE_BASE_URL,
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
  })
}
