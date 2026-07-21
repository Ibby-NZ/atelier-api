import 'dotenv/config'

const DEFAULT_PORT = 3001
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_LOG_LEVEL = 'info'
const DEFAULT_STORE_BASE_URL = 'http://localhost:4321'
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
    storeBaseUrl: env.STORE_BASE_URL ?? DEFAULT_STORE_BASE_URL,
    port: Number(env.PORT ?? DEFAULT_PORT),
    host: env.HOST ?? DEFAULT_HOST,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  })
}
