// The trade application review flow (24 Sep 2026): the approver (Liz) approves
// or declines — a decline's reason is emailed to the applicant — and her
// approval asks the accounts desk (Jenette) for the final one, which emails the
// client and adds the company to Xero. Each step is locked to its person.
// Cancelling a client archives it here AND in Xero, and the account owner,
// picked from the staff logins, is the account manager the portal shows.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'
import { createXeroService } from '../src/xero/service.js'
import { submitTradeApplication } from '../src/users/trade-applications.js'
import { linkCompanyToXero, mayReview, setCompanyXeroArchived } from '../src/trade-accounts/review.js'
import { loadViewerTradeAccount } from '../src/trade-accounts/viewer.js'
import { sampleTradeApplication, cleanupTradeApplications } from './helpers/trade-application-fixture.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'trade-review-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'
const CRM = 'http://crm.example'

const XERO_CONFIG = Object.freeze({
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  grantType: 'authorization_code',
  redirectUri: 'http://localhost:3001/admin/xero/callback',
  scopes: 'openid offline_access accounting.transactions',
  salesAccountCode: '200',
  lineAmountTypes: 'Exclusive',
  invoiceStatus: 'AUTHORISED',
  invoiceDueDays: 30,
  paymentAccountCode: '090',
  purchasesAccountCode: '300',
  billStatus: 'DRAFT',
  pullIntervalMinutes: 0,
})

// The accounting seam only: no contact matches, a create answers contact-1,
// and every call is recorded.
const createFakeXero = () => {
  const calls = []
  return {
    calls,
    connections: async () => [{ tenantId: 'tenant-1', tenantName: 'Atelier Textiles' }],
    accounting: async (accessToken, tenantId, method, path, options = {}) => {
      calls.push({ method, path, ...options })
      if (method === 'GET') return { Contacts: [] }
      return { Contacts: [{ ContactID: 'contact-1' }] }
    },
  }
}

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

