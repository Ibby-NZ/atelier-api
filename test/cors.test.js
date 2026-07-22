import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

// Regression guard: the storefront islands fetch cross-origin (browser :4321 →
// api :3001) with the session cookie. Without CORS every island call is blocked
// and the storefront silently shows empty grids / no auth state.
describe('CORS for the storefront origin', () => {
  let app
  let pool
  const storeBaseUrl = 'http://localhost:4321'

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    app = buildApp({
      pool,
      cookieSecret: 'test-cookie-secret-0123456789abcdef0123456789abcdef',
      storeBaseUrl,
      logger: false,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await pool.end()
  })

  it('allows the store origin with credentials on a catalogue GET', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/catalogue/products?limit=1',
      headers: { origin: storeBaseUrl },
    })
    expect(response.headers['access-control-allow-origin']).toBe(storeBaseUrl)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
  })

  it('answers the CORS preflight for a credentialed POST', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/orders/request',
      headers: {
        origin: storeBaseUrl,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(response.statusCode).toBeLessThan(300)
    expect(response.headers['access-control-allow-origin']).toBe(storeBaseUrl)
  })
})
