import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'admin-panel-test.example.com'
const PASSWORD = 'correct horse battery staple'
const STAFF_EMAIL = `staff@${DOMAIN}`
const CUSTOMER_EMAIL = `customer@${DOMAIN}`

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

const loginForm = (email, password) =>
  new URLSearchParams({ email, password }).toString()

const adminSessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie].filter(Boolean)
  const header = headers.find((value) => value.startsWith('adminjs_session='))
  return header ? header.split(';')[0] : null
}

let pool
let app

beforeAll(async () => {
  const config = loadConfig()
  pool = createPool(config.databaseUrl)
  await runner({
    databaseUrl: config.databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

  app = buildApp({
    pool,
    cookieSecret: TEST_COOKIE_SECRET,
    logger: false,
    adminPanel: { databaseUrl: config.databaseUrl },
  })
  await app.ready()

  // Registered once here — register shares the 10 / 15 min rate-limit bucket.
  for (const email of [STAFF_EMAIL, CUSTOMER_EMAIL]) {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: PASSWORD },
    })
    expect(response.statusCode).toBe(201)
  }
  await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
    STAFF_EMAIL,
  ])
}, 120_000)

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
  await app.close()
  await pool.end()
})

const postLogin = (email, password) =>
  app.inject({
    method: 'POST',
    url: '/panel/login',
    headers: { 'content-type': FORM_CONTENT_TYPE },
    payload: loginForm(email, password),
  })