describe('trade application review', () => {
  let pool
  let app
  let fake
  const cookies = {}
  const ids = {}
  const sent = []

  const as = (who) => (method, url, payload) =>
    app.inject({ method, url, headers: { cookie: cookies[who] }, payload })
  const liz = as('liz')
  const jenette = as('jenette')
  const office = as('office')

  // Straight through the module, not the public route: the register bucket
  // (10 per 15 min per IP) is not what this suite is about.
  const apply = async (local) => {
    const { user, tradeAccountId } = await submitTradeApplication(pool, {
      email: testEmail(local),
      passwordHash: 'not-a-real-hash',
      name: null,
      application: sampleTradeApplication({ business_name: `Review ${local} Ltd` }),
    })
    return { user, accountId: tradeAccountId }
  }

  const cleanup = async () => {
    await cleanupTradeApplications(pool, `%@${DOMAIN}`)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
  }

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
    await cleanup()
    await pool.query(
      `INSERT INTO xero_connection (id, grant_type, token_set, tenant_id, org_name)
       VALUES (1, 'authorization_code', $1, 'tenant-1', 'Atelier Textiles')
       ON CONFLICT (id) DO UPDATE
          SET grant_type = EXCLUDED.grant_type, token_set = EXCLUDED.token_set,
              tenant_id = EXCLUDED.tenant_id, org_name = EXCLUDED.org_name`,
      [JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at_ms: Date.now() + 3600_000 })]
    )

    fake = createFakeXero()
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      logger: false,
      mailer: createMailer({
        transport: { sendMail: async (message) => sent.push(message) },
        from: 'Atelier <no-reply@atelier.example>',
        backofficeEmail: 'office@atelier.example',
      }),
      xero: createXeroService({ pool, config: XERO_CONFIG, http: fake }),
      crmBaseUrl: CRM,
      // Mixed case on purpose: the lock compares addresses, not spellings.
      tradeApproverEmail: testEmail('LIZ'),
      tradeAccountsEmail: testEmail('jenette'),
    })
    await app.ready()

    for (const [who, name, role] of [
      ['liz', 'Liz', 'director'],
      ['jenette', 'Jenette', 'director'],
      ['office', 'Office', 'backoffice'],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: testEmail(who), password: PASSWORD, name },
      })
      cookies[who] = sessionCookieFrom(response)
      ids[who] = response.json().user.id
      await pool.query(`UPDATE users SET role = $2 WHERE id = $1`, [ids[who], role])
    }
  })

  beforeEach(() => {
    sent.length = 0
    fake.calls.length = 0
  })

  afterAll(async () => {
    await cleanup()
    await app.close()
    await pool.end()
  })

  it('lets anyone take a step nobody is configured for, and only that person otherwise', () => {
    expect(mayReview({ email: 'a@x.example' }, null)).toBe(true)
    expect(mayReview({ email: 'Liz@X.example' }, ' liz@x.example ')).toBe(true)
    expect(mayReview({ email: 'jenette@x.example' }, 'liz@x.example')).toBe(false)
  })

  describe('decline', () => {
    it('is the approver\'s alone, and needs a reason that says something', async () => {
      const { user } = await apply('reasonless')
      expect((await office('POST', `/admin/users/${user.id}/decline`, { reason: 'No' })).statusCode).toBe(403)
      expect((await jenette('POST', `/admin/users/${user.id}/decline`, { reason: 'No' })).statusCode).toBe(403)
      expect((await liz('POST', `/admin/users/${user.id}/decline`, {})).statusCode).toBe(400)
      expect((await liz('POST', `/admin/users/${user.id}/decline`, { reason: '   ' })).statusCode).toBe(422)
      expect(sent).toHaveLength(0)
    })

    it('archives the login, keeps the reason on the form and emails it to the applicant', async () => {
      const { user } = await apply('declined')
      const response = await liz('POST', `/admin/users/${user.id}/decline`, {
        reason: ' We could not verify your NZBN. ',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().user.archived_at).not.toBeNull()

      const { rows } = await pool.query(
        'SELECT id, declined_at, decline_reason FROM trade_applications WHERE user_id = $1',
        [user.id]
      )
      expect(rows[0].declined_at).not.toBeNull()
      expect(rows[0].decline_reason).toBe('We could not verify your NZBN.')
      const form = await liz('GET', `/admin/trade-applications/${rows[0].id}`)
      expect(form.json().application.decline_reason).toBe('We could not verify your NZBN.')

      expect(sent).toHaveLength(1)
      expect(sent[0].to).toBe(testEmail('declined'))
      expect(sent[0].text).toContain('Dear Alex Designer,')
      expect(sent[0].text).toContain('Review declined Ltd')
      expect(sent[0].text).toContain('We could not verify your NZBN.')

      // Declined once is declined: a second go is refused and mails nobody.
      sent.length = 0
      expect((await liz('POST', `/admin/users/${user.id}/decline`, { reason: 'Again' })).statusCode).toBe(422)
      expect(sent).toHaveLength(0)
    })

    it('refuses a staff login and 404s an unknown one', async () => {
      expect((await liz('POST', `/admin/users/${ids.office}/decline`, { reason: 'No' })).statusCode).toBe(422)
      expect((await liz('POST', '/admin/users/999999999/decline', { reason: 'No' })).statusCode).toBe(404)
    })
  })

  describe('approve — two steps', () => {
    it('Liz approves and Jenette is asked; Jenette approves and the client is emailed and added to Xero', async () => {
      const { user, accountId } = await apply('approved')

      // The final approval waits on Liz's, and is Jenette's alone.
      expect((await jenette('PATCH', `/admin/users/${user.id}`, { trade_approved: true })).statusCode).toBe(422)
      expect((await office('POST', `/admin/users/${user.id}/approve`)).statusCode).toBe(403)
      expect((await jenette('POST', `/admin/users/${user.id}/approve`)).statusCode).toBe(403)

      const first = await liz('POST', `/admin/users/${user.id}/approve`)
      expect(first.statusCode).toBe(200)
      expect(first.json().user).toMatchObject({ trade_approved: false })
      expect(first.json().user.trade_first_approved_at).not.toBeNull()
      expect(sent.map((m) => m.to)).toEqual([testEmail('jenette')])
      expect(sent[0].subject).toBe('New trade account to approve: Review approved Ltd')
      expect(sent[0].text).toContain('approved by Liz')
      expect(sent[0].text).toContain(`${CRM}/#/clients/accounts/${accountId}`)
      expect(fake.calls).toHaveLength(0)

      // Still pending — nothing is granted until the final approval.
      const queue = await liz('GET', '/admin/trade-accounts?pending=true')
      expect(queue.json().trade_accounts.find((a) => a.id === accountId).users[0].trade_first_approved_at).not.toBeNull()
      expect((await liz('POST', `/admin/users/${user.id}/approve`)).statusCode).toBe(422)
      expect((await liz('PATCH', `/admin/users/${user.id}`, { trade_approved: true })).statusCode).toBe(403)

      sent.length = 0
      const final = await jenette('PATCH', `/admin/users/${user.id}`, { trade_approved: true })
      expect(final.statusCode).toBe(200)
      expect(final.json().user.trade_approved).toBe(true)
      expect(final.json().xero_contact).toEqual({ linked: true, xero_contact_id: 'contact-1' })
      expect(sent.map((m) => m.to)).toEqual([testEmail('approved')])
      expect(sent[0].subject).toContain('approved')
      const { rows } = await pool.query('SELECT xero_contact_id FROM trade_accounts WHERE id = $1', [accountId])
      expect(rows[0].xero_contact_id).toBe('contact-1')

      // Re-saving an approved login sends nothing and touches Xero no more.
      sent.length = 0
      fake.calls.length = 0
      const again = await jenette('PATCH', `/admin/users/${user.id}`, { trade_approved: true })
      expect(again.json().xero_contact).toBeUndefined()
      expect(sent).toHaveLength(0)
      expect(fake.calls).toHaveLength(0)

      // Revoking (any back-office login) sends the login back to the start.
      const revoked = await office('PATCH', `/admin/users/${user.id}`, { trade_approved: false })
      expect(revoked.json().user.trade_first_approved_at).toBeNull()
    })

    it('a decline after Liz approved clears her approval', async () => {
      const { user } = await apply('changed-mind')
      await liz('POST', `/admin/users/${user.id}/approve`)
      await liz('POST', `/admin/users/${user.id}/decline`, { reason: 'Reference fell through.' })
      const { rows } = await pool.query('SELECT trade_first_approved_at FROM users WHERE id = $1', [user.id])
      expect(rows[0].trade_first_approved_at).toBeNull()
    })

    it('tells the CRM who takes each step', async () => {
      const { accountId } = await apply('told')
      const detail = await office('GET', `/admin/trade-accounts/${accountId}`)
      expect(detail.json().trade_review).toEqual({
        approver_email: testEmail('LIZ'),
        accounts_email: testEmail('jenette'),
      })
    })

    it('says in words why Xero was not reached, never throwing', async () => {
      expect(await linkCompanyToXero(null, 1)).toEqual({
        linked: false,
        reason: 'Xero is not set up on this server.',
      })
      const broken = { ensureTradeAccountContact: async () => { throw new Error('Xero is down.') } }
      expect(await linkCompanyToXero(broken, 1)).toEqual({ linked: false, reason: 'Xero is down.' })
      expect(await setCompanyXeroArchived(broken, null, true)).toBeNull()
    })
  })

  describe('cancel', () => {
    it('archives the company, its logins and its Xero contact; restore brings back the company', async () => {
      const { user, accountId } = await apply('cancelled')
      await pool.query(`UPDATE users SET trade_approved = true WHERE id = $1`, [user.id])
      await pool.query(`UPDATE trade_accounts SET xero_contact_id = 'contact-9' WHERE id = $1`, [accountId])

      const archived = await office('POST', `/admin/trade-accounts/${accountId}/archive`)
      expect(archived.statusCode).toBe(200)
      const body = archived.json()
      expect(body.trade_account.archived_at).not.toBeNull()
      expect(body.trade_account.users[0].archived_at).not.toBeNull()
      expect(body.xero_contact).toEqual({ updated: true })
      expect(fake.calls.at(-1)).toMatchObject({
        method: 'POST',
        path: 'Contacts/contact-9',
        body: { Contacts: [{ ContactID: 'contact-9', ContactStatus: 'ARCHIVED' }] },
      })

      const restored = await office('POST', `/admin/trade-accounts/${accountId}/restore`)
      expect(restored.statusCode).toBe(200)
      expect(restored.json().trade_account.archived_at).toBeNull()
      // Logins come back one by one, from the account page.
      expect(restored.json().trade_account.users[0].archived_at).not.toBeNull()
      expect(fake.calls.at(-1).body.Contacts[0].ContactStatus).toBe('ACTIVE')
    })

    it('answers xero_contact null for a company Xero has never seen, and 404s an unknown one', async () => {
      const { accountId } = await apply('unlinked')
      const archived = await office('POST', `/admin/trade-accounts/${accountId}/archive`)
      expect(archived.json().xero_contact).toBeNull()
      expect(fake.calls).toHaveLength(0)
      expect((await office('POST', '/admin/trade-accounts/999999999/archive')).statusCode).toBe(404)
    })
  })

  describe('Add to Xero and the account owner', () => {
    it('links an unlinked company on demand', async () => {
      const { accountId } = await apply('retry')
      const response = await office('POST', `/admin/trade-accounts/${accountId}/xero-contact`)
      expect(response.statusCode).toBe(200)
      expect(response.json().trade_account.xero_contact_id).toBe('contact-1')
      expect((await office('POST', '/admin/trade-accounts/999999999/xero-contact')).statusCode).toBe(404)
    })

    it('takes a current staff login as owner, who is the account manager the client sees', async () => {
      const { user, accountId } = await apply('owned')
      await pool.query(
        `UPDATE trade_accounts SET account_manager_name = 'Atelier Sales' WHERE id = $1`,
        [accountId]
      )
      // Nobody picked: the old text is what the portal shows.
      expect((await loadViewerTradeAccount(pool, user.id)).account_manager).toEqual({
        name: 'Atelier Sales',
        email: null,
        phone: null,
      })

      const owned = await office('PATCH', `/admin/trade-accounts/${accountId}`, { account_owner_id: ids.jenette })
      expect(owned.statusCode).toBe(200)
      expect(owned.json().trade_account.account_owner).toEqual({
        id: ids.jenette,
        name: 'Jenette',
        email: testEmail('jenette'),
      })
      // Name and work email — never the staff login's own phone.
      await pool.query(`UPDATE users SET phone = '021 000 0000' WHERE id = $1`, [ids.jenette])
      expect((await loadViewerTradeAccount(pool, user.id)).account_manager).toEqual({
        name: 'Jenette',
        email: testEmail('jenette'),
        phone: null,
      })

      const client = await office('PATCH', `/admin/trade-accounts/${accountId}`, { account_owner_id: user.id })
      expect(client.statusCode).toBe(422)

      const cleared = await office('PATCH', `/admin/trade-accounts/${accountId}`, { account_owner_id: null })
      expect(cleared.json().trade_account.account_owner).toBeNull()
    })
  })
})
