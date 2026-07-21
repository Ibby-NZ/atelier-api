import 'dotenv/config'

const DEFAULT_PORT = 3001
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_LOG_LEVEL = 'info'

export const loadConfig = (env = process.env) => {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy atelier-api/.env.example to atelier-api/.env and set it.'
    )
  }

  return Object.freeze({
    databaseUrl,
    port: Number(env.PORT ?? DEFAULT_PORT),
    host: env.HOST ?? DEFAULT_HOST,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  })
}
