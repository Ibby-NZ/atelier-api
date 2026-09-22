import pg from 'pg'

export const createPool = (databaseUrl) => {
  if (!databaseUrl) {
    throw new Error('createPool requires a database URL')
  }
  return new pg.Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } })
}
