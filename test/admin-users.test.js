import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'

// Two distinct email domains. The persistent boss/shopper live on DOMAIN and are
// registered ONCE in beforeAll (register shares a 10 / 15 min / IP rate-limit
// bucket, so re-registering per test would 429). The disposable per-test users
// live on FIXTURE_DOMAIN and are created via direct INSERT (which bypasses the
// bucket) and cleaned each test — the distinct domain means that cleanup can
// never touch the persistent users.
const DOMAIN = 'admin-usr-test.example.com'
const FIXTURE_DOMAIN = 'admin-usr-fixture.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const fixtureEmail = (local) => `${local}@${FIXTURE_DOMAIN}`
const PASSWORD = 'correct horse battery staple'

// Inserted users never log in, so any non-empty hash string is fine.
const DUMMY_HASH = '$argon2id$dummy'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Create a disposable account directly (no register endpoint -> no rate-limit
// spend). Returns the new id.
const insertUser = async (pool, { local, name = null, role = 'customer', tradeApproved = false }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name, role, trade_approved)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [fixtureEmail(local), DUMMY_HASH, name, role, tradeApproved]
  )
  return rows[0].id
}

// Rows that hang off a disposable user and make it undeletable. All three FKs
// are SET NULL, so removing the users does NOT take these with them — they must
// be cleaned by their own tag or they accumulate and later probes count rows
// from an earlier test.
const FIXTURE_TAG = 'admin-usr-del'

// trade_applications is 24 NOT NULL columns of form data, none of which this
// story cares about: a probe only asks whether a row points at the user. Kept as
// one frozen object so the INSERT is generated rather than hand-listed.
const APPLICATION_FIXTURE = Object.freeze({
  business_name: `${FIXTURE_TAG}-studio`,
  postal_address: '1 Test Street, Auckland',
  delivery_address: '1 Test Street, Auckland',
  landline_phone: '099999999',
  mobile_phone: '0210000000',
  accounts_contact_name: 'Accounts',
  accounts_contact_person: 'Ada Accounts',
  accounts_email: 'accounts@example.com',
  design_contact_name: 'Design',
  design_contact_email: 'design@example.com',
  design_contact_phone: '0210000001',
  design_qualifications: 'Interior design diploma',
  mailchimp_opt_in: false,
  primary_contact_email: 'design@example.com',
  nzbn: '9429000000000',
  business_type: 'sole_trader',
  registered_office_address: '1 Test Street, Auckland',
  directors_names_addresses: 'Ada Applicant, 1 Test Street',
  directors_dates_of_birth: '1980-01-01',
  cash_account_acceptable: true,
  trade_reference: 'Another supplier',
  terms_accepted: true,
  customer_full_name: 'Ada Applicant',
  signatory_name: 'Ada Applicant',
  signatory_position: 'Director',
  signature: 'Ada Applicant',
})

const insertOrder = async (pool, userId, suffix) => {
  await pool.query(
    `INSERT INTO orders (order_number, kind, status, user_id)
          VALUES ($1, 'order_request', 'quote_requested', $2)`,
    [`${FIXTURE_TAG}-${suffix}`, userId]
  )
}

const insertTradeApplication = async (pool, userId) => {
  const columns = Object.keys(APPLICATION_FIXTURE)
  const placeholders = columns.map((_, index) => `$${index + 2}`)
  await pool.query(
    `INSERT INTO trade_applications (user_id, ${columns.join(', ')})
          VALUES ($1, ${placeholders.join(', ')})`,
    [userId, ...Object.values(APPLICATION_FIXTURE)]
  )
}

const insertEnquiry = (pool, userId, local) =>
  pool.query(
    `INSERT INTO contact_enquiries (name, email, message, user_id)
          VALUES ('Enquirer', $1, 'Do you stock this?', $2)`,
    [fixtureEmail(local), userId]
  )

// An access grant, not a business record: trade_account_users.user_id is CASCADE
// and carries no probe, so it must never block a delete.
const insertTradeAccountGrant = async (pool, userId, suffix) => {
  const { rows } = await pool.query(
    `INSERT INTO trade_accounts (legacy_account_guid, legacy_customer_name)
          VALUES (gen_random_uuid(), $1)
       RETURNING id`,
    [`${FIXTURE_TAG}-${suffix}`]
  )
  await pool.query(
    `INSERT INTO trade_account_users (trade_account_id, user_id) VALUES ($1, $2)`,
    [rows[0].id, userId]
  )
  return rows[0].id
}

