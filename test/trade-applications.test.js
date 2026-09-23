import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'
import {
  validateTradeApplication,
  newsletterOptInAddress,
} from '../src/users/trade-applications.js'
import { memberRequest } from '../src/newsletter/mailchimp.js'
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
// The company each application raised goes with it (contacts and the login
// grant cascade off the company row).
const cleanup = async (pool) => {
  await pool.query(
    `DELETE FROM trade_accounts
      WHERE id IN (SELECT trade_account_id FROM trade_applications
                    WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1))`,
    [`%@${TEST_DOMAIN}`]
  )
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

describe('newsletterOptInAddress', () => {
  const yes = sampleTradeApplication({ primary_contact_email: ' hello@studio.example.com ' })
  const no = sampleTradeApplication({ mailchimp_opt_in: false })

  it('a Yes on submission signs up the trimmed primary contact email', () => {
    expect(newsletterOptInAddress(null, yes)).toBe('hello@studio.example.com')
  })

  it('a No signs nobody up', () => {
    expect(newsletterOptInAddress(null, no)).toBeNull()
    expect(newsletterOptInAddress(yes, no)).toBeNull()
  })

  it('from the portal: a switch to Yes or a new address signs up, a re-save does not', () => {
    expect(newsletterOptInAddress(no, yes)).toBe('hello@studio.example.com')
    expect(newsletterOptInAddress(yes, { ...yes })).toBeNull()
    expect(newsletterOptInAddress(yes, { ...yes, primary_contact_email: 'HELLO@studio.example.com' })).toBeNull()
    expect(newsletterOptInAddress(yes, { ...yes, primary_contact_email: 'new@studio.example.com' })).toBe(
      'new@studio.example.com'
    )
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

    // The form raises the client company it asks for: the business on the
    // roster, its two named people in the contact book, the login granted —
    // so the office reviews the application on the account row itself.
    it('raises the client account, files its two contacts and grants the login', async () => {
      const response = await inject('POST', '/auth/trade-application', null, {
        email: testEmail('raised'),
        password: PASSWORD,
        application: sampleTradeApplication(),
      })
      expect(response.statusCode).toBe(201)
      const { user } = response.json()

      const { rows: forms } = await pool.query(
        'SELECT trade_account_id FROM trade_applications WHERE user_id = $1',
        [user.id]
      )
      const accountId = forms[0].trade_account_id
      expect(accountId).toEqual(expect.any(Number))

      const list = await inject('GET', '/admin/trade-accounts?pending=true&q=raised@', backofficeCookie)
      expect(list.statusCode).toBe(200)
      const account = list.json().trade_accounts.find((a) => a.id === accountId)
      expect(account).toMatchObject({
        company_name: 'Studio Interiors Ltd',
        customer_type: 'Trade',
        legacy_account_guid: null,
        trade_application_id: forms.length ? expect.any(Number) : null,
        contact_count: 2,
      })
      expect(account.users).toEqual([
        expect.objectContaining({ id: user.id, role: 'trade', trade_approved: false }),
      ])

      const detail = await inject('GET', `/admin/trade-accounts/${accountId}`, backofficeCookie)
      const roles = detail.json().trade_account.contacts.map((c) => c.role).sort()
      expect(roles).toEqual(['Accounts', 'Design'])

      // Approving the login is what takes the account off the pending list.
      await inject('PATCH', `/admin/users/${user.id}`, backofficeCookie, { trade_approved: true })
      const after = await inject('GET', '/admin/trade-accounts?pending=true&q=raised@', backofficeCookie)
      expect(after.json().trade_accounts.some((a) => a.id === accountId)).toBe(false)
    })

    // Its own instance: the alert needs a mailer, and the shared app has none
    // (nor spare register/login bucket to lend).
    describe('the back-office alert', () => {
      const BACKOFFICE = 'office@trade-app-test.example.com'
      const CRM = 'http://crm.test'
      let mailApp
      let sent

      beforeAll(async () => {
        sent = []
        const mailer = createMailer({
          transport: { sendMail: async (message) => sent.push(message) },
          from: 'studio@trade-app-test.example.com',
          backofficeEmail: BACKOFFICE,
        })
        mailApp = buildApp({
          pool,
          cookieSecret: TEST_COOKIE_SECRET,
          mailer,
          crmBaseUrl: CRM,
          logger: false,
        })
        await mailApp.ready()
      })

      afterAll(async () => {
        await mailApp.close()
      })

      it('goes to the one back-office address, Reply-To the applicant, linking the CRM', async () => {
        const response = await mailApp.inject({
          method: 'POST',
          url: '/auth/trade-application',
          payload: {
            email: testEmail('alerted'),
            password: PASSWORD,
            application: sampleTradeApplication(),
          },
        })
        expect(response.statusCode).toBe(201)
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({
          to: BACKOFFICE,
          replyTo: testEmail('alerted'),
          subject: 'New trade application to review: Studio Interiors Ltd',
        })
        expect(sent[0].text).toContain(`${CRM}/#/clients/accounts?pending=true`)
        // The applicant is NOT mailed: the acceptance letter is their one letter.
        expect(sent.some((m) => m.to === testEmail('alerted'))).toBe(false)
      })

      it('a filled honeypot answers 201 and creates neither account nor letter', async () => {
        sent.length = 0
        const response = await mailApp.inject({
          method: 'POST',
          url: '/auth/trade-application',
          payload: {
            website: 'http://spam.example',
            email: testEmail('bot'),
            password: PASSWORD,
            application: sampleTradeApplication(),
          },
        })
        expect(response.statusCode).toBe(201)
        expect(response.json()).toEqual({ user: null })
        expect(sent).toHaveLength(0)
        const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [
          testEmail('bot'),
        ])
        expect(rows).toHaveLength(0)
      })
    })

    // "Happy to receive notifications from Mailchimp?" Yes = the footer's
    // sign-up. Its own instance: it needs Mailchimp config and a fake fetch,
    // and its own register bucket.
    describe('the Mailchimp opt-in', () => {
      const NEWSLETTER = { apiKey: 'abc123-us21', server: 'us21', audienceId: 'list9' }
      let optInApp
      let calls
      let mailchimpStatus

      const apply = (local, overrides) =>
        optInApp.inject({
          method: 'POST',
          url: '/auth/trade-application',
          payload: {
            email: testEmail(local),
            password: PASSWORD,
            application: sampleTradeApplication(overrides),
          },
        })

      beforeAll(async () => {
        calls = []
        const newsletterFetch = async (url, init) => {
          calls.push({ url, init })
          return {
            ok: mailchimpStatus < 400,
            status: mailchimpStatus,
            json: async () => (mailchimpStatus < 400 ? { status: 'pending' } : { title: 'Invalid Resource' }),
          }
        }
        optInApp = buildApp({
          pool,
          cookieSecret: TEST_COOKIE_SECRET,
          newsletter: NEWSLETTER,
          newsletterFetch,
          logger: false,
        })
        await optInApp.ready()
      })

      afterAll(async () => {
        await optInApp.close()
      })

      it('a Yes puts the primary contact email on the footer audience', async () => {
        calls.length = 0
        mailchimpStatus = 200
        const response = await apply('opted-in', { primary_contact_email: 'news@trade-app-test.example.com' })
        expect(response.statusCode).toBe(201)
        expect(calls).toHaveLength(1)
        const expected = memberRequest(NEWSLETTER, 'news@trade-app-test.example.com')
        expect(calls[0].url).toBe(expected.url)
        expect(JSON.parse(calls[0].init.body)).toEqual(JSON.parse(expected.init.body))
      })

      it('a No signs nobody up', async () => {
        calls.length = 0
        mailchimpStatus = 200
        const response = await apply('opted-out', { mailchimp_opt_in: false })
        expect(response.statusCode).toBe(201)
        expect(calls).toHaveLength(0)
      })

      it('a Mailchimp refusal does not fail the application', async () => {
        calls.length = 0
        mailchimpStatus = 400
        const response = await apply('refused')
        expect(response.statusCode).toBe(201)
        expect(calls).toHaveLength(1)
        const { rows } = await pool.query(
          `SELECT 1 FROM trade_applications ta JOIN users u ON u.id = ta.user_id WHERE u.email = $1`,
          [testEmail('refused')]
        )
        expect(rows).toHaveLength(1)
      })

      it('a filled honeypot calls nobody', async () => {
        calls.length = 0
        mailchimpStatus = 200
        const response = await optInApp.inject({
          method: 'POST',
          url: '/auth/trade-application',
          payload: {
            website: 'http://spam.example',
            email: testEmail('bot-optin'),
            password: PASSWORD,
            application: sampleTradeApplication(),
          },
        })
        expect(response.statusCode).toBe(201)
        expect(calls).toHaveLength(0)
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
      // `role` is load-bearing, not decoration: the CRM's review queue decides
      // "still pending" with a predicate that reads it, and a partial account
      // object fails that test silently — which is what once hid every submitted
      // application from the queue while the Clients tab counted it as pending.
      expect(application.user).toMatchObject({
        email: testEmail('applicant'),
        role: 'trade',
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

  // Runs last: it spends the applicant the earlier blocks rely on.
  describe('DELETE /admin/trade-applications/:id', () => {
    const findApplication = async () => {
      const list = await inject('GET', '/admin/trade-applications', backofficeCookie)
      return list.json().applications.find((a) => a.user?.email === testEmail('applicant'))
    }

    it('rejects an anonymous request with 401', async () => {
      const { id } = await findApplication()
      expect((await inject('DELETE', `/admin/trade-applications/${id}`, null)).statusCode).toBe(401)
    })

    it('rejects a non-backoffice user with 403', async () => {
      const { id } = await findApplication()
      const response = await inject('DELETE', `/admin/trade-applications/${id}`, customerCookie)
      expect(response.statusCode).toBe(403)
    })

    it('returns 404 for an unknown id', async () => {
      const response = await inject('DELETE', '/admin/trade-applications/999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })

    // The scenario the route exists for: a declined applicant's email must be
    // usable for a new account. Archiving the login leaves the email taken, the
    // login cannot be deleted while its form is on file, so the form has to go
    // first — and once it has, both the delete and the fresh account succeed.
    it('frees a declined applicant\'s email once the form is deleted', async () => {
      const application = await findApplication()
      const userId = application.user.id
      const email = testEmail('applicant')

      const archived = await inject('POST', `/admin/users/${userId}/archive`, backofficeCookie, {})
      expect(archived.statusCode).toBe(200)

      const taken = await inject('POST', '/admin/users', backofficeCookie, { email, role: 'customer' })
      expect(taken.statusCode).toBe(409)

      const blocked = await inject('DELETE', `/admin/users/${userId}`, backofficeCookie)
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json().blockers.map((b) => b.relation)).toEqual(['trade_applications'])

      const deleted = await inject('DELETE', `/admin/trade-applications/${application.id}`, backofficeCookie)
      expect(deleted.statusCode).toBe(200)
      expect(deleted.json()).toEqual({ deleted: { entity: 'trade_application', id: application.id } })
      expect((await inject('GET', `/admin/trade-applications/${application.id}`, backofficeCookie)).statusCode).toBe(404)

      const gone = await inject('DELETE', `/admin/users/${userId}`, backofficeCookie)
      expect(gone.statusCode).toBe(200)

      const fresh = await inject('POST', '/admin/users', backofficeCookie, { email, role: 'customer' })
      expect(fresh.statusCode).toBe(201)
      expect(fresh.json().user).toMatchObject({ email, role: 'customer' })
    })
  })
})