describe('admin panel', () => {
  it('redirects unauthenticated /panel to the login page', async () => {
    const response = await app.inject({ method: 'GET', url: '/panel' })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/panel/login')
  })

  it('serves the login page', async () => {
    const response = await app.inject({ method: 'GET', url: '/panel/login' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
  })

  it('rejects wrong passwords — the session stays unauthenticated', async () => {
    const response = await postLogin(STAFF_EMAIL, 'not-the-password')
    expect(response.statusCode).toBe(200)

    const cookie = adminSessionCookieFrom(response)
    const followUp = await app.inject({
      method: 'GET',
      url: '/panel',
      headers: cookie ? { cookie } : {},
    })
    expect(followUp.statusCode).toBe(302)
    expect(followUp.headers.location).toBe('/panel/login')
  })

  it('rejects customers — staff roles only', async () => {
    const response = await postLogin(CUSTOMER_EMAIL, PASSWORD)
    expect(response.statusCode).toBe(200)

    const cookie = adminSessionCookieFrom(response)
    const followUp = await app.inject({
      method: 'GET',
      url: '/panel',
      headers: cookie ? { cookie } : {},
    })
    expect(followUp.statusCode).toBe(302)
  })

  it('logs backoffice staff in and serves the dashboard', async () => {
    const response = await postLogin(STAFF_EMAIL, PASSWORD)
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/panel')

    const cookie = adminSessionCookieFrom(response)
    expect(cookie).toBeTruthy()

    const dashboard = await app.inject({
      method: 'GET',
      url: '/panel',
      headers: { cookie },
    })
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.headers['content-type']).toContain('text/html')
  })

  it('logout destroys the session', async () => {
    const login = await postLogin(STAFF_EMAIL, PASSWORD)
    const cookie = adminSessionCookieFrom(login)

    const logout = await app.inject({
      method: 'GET',
      url: '/panel/logout',
      headers: { cookie },
    })
    expect(logout.statusCode).toBe(302)
    expect(logout.headers.location).toBe('/panel/login')

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/panel',
      headers: { cookie },
    })
    expect(afterLogout.statusCode).toBe(302)
  })

  it('leaves the main API untouched — health and cookie login still work', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)

    const apiLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: STAFF_EMAIL, password: PASSWORD },
    })
    expect(apiLogin.statusCode).toBe(200)
    const setCookie = apiLogin.headers['set-cookie']
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie]
    expect(headers.some((value) => value.startsWith('atelier_session='))).toBe(true)
  })

  // One shared staff session for the security cases below: /panel/login shares a
  // 10 / 15 min rate-limit bucket with the login cases above.
  let staffCookie

  const authenticated = async () => {
    if (!staffCookie) {
      staffCookie = adminSessionCookieFrom(await postLogin(STAFF_EMAIL, PASSWORD))
    }
    return staffCookie
  }

  // The guard used to test asset paths with request.url.match(assetPath), an
  // unanchored regex over path+query — so any panel URL carrying an asset path
  // in its query string skipped authentication entirely.
  it.each([
    '/panel/api/resources/users/actions/list?x=/frontend/assets/icomoon.css',
    '/panel/api/resources/orders/actions/list?x=/frontend/assets/app.bundle.js',
    '/panel/resources/users?x=/frontend/assets/components.bundle.js',
  ])('does not let a query-string asset path bypass the guard: %s', async (url) => {
    const response = await app.inject({ method: 'GET', url })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/panel/login')
  })

  it('does not let a query-string asset path bypass the guard on writes', async () => {
    const { rows } = await pool.query('SELECT id, role FROM users WHERE email = $1', [
      CUSTOMER_EMAIL,
    ])
    const target = rows[0]

    const response = await app.inject({
      method: 'POST',
      url: `/panel/api/resources/users/records/${target.id}/edit?x=/frontend/assets/icomoon.css`,
      headers: { 'content-type': FORM_CONTENT_TYPE },
      payload: new URLSearchParams({ role: 'director' }).toString(),
    })
    expect(response.statusCode).toBe(302)

    const { rows: after } = await pool.query('SELECT role FROM users WHERE id = $1', [
      target.id,
    ])
    expect(after[0].role).toBe('customer')
  })

  it('still serves real static assets without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/panel/frontend/assets/global.bundle.js',
    })
    expect(response.statusCode).toBe(200)
  })

  it('regenerates the session id on login (no session fixation)', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/panel/login' })
    const preLoginCookie = adminSessionCookieFrom(anonymous)
    expect(preLoginCookie).toBeTruthy()

    const login = await app.inject({
      method: 'POST',
      url: '/panel/login',
      headers: { 'content-type': FORM_CONTENT_TYPE, cookie: preLoginCookie },
      payload: loginForm(STAFF_EMAIL, PASSWORD),
    })
    expect(login.statusCode).toBe(302)

    const postLoginCookie = adminSessionCookieFrom(login)
    expect(postLoginCookie).toBeTruthy()
    expect(postLoginCookie).not.toBe(preLoginCookie)

    // The pre-auth id must not have been upgraded to an authenticated session.
    const replay = await app.inject({
      method: 'GET',
      url: '/panel',
      headers: { cookie: preLoginCookie },
    })
    expect(replay.statusCode).toBe(302)
  })

  it('never sends password_hash to the panel', async () => {
    const cookie = await authenticated()
    const response = await app.inject({
      method: 'GET',
      url: '/panel/api/resources/users/actions/list',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('password_hash')
    expect(response.body).not.toContain('$argon2')
    // Still a working list, not an empty one.
    expect(response.body).toContain(STAFF_EMAIL)
  })

  it('does not extend the storefront CORS allowance to the panel', async () => {
    const panel = await app.inject({
      method: 'GET',
      url: '/panel/login',
      headers: { origin: 'http://localhost:4321' },
    })
    expect(panel.headers['access-control-allow-origin']).toBeUndefined()

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/panel/api/resources/users/actions/list',
      headers: {
        origin: 'http://localhost:4321',
        'access-control-request-method': 'GET',
      },
    })
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined()

    // The storefront API keeps its CORS allowance — including /admin/orders,
    // which the storefront's AdminOrders island calls.
    const catalogue = await app.inject({
      method: 'GET',
      url: '/catalogue/products?limit=1',
      headers: { origin: 'http://localhost:4321' },
    })
    expect(catalogue.headers['access-control-allow-origin']).toBe('http://localhost:4321')

    const adminOrders = await app.inject({
      method: 'GET',
      url: '/admin/orders',
      headers: { origin: 'http://localhost:4321' },
    })
    expect(adminOrders.headers['access-control-allow-origin']).toBe('http://localhost:4321')
  })

  it('rejects panel writes carrying a foreign Origin', async () => {
    const cookie = await authenticated()
    const response = await app.inject({
      method: 'POST',
      url: '/panel/api/resources/products/actions/new',
      headers: {
        cookie,
        origin: 'https://evil.example.com',
        'content-type': FORM_CONTENT_TYPE,
      },
      payload: new URLSearchParams({ name: 'csrf' }).toString(),
    })
    expect(response.statusCode).toBe(403)
  })

  // The other side of the origin guard: tightening it must not lock staff out
  // of their own panel. A real browser sends Origin + Sec-Fetch-Site on the
  // panel's own writes, and those have to pass.
  it('allows a same-origin panel write', async () => {
    const cookie = await authenticated()
    const response = await app.inject({
      method: 'POST',
      url: '/panel/api/resources/brands/actions/new',
      headers: {
        cookie,
        origin: 'http://localhost:80',
        'sec-fetch-site': 'same-origin',
        'content-type': FORM_CONTENT_TYPE,
      },
      payload: new URLSearchParams({
        name: 'Origin Guard Fixture',
        slug: `${DOMAIN}-origin-guard`,
        country: 'New Zealand',
        currency: 'NZD',
      }).toString(),
    })
    expect(response.statusCode).not.toBe(403)

    const { rows } = await pool.query('SELECT name FROM brands WHERE slug = $1', [
      `${DOMAIN}-origin-guard`,
    ])
    expect(rows).toHaveLength(1)
    await pool.query('DELETE FROM brands WHERE slug = $1', [`${DOMAIN}-origin-guard`])
  })

  it('rejects a cross-site logout navigation', async () => {
    const cookie = await authenticated()
    const response = await app.inject({
      method: 'GET',
      url: '/panel/logout',
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    })
    expect(response.statusCode).toBe(403)

    // The session survived the attempted forced logout.
    const dashboard = await app.inject({
      method: 'GET',
      url: '/panel',
      headers: { cookie },
    })
    expect(dashboard.statusCode).toBe(200)
  })

  it('does not accept an API session cookie as a panel session', async () => {
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
      STAFF_EMAIL,
    ])
    const apiLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: STAFF_EMAIL, password: PASSWORD },
    })
    const setCookie = apiLogin.headers['set-cookie']
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie]
    const apiCookie = headers
      .find((value) => value.startsWith('atelier_session='))
      .split(';')[0]
    expect(apiCookie).toContain(String(rows[0].id))

    // Same value, presented under the panel's cookie name: the panel signs with
    // a separate key, so this must not resolve to an authenticated session.
    const forged = `adminjs_session=${apiCookie.split('=').slice(1).join('=')}`
    const response = await app.inject({
      method: 'GET',
      url: '/panel',
      headers: { cookie: forged },
    })
    expect(response.statusCode).toBe(302)
  })

  it('does not mount the panel when the option is off', async () => {
    const bare = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await bare.ready()
    try {
      const response = await bare.inject({ method: 'GET', url: '/panel' })
      expect(response.statusCode).toBe(404)
    } finally {
      await bare.close()
    }
  })

  // A back-office CRUD screen must never be able to take the shop down. The
  // panel has boot-time failure modes the JSON API does not share (missing
  // adminjs dependencies, an unwritable cwd during component bundling, a table
  // with no primary key); unguarded, each one exited the process and every
  // storefront request 502'd.
  it('still serves the API when the panel fails to start', async () => {
    const broken = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      logger: false,
      // A database URL @adminjs/sql cannot introspect: registration throws.
      adminPanel: {
        databaseUrl: 'postgresql://nobody:nobody@127.0.0.1:1/does-not-exist',
        sessionSecret: null,
      },
    })
    await broken.ready()
    try {
      const health = await broken.inject({ method: 'GET', url: '/health' })
      expect(health.statusCode).toBe(200)

      const catalogue = await broken.inject({ method: 'GET', url: '/catalogue/brands' })
      expect(catalogue.statusCode).toBe(200)

      // The panel itself is simply absent, not half-mounted.
      const panel = await broken.inject({ method: 'GET', url: '/panel' })
      expect(panel.statusCode).toBe(404)
    } finally {
      await broken.close()
    }
  })
})