const cleanupFixtureRecords = async (pool) => {
  await pool.query('DELETE FROM orders WHERE order_number LIKE $1', [`${FIXTURE_TAG}-%`])
  await pool.query('DELETE FROM trade_applications WHERE business_name LIKE $1', [
    `${FIXTURE_TAG}-%`,
  ])
  await pool.query('DELETE FROM contact_enquiries WHERE email LIKE $1', [
    `%@${FIXTURE_DOMAIN}`,
  ])
  // trade_account_users cascades with its account.
  await pool.query('DELETE FROM trade_accounts WHERE legacy_customer_name LIKE $1', [
    `${FIXTURE_TAG}-%`,
  ])
}

// Cleans ONLY the disposable users; the persistent boss/shopper (on DOMAIN)
// survive so their session cookies stay valid across tests.
const cleanupFixtureUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${FIXTURE_DOMAIN}`])

const deletePersistentUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

// A transport that records every message instead of sending it: the reset
// route emails a link, and the test reads the token out of the letter.
const captureTransport = () => {
  const sent = []
  return { sent, sendMail: async (message) => sent.push(message) }
}
const CRM_BASE_URL = 'https://crm.test'
const STORE_BASE_URL = 'https://store.test'

describe('back-office users admin', () => {
  let pool
  let app
  let backofficeCookie
  let directorCookie
  let customerCookie
  let bossId
  let transport

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
    transport = captureTransport()
    const mailer = createMailer({ transport, from: 'studio@atelier.test', backofficeEmail: 'office@atelier.test' })
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      mailer,
      storeBaseUrl: STORE_BASE_URL,
      crmBaseUrl: CRM_BASE_URL,
      logger: false,
    })
    await app.ready()

    await cleanupFixtureRecords(pool)
    await cleanupFixtureUsers(pool)
    await deletePersistentUsers(pool)

    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [
      testEmail('boss'),
    ])
    bossId = rows[0].id

    // A director, for the one rule that tells the two staff roles apart.
    const chief = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('chief'), password: PASSWORD, name: 'Chief' },
    })
    directorCookie = sessionCookieFrom(chief)
    await pool.query(`UPDATE users SET role = 'director' WHERE email = $1`, [
      testEmail('chief'),
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  beforeEach(async () => {
    await cleanupFixtureRecords(pool)
    await cleanupFixtureUsers(pool)
  })

  afterAll(async () => {
    await cleanupFixtureRecords(pool)
    await cleanupFixtureUsers(pool)
    await deletePersistentUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('access control', () => {
    it('rejects an anonymous request with 401', async () => {
      const response = await inject('GET', '/admin/users', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a non-backoffice user with 403', async () => {
      const response = await inject('GET', '/admin/users', customerCookie)
      expect(response.statusCode).toBe(403)
    })
  })

  describe('GET /admin/users', () => {
    it('lists accounts without ever exposing password_hash', async () => {
      await insertUser(pool, { local: 'alice', name: 'Alice Client', role: 'customer' })
      const response = await inject('GET', '/admin/users', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const users = response.json().users
      const alice = users.find((u) => u.email === fixtureEmail('alice'))
      expect(alice).toBeDefined()
      expect(alice.role).toBe('customer')
      expect(alice).toHaveProperty('created_at')
      expect(alice).toHaveProperty('archived_at', null)
      expect(alice).not.toHaveProperty('password_hash')
    })

    it('filters by role', async () => {
      await insertUser(pool, { local: 'trade-user', role: 'trade', tradeApproved: true })
      await insertUser(pool, { local: 'plain-user', role: 'customer' })
      const response = await inject('GET', '/admin/users?role=trade', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('trade-user'))
      expect(emails).not.toContain(fixtureEmail('plain-user'))
    })

    it('rejects an unknown role filter with 400', async () => {
      const response = await inject('GET', '/admin/users?role=wizard', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })

    it('searches email and name with q', async () => {
      await insertUser(pool, { local: 'zephyrine', name: 'Zephyrine Testperson' })
      await insertUser(pool, { local: 'nomatch', name: 'Ordinary Person' })
      const response = await inject('GET', '/admin/users?q=Zephyrine', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('zephyrine'))
      expect(emails).not.toContain(fixtureEmail('nomatch'))
    })

    // `segment` is how the CRM navigates: the Clients section manages the people
    // who buy, Users & permissions manages the staff who serve them.
    it('segment=clients returns customer and trade accounts only', async () => {
      await insertUser(pool, { local: 'seg-customer', role: 'customer' })
      await insertUser(pool, { local: 'seg-trade', role: 'trade', tradeApproved: true })
      await insertUser(pool, { local: 'seg-staff', role: 'backoffice' })
      await insertUser(pool, { local: 'seg-boss', role: 'director' })

      const response = await inject('GET', '/admin/users?segment=clients', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('seg-customer'))
      expect(emails).toContain(fixtureEmail('seg-trade'))
      expect(emails).not.toContain(fixtureEmail('seg-staff'))
      expect(emails).not.toContain(fixtureEmail('seg-boss'))
    })

    it('segment=staff returns backoffice and director accounts only', async () => {
      await insertUser(pool, { local: 'seg2-customer', role: 'customer' })
      await insertUser(pool, { local: 'seg2-staff', role: 'backoffice' })

      const response = await inject('GET', '/admin/users?segment=staff', backofficeCookie)
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('seg2-staff'))
      expect(emails).not.toContain(fixtureEmail('seg2-customer'))
    })

    it('intersects segment with role — the Clients screen asking for trade only', async () => {
      await insertUser(pool, { local: 'seg3-customer', role: 'customer' })
      await insertUser(pool, { local: 'seg3-trade', role: 'trade' })

      const response = await inject(
        'GET',
        '/admin/users?segment=clients&role=trade',
        backofficeCookie
      )
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('seg3-trade'))
      expect(emails).not.toContain(fixtureEmail('seg3-customer'))
    })

    it('rejects an unknown segment with 400', async () => {
      const response = await inject('GET', '/admin/users?segment=wizards', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })
  })

  describe('PATCH /admin/users/:id', () => {
    it('updates role and trade_approved together', async () => {
      const id = await insertUser(pool, { local: 'applicant', role: 'customer' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        role: 'trade',
        trade_approved: true,
      })
      expect(response.statusCode).toBe(200)
      const user = response.json().user
      expect(user.role).toBe('trade')
      expect(user.trade_approved).toBe(true)
    })

    it('rejects changing your own role with 422', async () => {
      const response = await inject('PATCH', `/admin/users/${bossId}`, backofficeCookie, {
        role: 'director',
      })
      expect(response.statusCode).toBe(422)
      // The account is untouched.
      const { rows } = await pool.query(`SELECT role FROM users WHERE id = $1`, [bossId])
      expect(rows[0].role).toBe('backoffice')
    })

    it('returns 404 patching an unknown id', async () => {
      const response = await inject('PATCH', '/admin/users/99999999', backofficeCookie, {
        name: 'Ghost',
      })
      expect(response.statusCode).toBe(404)
    })

    // The number the office takes down over the phone lands on the account —
    // the same column the client edits via PATCH /auth/me — and reads back on
    // the list, where it used to be selected and then dropped (Userback 8367823).
    it('saves a phone, lists it, and folds a cleared field to null', async () => {
      const id = await insertUser(pool, { local: 'phoned', role: 'trade' })
      const saved = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, { phone: '021 555 0199' })
      expect(saved.statusCode).toBe(200)
      expect(saved.json().user.phone).toBe('021 555 0199')

      const listed = await inject('GET', `/admin/users?q=phoned`, backofficeCookie)
      expect(listed.json().users.find((u) => u.id === id).phone).toBe('021 555 0199')

      const cleared = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, { phone: '  ' })
      expect(cleared.json().user.phone).toBeNull()
    })

    // Email is editable so a typo taken down over the phone can be corrected;
    // without it the account is unreachable and unfixable short of SQL.
    it('updates the email, lower-cased so login still resolves it', async () => {
      const id = await insertUser(pool, { local: 'typo', role: 'trade' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        email: `FIXED.Typo@${FIXTURE_DOMAIN}`,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().user.email).toBe(fixtureEmail('fixed.typo'))
    })

    it('answers 409 when the new email is already taken', async () => {
      const id = await insertUser(pool, { local: 'mover', role: 'trade' })
      await insertUser(pool, { local: 'incumbent', role: 'customer' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        email: fixtureEmail('incumbent'),
      })
      expect(response.statusCode).toBe(409)
      // The original address is untouched, so nothing is left half-moved.
      const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [id])
      expect(rows[0].email).toBe(fixtureEmail('mover'))
    })

    // trade_approved only means anything on a trade row. Leaving it set on a
    // demoted account strands a flag nothing displays, and re-promoting later
    // restores trade pricing and every trade-only house with no review.
    it('clears trade_approved when the role moves off trade', async () => {
      const id = await insertUser(pool, {
        local: 'demoted',
        role: 'trade',
        tradeApproved: true,
      })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        role: 'customer',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().user.trade_approved).toBe(false)
    })

    it('ignores a contradictory trade_approved sent with a non-trade role', async () => {
      const id = await insertUser(pool, { local: 'contradiction', role: 'trade' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        role: 'backoffice',
        trade_approved: true,
      })
      expect(response.json().user.trade_approved).toBe(false)
    })

    it('leaves trade_approved alone when the role is not part of the patch', async () => {
      const id = await insertUser(pool, {
        local: 'renamed',
        role: 'trade',
        tradeApproved: true,
      })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        name: 'New Name',
      })
      expect(response.json().user.trade_approved).toBe(true)
    })

    // Finance visibility is the one permission the CRM has no other way to
    // grant. `updateUser` has accepted it since the reporting migration, but the
    // route's body schema did not list it, and Ajv's removeAdditional stripped
    // the lone key to `{}` -> 400 on minProperties. The screen read as broken
    // rather than as a closed door, so the round trip is asserted THROUGH the
    // route, not against updateUser (test/admin-reports.test.js covers that).
    it('grants and revokes can_view_finance on a staff account', async () => {
      const id = await insertUser(pool, { local: 'finance-eyes', role: 'backoffice' })
      const granted = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        can_view_finance: true,
      })
      expect(granted.statusCode).toBe(200)
      expect(granted.json().user.can_view_finance).toBe(true)

      const revoked = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        can_view_finance: false,
      })
      expect(revoked.statusCode).toBe(200)
      expect(revoked.json().user.can_view_finance).toBe(false)
    })

    // The flag only means anything on a staff row: the role is the stronger
    // statement, so a demotion clears it even when the same body asks for it.
    it('clears can_view_finance when the role moves off staff', async () => {
      const id = await insertUser(pool, { local: 'finance-demoted', role: 'backoffice' })
      expect(
        (await inject('PATCH', `/admin/users/${id}`, backofficeCookie, { can_view_finance: true }))
          .statusCode
      ).toBe(200)
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        role: 'customer',
        can_view_finance: true,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().user.can_view_finance).toBe(false)
    })

    it('rejects a non-boolean can_view_finance with 400 by schema', async () => {
      const id = await insertUser(pool, { local: 'finance-typo', role: 'backoffice' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        can_view_finance: 'yes',
      })
      expect(response.statusCode).toBe(400)
    })

    it('rejects a malformed email with 400 by schema', async () => {
      const id = await insertUser(pool, { local: 'badmail', role: 'customer' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        email: 'not-an-address',
      })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('archive / restore', () => {
    it('archive hides from the default list, include_archived shows it, restore brings it back', async () => {
      const id = await insertUser(pool, { local: 'leaver', name: 'Departing Client' })

      const archive = await inject('POST', `/admin/users/${id}/archive`, backofficeCookie)
      expect(archive.statusCode).toBe(200)
      expect(archive.json().user.archived_at).not.toBeNull()

      // Hidden from the default list.
      const defaultList = await inject('GET', '/admin/users', backofficeCookie)
      expect(defaultList.json().users.some((u) => u.id === id)).toBe(false)

      // Visible again with include_archived.
      const withArchived = await inject(
        'GET',
        '/admin/users?include_archived=true',
        backofficeCookie
      )
      expect(withArchived.json().users.some((u) => u.id === id)).toBe(true)

      const restore = await inject('POST', `/admin/users/${id}/restore`, backofficeCookie)
      expect(restore.statusCode).toBe(200)
      expect(restore.json().user.archived_at).toBeNull()

      // Back in the default list.
      const afterRestore = await inject('GET', '/admin/users', backofficeCookie)
      expect(afterRestore.json().users.some((u) => u.id === id)).toBe(true)
    })

    it('rejects archiving your own account with 422', async () => {
      const response = await inject('POST', `/admin/users/${bossId}/archive`, backofficeCookie)
      expect(response.statusCode).toBe(422)
      const { rows } = await pool.query(`SELECT archived_at FROM users WHERE id = $1`, [
        bossId,
      ])
      expect(rows[0].archived_at).toBeNull()
    })

    it('returns 404 archiving an unknown id', async () => {
      const response = await inject('POST', '/admin/users/99999999/archive', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /admin/users/:id/reset-password', () => {
    const tokenFrom = (message) => new URL(message.text.match(/https?:\S+/)[0]).searchParams.get('token')

    beforeEach(() => {
      transport.sent.length = 0
    })

    it('emails the account holder a reset link by default, and never a temp password', async () => {
      const id = await insertUser(pool, { local: 'forgot', name: 'Forgot Client' })
      const response = await inject('POST', `/admin/users/${id}/reset-password`, backofficeCookie, {})
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ reset_email_sent: true, user: { id } })
      expect(response.json().temp_password).toBeUndefined()
      expect(response.json().user.password_hash).toBeUndefined()

      // Nothing changed yet: the password moves only when the link is spent.
      const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [id])
      expect(rows[0].password_hash).toBe(DUMMY_HASH)

      expect(transport.sent).toHaveLength(1)
      const [message] = transport.sent
      expect(message.to).toBe(fixtureEmail('forgot'))
      // A client lands in the storefront, not the CRM.
      expect(message.text).toContain(`${STORE_BASE_URL}/reset-password?token=`)

      const reset = await inject('POST', '/auth/reset-password', null, {
        token: tokenFrom(message),
        password: 'a password of their own',
      })
      expect(reset.statusCode).toBe(200)
      const login = await inject('POST', '/auth/login', null, {
        email: fixtureEmail('forgot'),
        password: 'a password of their own',
      })
      expect(login.statusCode).toBe(200)
    })

    it('sends a staff account to the CRM to reset', async () => {
      const id = await insertUser(pool, { local: 'clerk', role: 'backoffice' })
      const response = await inject('POST', `/admin/users/${id}/reset-password`, backofficeCookie, {})
      expect(response.statusCode).toBe(200)
      expect(transport.sent[0].text).toContain(`${CRM_BASE_URL}/#/reset-password?token=`)
    })

    it('honours a supplied password directly, and sends no mail', async () => {
      const id = await insertUser(pool, { local: 'chosen' })
      const response = await inject('POST', `/admin/users/${id}/reset-password`, backofficeCookie, {
        password: 'a password of their own',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().temp_password).toBeUndefined()
      expect(response.json().reset_email_sent).toBeUndefined()
      expect(transport.sent).toHaveLength(0)

      const login = await inject('POST', '/auth/login', null, {
        email: fixtureEmail('chosen'),
        password: 'a password of their own',
      })
      expect(login.statusCode).toBe(200)
    })

    it('rejects a password under the minimum length with 400', async () => {
      const id = await insertUser(pool, { local: 'short' })
      const response = await inject('POST', `/admin/users/${id}/reset-password`, backofficeCookie, {
        password: 'short',
      })
      expect(response.statusCode).toBe(400)
    })

    it('refuses to email a link to an archived account', async () => {
      const id = await insertUser(pool, { local: 'gone' })
      await pool.query('UPDATE users SET archived_at = now() WHERE id = $1', [id])
      const response = await inject('POST', `/admin/users/${id}/reset-password`, backofficeCookie, {})
      expect(response.statusCode).toBe(422)
      expect(transport.sent).toHaveLength(0)
    })

    it('lets only a director reset a director', async () => {
      const id = await insertUser(pool, { local: 'principal', role: 'director' })
      const denied = await inject('POST', `/admin/users/${id}/reset-password`, backofficeCookie, {})
      expect(denied.statusCode).toBe(403)
      expect(transport.sent).toHaveLength(0)

      const allowed = await inject('POST', `/admin/users/${id}/reset-password`, directorCookie, {})
      expect(allowed.statusCode).toBe(200)
      expect(transport.sent).toHaveLength(1)
    })

    it('returns 404 for an unknown id', async () => {
      const response = await inject('POST', '/admin/users/99999999/reset-password', backofficeCookie, {})
      expect(response.statusCode).toBe(404)
    })

    it('rejects a non-backoffice caller with 403', async () => {
      const id = await insertUser(pool, { local: 'victim' })
      const response = await inject('POST', `/admin/users/${id}/reset-password`, customerCookie, {})
      expect(response.statusCode).toBe(403)
    })
  })

  describe('GET /admin/users/:id', () => {
    it('returns a single account', async () => {
      const id = await insertUser(pool, { local: 'solo', name: 'Solo Client' })
      const response = await inject('GET', `/admin/users/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json().user.email).toBe(fixtureEmail('solo'))
    })

    it('returns 404 for an unknown id', async () => {
      const response = await inject('GET', '/admin/users/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /admin/users', () => {
    it('creates an account with the default temp password (201)', async () => {
      const response = await inject('POST', '/admin/users', backofficeCookie, {
        email: fixtureEmail('created'),
        name: 'Created Staff',
        role: 'backoffice',
      })
      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.user.email).toBe(fixtureEmail('created'))
      expect(body.user.role).toBe('backoffice')
      expect(body.user).not.toHaveProperty('password_hash')
      expect(body.temp_password).toBe('AtelierTemp2026!')
    })

    it('409s a duplicate email', async () => {
      await inject('POST', '/admin/users', backofficeCookie, {
        email: fixtureEmail('dupe'),
        role: 'customer',
      })
      const again = await inject('POST', '/admin/users', backofficeCookie, {
        email: fixtureEmail('dupe'),
        role: 'customer',
      })
      expect(again.statusCode).toBe(409)
    })

    it('400s an invalid email or unknown role', async () => {
      expect(
        (await inject('POST', '/admin/users', backofficeCookie, { email: 'nope', role: 'customer' }))
          .statusCode
      ).toBe(400)
      expect(
        (await inject('POST', '/admin/users', backofficeCookie, { email: fixtureEmail('x'), role: 'wizard' }))
          .statusCode
      ).toBe(400)
    })

    it('rejects a non-backoffice caller (403)', async () => {
      const response = await inject('POST', '/admin/users', customerCookie, {
        email: fixtureEmail('nope'),
        role: 'customer',
      })
      expect(response.statusCode).toBe(403)
    })
  })

  // Hard delete. Every FK out of `users` is SET NULL or CASCADE, so the database
  // refuses nothing — a bare DELETE reports success while turning an order
  // history into anonymous guest orders with no guest_email. The registry's
  // probes are the entire defence, which is why each one is asserted separately.
  describe('DELETE /admin/users/:id', () => {
    const stillExists = async (id) => {
      const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [id])
      return rows.length === 1
    }

    it('deletes an account that never transacted', async () => {
      const id = await insertUser(pool, { local: 'mistyped', name: 'Mistyped Signup' })

      const response = await inject('DELETE', `/admin/users/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ deleted: { entity: 'user', id } })

      // Gone from the table, not merely hidden — include_archived would still
      // show a soft-archived row.
      expect(await stillExists(id)).toBe(false)
      const list = await inject('GET', '/admin/users?include_archived=true', backofficeCookie)
      expect(list.json().users.some((u) => u.id === id)).toBe(false)
    })

    it('refuses with 409 when the account has orders', async () => {
      const id = await insertUser(pool, { local: 'buyer' })
      await insertOrder(pool, id, 'buyer-1')

      const response = await inject('DELETE', `/admin/users/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      const body = response.json()
      expect(body.blockers).toEqual([
        { relation: 'orders', label: 'orders', count: 1, capped: false },
      ])
      expect(body.message).toContain('1 orders')
      // The account has an archived_at column, so the refusal offers the
      // alternative that does not destroy the history.
      expect(body.archivable).toBe(true)
      expect(await stillExists(id)).toBe(true)
      // And the order still names its buyer. This is the assertion that would
      // fail if the probe were dropped: the FK is SET NULL, so a bare delete
      // reports 200 while silently orphaning the row.
      const { rows } = await pool.query(
        'SELECT user_id FROM orders WHERE order_number = $1',
        [`${FIXTURE_TAG}-buyer-1`]
      )
      expect(rows[0].user_id).toBe(id)
    })

    it('refuses with 409 when the account has a trade application', async () => {
      const id = await insertUser(pool, { local: 'applicant-del', role: 'trade' })
      await insertTradeApplication(pool, id)

      const response = await inject('DELETE', `/admin/users/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers).toEqual([
        {
          relation: 'trade_applications',
          label: 'trade applications',
          count: 1,
          capped: false,
        },
      ])
      expect(await stillExists(id)).toBe(true)
    })

    it('refuses with 409 when the account has contact enquiries', async () => {
      const id = await insertUser(pool, { local: 'enquirer' })
      await insertEnquiry(pool, id, 'enquiry-one')

      const response = await inject('DELETE', `/admin/users/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers).toEqual([
        {
          relation: 'contact_enquiries',
          label: 'contact enquiries',
          count: 1,
          capped: false,
        },
      ])
      expect(await stillExists(id)).toBe(true)
    })

    // All three probes run as one UNION ALL, so an account with two kinds of
    // record must report both — reporting only the first would send staff round
    // the loop once per relation.
    it('names every blocking relation at once', async () => {
      const id = await insertUser(pool, { local: 'entangled', role: 'trade' })
      await insertOrder(pool, id, 'entangled-1')
      await insertOrder(pool, id, 'entangled-2')
      await insertTradeApplication(pool, id)
      await insertEnquiry(pool, id, 'entangled-enquiry')

      const response = await inject('DELETE', `/admin/users/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      const body = response.json()
      expect(body.blockers.map((b) => b.relation)).toEqual([
        'orders',
        'trade_applications',
        'contact_enquiries',
      ])
      // Each count is the relation's own, not a total — the message is what the
      // CRM dialog shows verbatim.
      expect(body.message).toContain('2 orders')
      expect(body.message).toContain('1 trade applications')
      expect(body.message).toContain('1 contact enquiries')
    })

    // trade_account_users is an access grant, not a business record: the FK is
    // CASCADE and the registry carries no probe for it, so it must not block.
    it('deletes an account whose only link is a trade-account grant', async () => {
      const id = await insertUser(pool, { local: 'granted', role: 'trade', tradeApproved: true })
      const accountId = await insertTradeAccountGrant(pool, id, 'granted')

      const response = await inject('DELETE', `/admin/users/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(await stillExists(id)).toBe(false)

      // The grant went with the login; the company it pointed at survives.
      const grants = await pool.query(
        'SELECT 1 FROM trade_account_users WHERE trade_account_id = $1',
        [accountId]
      )
      expect(grants.rows).toHaveLength(0)
      const account = await pool.query('SELECT 1 FROM trade_accounts WHERE id = $1', [
        accountId,
      ])
      expect(account.rows).toHaveLength(1)
    })

    // The other edge out of trade_accounts is SET NULL and deliberately
    // unprobed: the link outlives whoever made it, it just stops naming them.
    // Probing it would make every staff account undeletable the moment it did
    // any back-office work.
    it('is not blocked by a trade account this staff member linked', async () => {
      const staffId = await insertUser(pool, { local: 'linker', role: 'backoffice' })
      const { rows } = await pool.query(
        `INSERT INTO trade_accounts (legacy_account_guid, legacy_customer_name, linked_by_user_id)
              VALUES (gen_random_uuid(), $1, $2)
           RETURNING id`,
        [`${FIXTURE_TAG}-linked`, staffId]
      )

      const response = await inject('DELETE', `/admin/users/${staffId}`, backofficeCookie)
      expect(response.statusCode).toBe(200)

      const after = await pool.query(
        'SELECT linked_by_user_id FROM trade_accounts WHERE id = $1',
        [rows[0].id]
      )
      expect(after.rows[0].linked_by_user_id).toBeNull()
    })

    // 403, not 409: nothing references the row, the caller simply may not. The
    // guard reads ctx.user, which the route fills from request.user.
    it('refuses a self-delete with 403', async () => {
      const response = await inject('DELETE', `/admin/users/${bossId}`, backofficeCookie)
      expect(response.statusCode).toBe(403)
      const body = response.json()
      expect(body.message).toContain('your own account')
      // No blockers to list, and archiving is still on the table — the dialog
      // reads the same two fields whichever refusal it got.
      expect(body.blockers).toEqual([])
      expect(body.archivable).toBe(true)
      expect(await stillExists(bossId)).toBe(true)
    })

    // Archiving is not a precondition for deleting, and not a protection either.
    it('deletes an already-archived account', async () => {
      const id = await insertUser(pool, { local: 'archived-then-deleted' })
      const archive = await inject('POST', `/admin/users/${id}/archive`, backofficeCookie)
      expect(archive.statusCode).toBe(200)

      const response = await inject('DELETE', `/admin/users/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(await stillExists(id)).toBe(false)
    })

    it('returns 404 for an unknown id, with an empty blocker list', async () => {
      const response = await inject('DELETE', '/admin/users/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
      expect(response.json().blockers).toEqual([])
    })

    it('rejects an anonymous caller with 401 and a customer with 403', async () => {
      const id = await insertUser(pool, { local: 'protected' })

      expect((await inject('DELETE', `/admin/users/${id}`, null)).statusCode).toBe(401)
      expect(await stillExists(id)).toBe(true)

      expect((await inject('DELETE', `/admin/users/${id}`, customerCookie)).statusCode).toBe(403)
      expect(await stillExists(id)).toBe(true)
    })
  })

  // The acceptance letter: sent automatically, once, when trade_approved flips
  // false -> true. A second app instance carries the capture mailer; the boss's
  // cookie is a stateless signed cookie, so it is valid there too.
  describe('approval letter', () => {
    const TEMPLATE = 'trade_application_approved'
    let mailApp
    let transport
    const mailInject = (method, url, payload) =>
      mailApp.inject({ method, url, headers: { cookie: backofficeCookie }, payload })

    beforeAll(async () => {
      const sent = []
      transport = { sent, sendMail: async (message) => sent.push(message) }
      const mailer = createMailer({
        transport,
        from: 'atelier@example.test',
        backofficeEmail: 'office@example.test',
      })
      mailApp = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false, mailer })
      await mailApp.ready()
    })

    afterAll(async () => {
      await pool.query('DELETE FROM email_templates WHERE name = $1', [TEMPLATE])
      await mailApp.close()
    })

    beforeEach(() => {
      transport.sent.length = 0
    })

    it('sends the letter on the false -> true flip and on nothing else', async () => {
      const id = await insertUser(pool, { local: 'applicant', name: 'Ada Applicant', role: 'trade' })

      expect((await mailInject('PATCH', `/admin/users/${id}`, { name: 'Ada A.' })).statusCode).toBe(200)
      expect(transport.sent).toHaveLength(0)

      expect((await mailInject('PATCH', `/admin/users/${id}`, { trade_approved: true })).statusCode).toBe(200)
      expect(transport.sent).toHaveLength(1)
      const [letter] = transport.sent
      expect(letter.to).toBe(fixtureEmail('applicant'))
      expect(letter.subject).toContain('approved')
      expect(letter.text).toContain('Dear Ada A.,')
      expect(letter.text).toContain('Atelier Textiles Auckland Showroom')
      expect(letter.text).toContain('323 Madras Street, Christchurch Central 8013')

      // Re-saving an approved account is not a second approval.
      expect((await mailInject('PATCH', `/admin/users/${id}`, { trade_approved: true })).statusCode).toBe(200)
      expect(transport.sent).toHaveLength(1)
    })

    it('greets by the application signatory when the login has no name, from the stored letter', async () => {
      const id = await insertUser(pool, { local: 'nameless', role: 'trade' })
      await insertTradeApplication(pool, id) // signatory_name: 'Ada Applicant'
      const put = await mailInject('PUT', `/admin/email-templates/${TEMPLATE}`, {
        subject: 'Hello {{ name }}',
        body: 'Welcome aboard, {{ name }}.',
      })
      expect(put.statusCode).toBe(200)

      expect((await mailInject('PATCH', `/admin/users/${id}`, { trade_approved: true })).statusCode).toBe(200)
      expect(transport.sent).toEqual([
        expect.objectContaining({
          to: fixtureEmail('nameless'),
          subject: 'Hello Ada Applicant',
          text: 'Welcome aboard, Ada Applicant.',
        }),
      ])
    })

    it('sends nothing when the approval rides on a role change off trade', async () => {
      const id = await insertUser(pool, { local: 'demoted', role: 'trade' })
      const response = await mailInject('PATCH', `/admin/users/${id}`, {
        role: 'customer',
        trade_approved: true,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().user.trade_approved).toBe(false)
      expect(transport.sent).toHaveLength(0)
    })
  })
})
