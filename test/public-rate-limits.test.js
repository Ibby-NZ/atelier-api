import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'

// The unauthenticated routes that cost something to serve. /contact and the
// auth routes were limited from the start; these were not, and each is
// reachable by anyone with the URL:
//
//   POST /checkout/session    — creates a Checkout Session at STRIPE on every call
//   POST /orders/request      — writes an order and sends TWO emails
//   GET  /checkout/session/:id — retrieves the session from STRIPE on every call
//   GET/POST /orders/quote/:token[/accept|/reject] — a query per call; answers mail the office
//
// Every case below sends something that dies short of the third party — a
// payload the schema rejects, or (for the GET by id, which has no rejectable
// id) a request to an app with no stripe. That is deliberate: the limiter runs
// before validation, so the bucket still fills while nothing reaches Stripe,
// the mailer or the order table — the same trick the register limit test uses.
// It also proves the limit is not merely a side effect of the handler failing
// somewhere further in.
const exhaust = async (app, attempt, max, expectedStatus) => {
  for (let i = 0; i < max; i += 1) {
    const response = await attempt()
    expect(response.statusCode).toBe(expectedStatus)
  }
  return attempt()
}

describe('rate limits on the public, costly routes', () => {
  let pool

  beforeAll(() => {
    pool = createPool(loadConfig().databaseUrl)
  })

  afterAll(async () => {
    await pool.end()
  })

  // A fresh instance per case: the limiter store is per app AND per route, so
  // sharing one would let these three spend each other's buckets.
  const freshApp = async () => {
    const app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
    return app
  }

  it('429s the 21st POST /checkout/session from one IP', async () => {
    const app = await freshApp()
    try {
      const over = await exhaust(
        app,
        () => app.inject({ method: 'POST', url: '/checkout/session', payload: {} }),
        20,
        400
      )
      expect(over.statusCode).toBe(429)
    } finally {
      await app.close()
    }
  })

  it('429s the 11th POST /orders/request from one IP', async () => {
    const app = await freshApp()
    try {
      const over = await exhaust(
        app,
        () => app.inject({ method: 'POST', url: '/orders/request', payload: {} }),
        10,
        400
      )
      expect(over.statusCode).toBe(429)
    } finally {
      await app.close()
    }
  })

  // The quote link's routes (24 Sep 2026): public, every call a query, and an
  // answer sends mail. A token that matches nothing 404s before any write or
  // letter, and the limiter still counts it.
  it('429s the 11th GET or answer on /orders/quote/:token from one IP', async () => {
    for (const [method, url] of [
      ['GET', '/orders/quote/no-such-token'],
      ['POST', '/orders/quote/no-such-token/accept'],
      ['POST', '/orders/quote/no-such-token/reject'],
    ]) {
      const app = await freshApp()
      try {
        const over = await exhaust(app, () => app.inject({ method, url, payload: {} }), 10, 404)
        expect(over.statusCode).toBe(429)
      } finally {
        await app.close()
      }
    }
  })

  // No schema-rejectable id exists here (find-my-way caps a param at 100 chars
  // and answers 414 before any hook runs), so this case leans on the other end
  // instead: `freshApp` injects no stripe, so the handler throws 503 before it
  // could retrieve anything. The limiter still counts every call. 120 is eight
  // success-page polls; the 121st is not a buyer.
  it('429s the 121st GET /checkout/session/:id from one IP', async () => {
    const app = await freshApp()
    try {
      const over = await exhaust(
        app,
        () => app.inject({ method: 'GET', url: '/checkout/session/cs_test_rate_limit' }),
        120,
        503
      )
      expect(over.statusCode).toBe(429)
    } finally {
      await app.close()
    }
  })
})
