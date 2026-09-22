import pg from 'pg'

// Vultr and other managed Postgres hosts refuse unencrypted connections.
// Local dev (localhost) connects without SSL; everything else gets it.
export const PG_SSL = Object.freeze({ rejectUnauthorized: false })

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export const databaseRequiresSsl = (databaseUrl) => {
  try {
    const { hostname } = new URL(databaseUrl)
    return !LOCAL_HOSTS.has(hostname)
  } catch {
    return true
  }
}

export const pgConnectionConfig = (databaseUrl) => {
  if (!databaseUrl) {
    throw new Error('pgConnectionConfig requires a database URL')
  }
  const config = { connectionString: databaseUrl }
  if (databaseRequiresSsl(databaseUrl)) {
    config.ssl = PG_SSL
  }
  return Object.freeze(config)
}

export const createPool = (databaseUrl) => new pg.Pool(pgConnectionConfig(databaseUrl))
