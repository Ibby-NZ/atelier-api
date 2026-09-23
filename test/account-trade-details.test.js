// A trade client keeps their own application current from the portal
// (16 Sep 2026): read it back, patch the editable columns, never the consent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { memberRequest } from '../src/newsletter/mailchimp.js'
import { cleanupTradeApplications, sampleTradeApplication } from './helpers/trade-application-fixture.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'trade-details.test'
const PASSWORD = 'correct horse battery staple'
const email = (local) => `trade-details-${local}@${DOMAIN}`

const cookieOf = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

describe('GET/PATCH /account/trade-application', () => {
  let pool
  let app
  let tradeCookie
  let customerCookie

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

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
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
    await cleanupTradeApplications(pool, `%@${DOMAIN}`)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    const applied = await inject('POST', '/auth/trade-application', null, {
      email: email('studio'),
      password: PASSWORD,
      name: 'Alex Designer',
      application: sampleTradeApplication(),
    })
    expect(applied.statusCode).toBe(201)
    await pool.query(`UPDATE users SET trade_approved = true WHERE email = $1`, [email('studio')])
    const login = await inject('POST', '/auth/login', null, { email: email('studio'), password: PASSWORD })
    tradeCookie = cookieOf(login)

    const customer = await inject('POST', '/auth/register', null, {
      email: email('shopper'),
      password: PASSWORD,
      name: 'Shopper',
    })
    customerCookie = cookieOf(customer)
  })

  afterAll(async () => {
    await cleanupTradeApplications(pool, `%@${DOMAIN}`)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  it('is for approved trade accounts only', async () => {
    expect((await inject('GET', '/account/trade-application', null)).statusCode).toBe(401)
    expect((await inject('GET', '/account/trade-application', customerCookie)).statusCode).toBe(403)
  })

  it('reads the application back', async () => {
    const response = await inject('GET', '/account/trade-application', tradeCookie)
    expect(response.statusCode).toBe(200)
    expect(response.json().application.business_name).toBe('Studio Interiors Ltd')
    expect(response.json().application.signature).toBeDefined()
  })

  it('patches the editable details and answers the updated row', async () => {
    const response = await inject('PATCH', '/account/trade-application', tradeCookie, {
      delivery_address: '9 New Street, Wellington 6011',
      wants_showroom_visit: false,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().application.delivery_address).toBe('9 New Street, Wellington 6011')
    expect(response.json().application.wants_showroom_visit).toBe(false)
    const again = await inject('GET', '/account/trade-application', tradeCookie)
    expect(again.json().application.delivery_address).toBe('9 New Street, Wellington 6011')
  })

  it('refuses to blank a required field, naming it', async () => {
    const response = await inject('PATCH', '/account/trade-application', tradeCookie, { nzbn: '  ' })
    expect(response.statusCode).toBe(422)
    expect(response.json().errors.map((e) => e.field)).toContain('application.nzbn')
  })

  it('cannot touch the consent block', async () => {
    const response = await inject('PATCH', '/account/trade-application', tradeCookie, {
      signature: 'Someone Else',
    })
    // Stripped by the schema (additionalProperties: false → 400 via minProperties
    // once the unknown key is removed).
    expect(response.statusCode).toBe(400)
    const read = await inject('GET', '/account/trade-application', tradeCookie)
    expect(read.json().application.signature).not.toBe('Someone Else')
  })

  // "Send me Atelier news by email" in the portal is the same Mailchimp answer.
  // Its own app (Mailchimp config + a fake fetch) and its own client, who
  // applied with a No.
  describe('the Mailchimp opt-in', () => {
    const NEWSLETTER = { apiKey: 'abc123-us21', server: 'us21', audienceId: 'list9' }
    let newsApp
    let newsCookie
    let calls

    const patch = (body) =>
      newsApp.inject({
        method: 'PATCH',
        url: '/account/trade-application',
        headers: { cookie: newsCookie },
        payload: body,
      })

    beforeAll(async () => {
      calls = []
      newsApp = buildApp({
        pool,
        cookieSecret: TEST_COOKIE_SECRET,
        newsletter: NEWSLETTER,
        newsletterFetch: async (url, init) => {
          calls.push({ url, init })
          return { ok: true, status: 200, json: async () => ({ status: 'pending' }) }
        },
        logger: false,
      })
      await newsApp.ready()
      const applied = await newsApp.inject({
        method: 'POST',
        url: '/auth/trade-application',
        payload: {
          email: email('newsy'),
          password: PASSWORD,
          application: sampleTradeApplication({ mailchimp_opt_in: false }),
        },
      })
      expect(applied.statusCode).toBe(201)
      await pool.query(`UPDATE users SET trade_approved = true WHERE email = $1`, [email('newsy')])
      const login = await newsApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: email('newsy'), password: PASSWORD },
      })
      newsCookie = cookieOf(login)
    })

    afterAll(async () => {
      await newsApp.close()
    })

    it('a No on the form signed nobody up', () => {
      expect(calls).toHaveLength(0)
    })

    it('switching to Yes signs up the primary contact email', async () => {
      const response = await patch({ mailchimp_opt_in: true })
      expect(response.statusCode).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(memberRequest(NEWSLETTER, 'hello@studio-interiors.example.com').url)
    })

    it('re-saving the form with Yes still ticked does not call Mailchimp again', async () => {
      calls.length = 0
      const response = await patch({ mailchimp_opt_in: true, delivery_address: '1 Quiet Lane, Auckland' })
      expect(response.statusCode).toBe(200)
      expect(calls).toHaveLength(0)
    })

    it('a new primary contact email while opted in is signed up', async () => {
      calls.length = 0
      const response = await patch({ primary_contact_email: 'new-news@studio-interiors.example.com' })
      expect(response.statusCode).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(memberRequest(NEWSLETTER, 'new-news@studio-interiors.example.com').url)
    })

    it('a refused patch calls nobody', async () => {
      calls.length = 0
      const response = await patch({ mailchimp_opt_in: true, primary_contact_email: 'not-an-email' })
      expect(response.statusCode).toBe(422)
      expect(calls).toHaveLength(0)
    })
  })
})
