import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

describe('config', () => {
  it('throws a clear error when DATABASE_URL is unset', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is not set/)
  })
})

describe('GET /health', () => {
  let app
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    app = buildApp({ pool, logger: false })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await pool.end()
  })

  it('returns ok with a live database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, db: true })
  })
})
