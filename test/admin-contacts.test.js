import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

// /admin/contacts — the whole address book — and the director-only half of
// PATCH /admin/trade-accounts/:id (the company details the merge carried over).

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'contacts-roster-test'
const PASSWORD = 'super-secret-pw'
const GUID = 'dddddddd-0000-4000-8000-000000000001'

const cookieOf = (response) => {
  const header = response.headers['set-cookie']
  return (Array.isArray(header) ? header[0] : header).split(';')[0]
}

describe('/admin/contacts and the director-only account details', () => {
  let pool
  let app
  let staffCookie
  let directorCookie
  let accountId

  const cleanup = async () => {
    await pool.query('DELETE FROM trade_account_contacts WHERE name LIKE $1', [`${PREFIX}%`])
    await pool.query('DELETE FROM trade_accounts WHERE legacy_account_guid = $1', [GUID])
    await pool.query('DELETE FROM legacy_accounts WHERE guid = $1', [GUID])
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`${PREFIX}-%`])
  }

  const as = (cookie) => (method, url, payload) =>
    app.inject({ method, url, headers: { cookie }, payload })

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    await runner({ databaseUrl: config.databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
    await cleanup()

    for (const [who, role] of [['staff', 'backoffice'], ['director', 'director']]) {
      const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: `${PREFIX}-${who}@example.test`, password: PASSWORD, name: who } })
      await pool.query('UPDATE users SET role = $2 WHERE email = $1', [`${PREFIX}-${who}@example.test`, role])
      if (who === 'staff') staffCookie = cookieOf(res)
      else directorCookie = cookieOf(res)
    }
    await pool.query(
      `INSERT INTO legacy_accounts (guid, name, source_file, raw, imported_at) VALUES ($1, $2, 't.xlsx', '{}', now())`,
      [GUID, `${PREFIX} Studio`]
    )
    const { rows } = await pool.query(
      `INSERT INTO trade_accounts (legacy_account_guid, legacy_customer_name) VALUES ($1, $2) RETURNING id`,
      [GUID, `${PREFIX} Studio`]
    )
    accountId = rows[0].id
  })

  afterAll(async () => {
    await cleanup()
    await app.close()
    await pool.end()
  })

  it('creates, lists, files, unfiles and deletes a contact across companies', async () => {
    const staff = as(staffCookie)
    // Unattached, with a company as text.
    const created = await staff('POST', '/admin/contacts', { name: `${PREFIX} Ann`, company_name: 'Somewhere Ltd', email: 'ANN@Example.test' })
    expect(created.statusCode).toBe(201)
    const ann = created.json().contact
    expect(ann).toMatchObject({ trade_account_id: null, company: 'Somewhere Ltd', company_name: 'Somewhere Ltd' })

    // Listed, searchable by company text, filterable by filed state.
    const unfiled = (await staff('GET', `/admin/contacts?q=${encodeURIComponent(PREFIX)}&filed=false`)).json()
    expect(unfiled.contacts.map((c) => c.id)).toEqual([ann.id])
    expect((await staff('GET', `/admin/contacts?q=Somewhere`)).json().contacts.some((c) => c.id === ann.id)).toBe(true)

    // Filed under the account: company follows the account, text cleared.
    const filed = (await staff('PATCH', `/admin/contacts/${ann.id}`, { trade_account_id: accountId, role: 'Buyer' })).json().contact
    expect(filed).toMatchObject({ trade_account_id: accountId, company: `${PREFIX} Studio`, company_name: null, role: 'Buyer' })
    expect((await staff('GET', `/admin/contacts?trade_account_id=${accountId}`)).json().meta.total).toBe(1)
    // And the per-company book sees it.
    const book = (await staff('GET', `/admin/trade-accounts/${accountId}`)).json().trade_account
    expect(book.contacts.map((c) => c.name)).toEqual([`${PREFIX} Ann`])

    // Unfiled again, keeping a company as text.
    const back = (await staff('PATCH', `/admin/contacts/${ann.id}`, { trade_account_id: null, company_name: 'Elsewhere' })).json().contact
    expect(back).toMatchObject({ trade_account_id: null, company: 'Elsewhere' })

    // Refusals.
    expect((await staff('PATCH', `/admin/contacts/${ann.id}`, { trade_account_id: 999999999 })).statusCode).toBe(422)
    expect((await staff('PATCH', `/admin/contacts/${ann.id}`, { name: ' ' })).statusCode).toBe(400)
    expect((await staff('GET', '/admin/contacts/999999999')).statusCode).toBe(404)

    expect((await staff('DELETE', `/admin/contacts/${ann.id}`)).statusCode).toBe(204)
    expect((await staff('GET', `/admin/contacts/${ann.id}`)).statusCode).toBe(404)
  })

  it('rejects anonymous and customer callers', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/contacts' })).statusCode).toBe(401)
  })

  // Backoffice edits every detail (22 Sep 2026): the director gate on the
  // detail columns went with the CRM's Clients tab — the order desk fixes what
  // it takes down.
  it('lets backoffice edit company details, the account manager alongside', async () => {
    const details = { account_number: ' 01234 ', customer_type: 'Trade', email: 'Hello@Studio.test', city: 'Auckland', payment_terms: '20th of the month' }
    expect((await as(staffCookie)('PATCH', `/admin/trade-accounts/${accountId}`, { account_manager_name: 'Charlotte' })).statusCode).toBe(200)

    const ok = await as(staffCookie)('PATCH', `/admin/trade-accounts/${accountId}`, details)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().trade_account).toMatchObject({ account_number: '01234', customer_type: 'Trade', email: 'hello@studio.test', city: 'Auckland', payment_terms: '20th of the month', account_manager: { name: 'Charlotte' } })
    // A blank clears.
    expect((await as(directorCookie)('PATCH', `/admin/trade-accounts/${accountId}`, { city: '' })).json().trade_account.city).toBeNull()
    // The list carries them.
    const listed = (await as(staffCookie)('GET', `/admin/trade-accounts?q=01234`)).json()
    expect(listed.trade_accounts.map((a) => a.id)).toEqual([accountId])
  })
})
