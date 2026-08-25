import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'

// The three unauthenticated routes that cost something to serve. /contact and
// the auth routes were limited from the start; these three were not, and each
// is reachable by anyone with the URL:
//
//   POST /checkout/session — creates a Checkout Session at STRIPE on every call
//   POST /orders/request   — writes an order and sends TWO emails
//   GET  /orders/lookup    — guesses against order_number + email
//
// Every case below sends a payload the schema rejects. That is deliberate: the
// limiter runs before validation, so the bucket still fills while nothing
// reaches Stripe, the mailer or the order table — the same trick the register
// limit test uses. It also proves the limit is not merely a side effect of the
// handler failing somewhere further in.
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

  it('429s the 31st GET /orders/lookup from one IP', async () => {
    const app = await freshApp()
    try {
      const over = await exhaust(
        app,
        () => app.inject({ method: 'GET', url: '/orders/lookup' }),
        30,
        400
      )
      expect(over.statusCode).toBe(429)
    } finally {
      await app.close()
    }
  })
})
