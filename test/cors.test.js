import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

// Regression guard: TWO browser apps fetch this API cross-origin with the session
// cookie — the storefront islands (:4321 → api :3001) and the back-office CRM
// (:5273 → api :3001). Without CORS for an origin the browser blocks every
// response: the storefront silently shows empty grids, and the CRM cannot even
// sign in. The allowance is an exact-match allowlist, never a reflection of
// whatever asked, because `credentials: true` plus a reflected origin would let
// any site drive the API with a logged-in staff cookie.
describe('CORS for the storefront and CRM origins', () => {
  let app
  let pool
  const storeBaseUrl = 'http://localhost:4321'
  const crmBaseUrl = 'http://localhost:5273'

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    app = buildApp({
      pool,
      cookieSecret: 'test-cookie-secret-0123456789abcdef0123456789abcdef',
      storeBaseUrl,
      crmBaseUrl,
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

  // The CRM signs in against this API and drives every /admin/* screen from it.
  it('allows the CRM origin with credentials on the session probe', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { origin: crmBaseUrl },
    })
    expect(response.headers['access-control-allow-origin']).toBe(crmBaseUrl)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
  })

  it('answers the CRM preflight for a credentialed admin write', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/admin/products',
      headers: {
        origin: crmBaseUrl,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(response.statusCode).toBeLessThan(300)
    expect(response.headers['access-control-allow-origin']).toBe(crmBaseUrl)
    expect(response.headers['access-control-allow-credentials']).toBe('true')
  })

  // Regression guard for a confirmed break: @fastify/cors defaults `methods` to
  // GET,HEAD,POST, so a PATCH/PUT preflight is refused and the browser never
  // sends the request. Every admin edit is a PATCH and shipping rates are a PUT,
  // so the default silently broke every write in both browser apps — while curl
  // and app.inject (neither of which preflights) kept passing.
  it('allows the write methods the admin screens actually use', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/admin/inventory/1',
        headers: {
          origin: crmBaseUrl,
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type',
        },
      })
      expect(response.statusCode).toBeLessThan(300)
      expect(response.headers['access-control-allow-methods']).toContain(method)
    }
  })

  it('still allows the read and create methods', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/admin/products',
      headers: {
        origin: crmBaseUrl,
        'access-control-request-method': 'POST',
      },
    })
    const allowed = response.headers['access-control-allow-methods']
    for (const method of ['GET', 'HEAD', 'POST']) {
      expect(allowed).toContain(method)
    }
  })

  // The allowlist must be closed: an unknown origin never gets its own name
  // echoed back, so the browser refuses the credentialed response.
  it('does not echo an origin that is not allow-listed', async () => {
    for (const origin of ['http://evil.example', 'http://localhost:9999']) {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { origin },
      })
      expect(response.headers['access-control-allow-origin']).not.toBe(origin)
    }
  })

  // The panel is same-origin by construction; a credentialed allowance would let
  // a script on either app's origin read and drive it with a staff cookie.
  it('never allows either app origin on the admin panel', async () => {
    for (const origin of [storeBaseUrl, crmBaseUrl]) {
      const response = await app.inject({
        method: 'GET',
        url: '/panel/login',
        headers: { origin },
      })
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    }
  })
})
