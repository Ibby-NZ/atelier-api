import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { validateTradeApplication } from '../src/users/trade-applications.js'
import { sampleTradeApplication } from './helpers/trade-application-fixture.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const TEST_DOMAIN = 'trade-app-test.example.com'
const testEmail = (local) => `${local}@${TEST_DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Applications first: deleting the user would SET NULL user_id, orphaning them.
const cleanup = async (pool) => {
  await pool.query(
    `DELETE FROM trade_applications
      WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`%@${TEST_DOMAIN}`]
  )
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${TEST_DOMAIN}`])
}

describe('validateTradeApplication', () => {
  it('accepts the complete sample form', () => {
    expect(validateTradeApplication(sampleTradeApplication())).toEqual([])
  })

  it('treats a blank required field the same as a missing one', () => {
    const errors = validateTradeApplication(
      sampleTradeApplication({ business_name: '   ' })
    )
    expect(errors).toContainEqual({
      field: 'application.business_name',
      message: expect.any(String),
    })
  })

  it('allows the optional registered name to be absent', () => {
    const application = sampleTradeApplication()
    delete application.registered_name
    expect(validateTradeApplication(application)).toEqual([])
  })

  it('rejects an invalid contact email with the field path', () => {
    const errors = validateTradeApplication(
      sampleTradeApplication({ design_contact_email: 'not-an-email' })
    )
    expect(errors.map((e) => e.field)).toContain('application.design_contact_email')
  })

  it('requires explicit booleans for the yes/no questions', () => {
    const application = sampleTradeApplication()
    delete application.mailchimp_opt_in
    delete application.cash_account_acceptable
    const fields = validateTradeApplication(application).map((e) => e.field)
    expect(fields).toContain('application.mailchimp_opt_in')
    expect(fields).toContain('application.cash_account_acceptable')
  })
})

describe('trade applications', () => {
  let pool
  let app
  let backofficeCookie
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
    await cleanup(pool)

    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    const boss = await inject('POST', '/auth/register', null, {
      email: testEmail('boss'),
      password: PASSWORD,
      name: 'Boss',
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])

    const shopper = await inject('POST', '/auth/register', null, {
      email: testEmail('shopper'),
      password: PASSWORD,
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  describe('POST /auth/trade-application', () => {
    it('creates the unapproved account and stores the full form', async () => {
      const response = await inject('POST', '/auth/trade-application', null, {
        email: testEmail('applicant'),
        password: PASSWORD,
        name: 'Alex Designer',
        application: sampleTradeApplication(),
      })
      expect(response.statusCode).toBe(201)
      const { user } = response.json()
      expect(user).toMatchObject({
        email: testEmail('applicant'),
        role: 'trade',
        trade_approved: false,
      })
      // No session: the applicant cannot sign in until the form is approved.
      expect(String(response.headers['set-cookie'] ?? '')).not.toContain('atelier_session=')

      const { rows } = await pool.query(
        'SELECT * FROM trade_applications WHERE user_id = $1',
        [user.id]
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        business_name: 'Studio Interiors Ltd',
        business_type: 'limited_liability_company',
        mailchimp_opt_in: true,
        wants_showroom_visit: true,
        wants_account_manager: false,
        cash_account_acceptable: true,
        terms_accepted: true,
        signature: 'Alex Designer',
      })
    })

    it('refuses login with 403 while the application is pending', async () => {
      const response = await inject('POST', '/auth/login', null, {
        email: testEmail('applicant'),
        password: PASSWORD,
      })
      expect(response.statusCode).toBe(403)
      expect(response.json().error).toMatch(/awaiting review/i)
      expect(String(response.headers['set-cookie'] ?? '')).not.toContain('atelier_session=')
    })

    it('rejects a body without the application form with 400', async () => {
      const response = await inject('POST', '/auth/trade-application', null, {
        email: testEmail('formless'),
        password: PASSWORD,
      })
      expect(response.statusCode).toBe(400)
    })

    it('returns field-level 422s for missing required fields', async () => {
      const application = sampleTradeApplication()
      delete application.business_name
      delete application.accounts_email
      application.terms_accepted = false

      const response = await inject('POST', '/auth/trade-application', null, {
        email: testEmail('incomplete'),
        password: PASSWORD,
        application,
      })
      expect(response.statusCode).toBe(422)
      const fields = response.json().errors.map((e) => e.field)
      expect(fields).toContain('application.business_name')
      expect(fields).toContain('application.accounts_email')
      expect(fields).toContain('application.terms_accepted')

      // Nothing was created: no account, no form.
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
        testEmail('incomplete'),
      ])
      expect(rows).toHaveLength(0)
    })

    it('rejects an unknown business type with 422', async () => {
      const response = await inject('POST', '/auth/trade-application', null, {
        email: testEmail('trust'),
        password: PASSWORD,
        application: sampleTradeApplication({ business_type: 'trust' }),
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().errors.map((e) => e.field)).toContain(
        'application.business_type'
      )
    })

    it('rejects a duplicate email with 409 and stores no orphan form', async () => {
      const before = await pool.query('SELECT count(*)::int AS n FROM trade_applications')
      const response = await inject('POST', '/auth/trade-application', null, {
        email: testEmail('applicant'),
        password: PASSWORD,
        application: sampleTradeApplication(),
      })
      expect(response.statusCode).toBe(409)
      const after = await pool.query('SELECT count(*)::int AS n FROM trade_applications')
      expect(after.rows[0].n).toBe(before.rows[0].n)
    })
  })

  describe('GET /admin/trade-applications', () => {
    it('rejects an anonymous request with 401', async () => {
      const response = await inject('GET', '/admin/trade-applications', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a non-backoffice user with 403', async () => {
      const response = await inject('GET', '/admin/trade-applications', customerCookie)
      expect(response.statusCode).toBe(403)
    })

    it('lists the form with the applicant account state attached', async () => {
      const response = await inject('GET', '/admin/trade-applications', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const { applications } = response.json()
      const application = applications.find(
        (a) => a.user?.email === testEmail('applicant')
      )
      expect(application).toBeDefined()
      expect(application).toMatchObject({
        business_name: 'Studio Interiors Ltd',
        registered_name: 'Studio Interiors (2019) Ltd',
        postal_address: 'PO Box 100, Auckland 1010',
        accounts_contact_person: 'Pat Ledger',
        design_qualifications: 'NZ Diploma in Interior Design',
        nzbn: '9429000000000',
        business_type: 'limited_liability_company',
        trade_reference: 'Fabric House / Sam Vendor / 09 555 0200',
        signatory_name: 'Alex Designer',
        signatory_position: 'Director',
      })
      expect(application.user).toMatchObject({
        email: testEmail('applicant'),
        trade_approved: false,
      })
    })

    it('reflects approval flipped via PATCH /admin/users/:id', async () => {
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
        testEmail('applicant'),
      ])
      const patch = await inject(
        'PATCH',
        `/admin/users/${rows[0].id}`,
        backofficeCookie,
        { trade_approved: true }
      )
      expect(patch.statusCode).toBe(200)

      const response = await inject('GET', '/admin/trade-applications', backofficeCookie)
      const application = response
        .json()
        .applications.find((a) => a.user?.email === testEmail('applicant'))
      expect(application.user.trade_approved).toBe(true)
    })

    it('allows the applicant to sign in once approved', async () => {
      const response = await inject('POST', '/auth/login', null, {
        email: testEmail('applicant'),
        password: PASSWORD,
      })
      expect(response.statusCode).toBe(200)
      expect(String(response.headers['set-cookie'])).toContain('atelier_session=')
    })
  })

  describe('GET /admin/trade-applications/:id', () => {
    it('returns a single application', async () => {
      const list = await inject('GET', '/admin/trade-applications', backofficeCookie)
      const { id } = list
        .json()
        .applications.find((a) => a.user?.email === testEmail('applicant'))

      const response = await inject(
        'GET',
        `/admin/trade-applications/${id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().application).toMatchObject({
        id,
        business_name: 'Studio Interiors Ltd',
      })
    })

    it('returns 404 for an unknown id', async () => {
      const response = await inject(
        'GET',
        '/admin/trade-applications/999999',
        backofficeCookie
      )
      expect(response.statusCode).toBe(404)
    })
  })
})
