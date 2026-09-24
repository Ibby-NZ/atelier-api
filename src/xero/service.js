// The Xero service — the ONE object the rest of the API sees (buildApp gets
// it as `xero`, the same dependency-injection posture as Stripe and the
// mailer: null means "not configured", and the routes answer 503).
//
// TWO GRANTS, ONE INTERFACE. A "Custom Connection" (client_credentials) is
// Xero's paid M2M add-on: no consent screen, the token is org-bound, and a
// fresh access token is fetched on demand — nothing worth persisting beyond
// the tenant for display. The standard authorization_code flow works with any
// free Xero app but needs a director to click through consent once, and its
// refresh tokens are SINGLE-USE AND ROTATE — the refresh cycle runs inside
// `withConnectionLock` so two workers can never both spend one (the loser of
// that race bricks the connection until someone reconnects). Which grant is
// live comes from config (XERO_GRANT_TYPE), and status() always says.
//
// CONTACTS ARE MATCHED BEFORE THEY ARE CREATED. Atelier already lives in
// Xero — most clients exist there today (the D365 mirror even carries their
// old xero_contact_ids) — so creating on a miss without searching first would
// salt the org with duplicates Xero itself cannot merge back. Match order is
// email, then exact name (mapping.matchContact); only then create, and a
// name-taken validation answer retries once with "Name (email)" because Name
// is Xero's uniqueness key and two different clients may share one.
//
// INVOICE PUSHES ARE IDEMPOTENT AT XERO'S END: every POST /Invoices carries
// Idempotency-Key atelier-order-<id>, so a retry (or two staff clicking at
// once) returns the SAME invoice instead of minting a duplicate. Our own
// duplicate gate is orders.xero_invoice_id — set once, further pushes 409.

import crypto from 'node:crypto'
import { getAdminOrder, markOrderPaid, setOrderStatus } from '../orders/admin-orders.js'
import {
  INVOICEABLE_STATUSES,
  canTransition,
  unpricedLineCount,
} from '../orders/order-states.js'
import { getPurchaseOrder, payPurchaseOrder } from '../purchasing/admin-purchase-orders.js'
import { SOURCE_STATUSES } from '../purchasing/po-states.js'
import { createTradeAccount } from '../trade-accounts/admin-trade-accounts.js'
import { createSupplier, getSupplier } from '../suppliers/admin-suppliers.js'
import {
  loadConnection,
  saveTokenSet,
  clearConnection,
  savePendingState,
  takePendingState,
  withConnectionLock,
} from './connection-store.js'
import { XeroHttpError, XERO_LOGIN_BASE, validationMessages } from './xero-http.js'
import {
  billForPurchaseOrder,
  billStateFrom,
  contactDetailsFromXero,
  contactForSupplier,
  contactForTradeAccount,
  contactForUser,
  invoiceForOrder,
  isDeadInXero,
  itemForColourway,
  paymentForInvoice,
  pickInvoice,
  pickContact,
  matchContact,
} from './mapping.js'

/** Configured but no completed connection (auth-code flow, pre-consent). */
export class XeroNotConnectedError extends Error {
  constructor() {
    super('Xero is not connected. A director connects it from the Xero screen in the CRM.')
    this.name = 'XeroNotConnectedError'
  }
}

/** The OAuth callback did not match a pending Connect click. */
export class XeroCallbackError extends Error {
  constructor(message) {
    super(message)
    this.name = 'XeroCallbackError'
  }
}

/** A push refused by our own rules (already pushed, not invoiceable, unpriced). */
export class XeroConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'XeroConflictError'
  }
}

/** Something Xero refused as invalid — surfaced with Xero's own messages. */
export class XeroValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'XeroValidationError'
  }
}

// Refresh/refetch when the token has less life than this left — a request in
// flight must not outlive its bearer.
const EXPIRY_SLACK_MS = 60_000
const CONTACT_PAGE_SIZE = 100
const UPSERT_BATCH_SIZE = 40

// The statuses at which money has already changed hands, so a freshly pushed
// invoice is recorded paid on the spot (card checkouts are born `paid`).
const PAID_STATUSES = Object.freeze(['paid', 'shipped', 'completed'])

/** One sentence for a payment that Xero, or the connection, refused. */
const paymentFailureReason = (error) =>
  error instanceof XeroHttpError
    ? validationMessages(error.body).join('; ') || `Xero answered ${error.status}.`
    : error?.message || 'Xero did not record the payment.'

export const createXeroService = ({
  pool,
  config,
  http,
  now = () => Date.now(),
  // Called with the fresh order after Xero moves it — the pull's `paid`, the
  // push's `pending_payment`. server.js wires the status letter here so a move
  // Xero makes writes the same letter the CRM's status dropdown does.
  notifyOrderTransition = async () => {},
}) => {
  // client_credentials keeps its short-lived token in memory only: it can be
  // re-minted at will, so persisting it buys nothing and staleness bugs.
  let ccCache = null // { accessToken, expiresAtMs, tenantId, orgName }

  const tokenSetFromResponse = (body) => ({
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    expires_at_ms: now() + Number(body.expires_in ?? 1800) * 1000,
  })

  const firstTenant = async (accessToken) => {
    const connections = await http.connections(accessToken)
    const tenant = connections[0]
    if (!tenant) {
      throw new XeroValidationError(
        'The Xero app has no connected organisation — authorise it against the Atelier org in Xero.'
      )
    }
    return { tenantId: tenant.tenantId, orgName: tenant.tenantName ?? null }
  }

  const clientCredentialsAccess = async (force = false) => {
    if (!force && ccCache && ccCache.expiresAtMs - now() > EXPIRY_SLACK_MS) return ccCache
    const body = await http.tokenWithClientCredentials()
    const set = tokenSetFromResponse(body)
    const { tenantId, orgName } = await firstTenant(set.access_token)
    ccCache = { accessToken: set.access_token, expiresAtMs: set.expires_at_ms, tenantId, orgName }
    // Persisted only so status() can name the org across restarts.
    await saveTokenSet(pool, {
      grantType: 'client_credentials',
      tokenSet: { expires_at_ms: set.expires_at_ms },
      tenantId,
      orgName,
    })
    return ccCache
  }

  const authCodeAccess = async (force = false) => {
    const connection = await loadConnection(pool)
    const set = connection?.token_set
    if (!set?.refresh_token) throw new XeroNotConnectedError()
    if (!force && Number(set.expires_at_ms ?? 0) - now() > EXPIRY_SLACK_MS) {
      return { accessToken: set.access_token, tenantId: connection.tenant_id }
    }
    // Refresh under the row lock; re-check inside so the second worker in the
    // queue finds the fresh token and does NOT spend the (now dead) old one.
    return withConnectionLock(pool, async (client, locked) => {
      const lockedSet = locked?.token_set
      if (!lockedSet?.refresh_token) throw new XeroNotConnectedError()
      if (!force && Number(lockedSet.expires_at_ms ?? 0) - now() > EXPIRY_SLACK_MS) {
        return { accessToken: lockedSet.access_token, tenantId: locked.tenant_id }
      }
      const body = await http.tokenFromRefresh(lockedSet.refresh_token)
      const fresh = tokenSetFromResponse(body)
      await saveTokenSet(client, {
        grantType: 'authorization_code',
        tokenSet: fresh,
        tenantId: locked?.tenant_id ?? null,
        orgName: locked?.org_name ?? null,
      })
      return { accessToken: fresh.access_token, tenantId: locked?.tenant_id ?? null }
    })
  }

  const access = (force) =>
    config.grantType === 'client_credentials' ? clientCredentialsAccess(force) : authCodeAccess(force)

  /**
   * One authorised Accounting call, with a single forced-refresh retry on 401
   * (a token can be revoked or expire between our check and Xero's).
   */
  const call = async (method, path, options) => {
    const first = await access(false)
    try {
      return await http.accounting(first.accessToken, first.tenantId, method, path, options)
    } catch (error) {
      if (error instanceof XeroHttpError && error.status === 401) {
        const second = await access(true)
        return http.accounting(second.accessToken, second.tenantId, method, path, options)
      }
      throw error
    }
  }

  /** Translate a Xero 400 ValidationException into our 422-shaped error. */
  const rethrowValidation = (error) => {
    if (error instanceof XeroHttpError && error.status === 400) {
      const messages = validationMessages(error.body)
      throw new XeroValidationError(
        messages.length ? `Xero refused it: ${messages.join('; ')}` : 'Xero refused the request.'
      )
    }
    throw error
  }

  // ---- connection lifecycle -------------------------------------------------

  const status = async () => {
    const connection = await loadConnection(pool)
    const connected =
      config.grantType === 'client_credentials'
        ? true // credentials ARE the connection; validated on first use
        : Boolean(connection?.token_set?.refresh_token)
    return {
      configured: true,
      grant_type: config.grantType,
      connected,
      tenant_id: connection?.tenant_id ?? null,
      org_name: connection?.org_name ?? null,
    }
  }

  const consentUrl = async () => {
    if (config.grantType === 'client_credentials') {
      throw new XeroConflictError(
        'This deployment uses a Xero custom connection — there is no consent step.'
      )
    }
    const state = crypto.randomBytes(16).toString('hex')
    await savePendingState(pool, state)
    const url = new URL(`${XERO_LOGIN_BASE}/identity/connect/authorize`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', config.redirectUri)
    url.searchParams.set('scope', config.scopes)
    url.searchParams.set('state', state)
    return url.toString()
  }

  const completeCallback = async ({ code, state }) => {
    const pending = await takePendingState(pool)
    // takePendingState both reads and clears: the nonce is single-use, so a
    // replayed callback finds nothing and stops here.
    if (!pending || pending !== state) {
      throw new XeroCallbackError('This sign-in link is stale — start again from Connect to Xero.')
    }
    const body = await http.tokenFromCode(code, config.redirectUri)
    const set = tokenSetFromResponse(body)
    const { tenantId, orgName } = await firstTenant(set.access_token)
    await saveTokenSet(pool, {
      grantType: 'authorization_code',
      tokenSet: set,
      tenantId,
      orgName,
    })
    return { tenantId, orgName }
  }

  const disconnect = async () => {
    ccCache = null
    await clearConnection(pool)
  }

  // ---- contacts -------------------------------------------------------------

  /**
   * Every contact in the org. `full` fetches the whole shape (addresses,
   * phones, flags) for the pull; the push only needs summaryOnly's name +
   * email to match on.
   */
  const fetchAllContacts = async ({ full = false } = {}) => {
    const all = []
    for (let page = 1; ; page += 1) {
      const body = await call('GET', 'Contacts', {
        query: {
          ...(full ? {} : { summaryOnly: 'true' }),
          page: String(page),
          pageSize: String(CONTACT_PAGE_SIZE),
        },
      })
      const contacts = body?.Contacts ?? []
      all.push(...contacts)
      if (contacts.length < CONTACT_PAGE_SIZE) break
    }
    return all
  }

  const lower = (v) => String(v ?? '').trim().toLowerCase()

  /** {email -> id} and {name -> id} maps over a contact list. */
  const contactDirectory = (contacts) => {
    const byEmail = new Map()
    const byName = new Map()
    for (const contact of contacts) {
      if (contact.EmailAddress && !byEmail.has(lower(contact.EmailAddress))) {
        byEmail.set(lower(contact.EmailAddress), contact.ContactID)
      }
      if (contact.Name && !byName.has(lower(contact.Name))) {
        byName.set(lower(contact.Name), contact.ContactID)
      }
    }
    return { byEmail, byName }
  }

  // The three tables that remember a Xero contact, one writer each. The
  // table name is a code literal here, never a caller's string.
  const storeContactIdIn = (table) => (rowId, contactId) =>
    pool.query(`UPDATE ${table} SET xero_contact_id = $2 WHERE id = $1`, [rowId, contactId])
  const storeContactId = storeContactIdIn('users')
  const storeTradeAccountContactId = storeContactIdIn('trade_accounts')
  const storeSupplierContactId = storeContactIdIn('suppliers')

  /** Create one contact, retrying a name collision with "Name (email)". */
  const createContact = async (payload, email) => {
    try {
      const body = await call('POST', 'Contacts', {
        body: { Contacts: [payload] },
        query: { summarizeErrors: 'true' },
      })
      return pickContact(body)
    } catch (error) {
      const taken =
        error instanceof XeroHttpError &&
        error.status === 400 &&
        validationMessages(error.body).some((m) => /already assigned|must be unique/i.test(m))
      if (!taken || !email) rethrowValidation(error)
      const body = await call('POST', 'Contacts', {
        body: { Contacts: [{ ...payload, Name: `${payload.Name} (${email})` }] },
        query: { summarizeErrors: 'true' },
      }).catch(rethrowValidation)
      return pickContact(body)
    }
  }

  /** searchTerm covers name AND email; exact-match the result locally. */
  const searchContact = async ({ email, name }) => {
    const term = email || name
    if (!term) return null
    const body = await call('GET', 'Contacts', {
      query: { searchTerm: term, summaryOnly: 'true' },
    })
    return matchContact(body?.Contacts ?? [], { email, name })
  }

  /** Match-or-create one row's contact and remember it. */
  const ensureContactFor = async ({ row, email, name, toPayload, store }) => {
    if (row.xero_contact_id) return row.xero_contact_id
    const found = await searchContact({ email, name })
    const contactId = found ?? (await createContact(toPayload(row), email))
    await store(row.id, contactId)
    return contactId
  }

  /** The company a login belongs to, if any (trade_account_users is 1:1 on user). */
  const tradeAccountForUser = async (userId) => {
    const { rows } = await pool.query(
      `SELECT ta.* FROM trade_accounts ta
         JOIN trade_account_users tau ON tau.trade_account_id = ta.id
        WHERE tau.user_id = $1 AND ta.archived_at IS NULL`,
      [userId]
    )
    return rows[0] ?? null
  }

  /**
   * The Xero contact an order invoices as: the client's COMPANY when the
   * login is filed under one (that is who Xero has always invoiced), else the
   * person; guest orders match-or-create by their email but have no row to
   * remember it on.
   */
  const ensureContactForOrder = async (order) => {
    if (order.user_id) {
      const { rows } = await pool.query(
        `SELECT id, name, email, xero_contact_id FROM users WHERE id = $1`,
        [order.user_id]
      )
      const user = rows[0]
      if (!user) throw new XeroConflictError('The account this order belongs to no longer exists.')
      const company = await tradeAccountForUser(user.id)
      if (company) {
        return ensureContactFor({
          row: company,
          email: company.email,
          name: company.legacy_customer_name,
          toPayload: contactForTradeAccount,
          store: storeTradeAccountContactId,
        })
      }
      return ensureContactFor({
        row: user,
        email: user.email,
        name: user.name,
        toPayload: contactForUser,
        store: storeContactId,
      })
    }
    if (!order.guest_email) {
      throw new XeroConflictError(
        'This order has no account and no contact email — nobody to invoice.'
      )
    }
    const found = await searchContact({ email: order.guest_email, name: order.guest_email })
    return (
      found ??
      createContact(
        contactForUser({ name: order.guest_email, email: order.guest_email }),
        order.guest_email
      )
    )
  }

  /** The Xero contact a bill from this house is raised against. */
  const ensureContactForSupplier = (supplier) =>
    ensureContactFor({
      row: supplier,
      email: supplier.po_email,
      name: supplier.name,
      toPayload: contactForSupplier,
      store: storeSupplierContactId,
    })

  /**
   * One client company as a Xero contact — matched (email, then exact name)
   * before it is created, and remembered on `trade_accounts.xero_contact_id`.
   * An approved trade application calls it, and the CRM's "Add to Xero" is the
   * retry. Returns the contact id; null for an unknown company.
   */
  const ensureTradeAccountContact = async (accountId) => {
    const { rows } = await pool.query(`SELECT * FROM trade_accounts WHERE id = $1`, [accountId])
    const company = rows[0]
    if (!company) return null
    return ensureContactFor({
      row: company,
      email: company.email,
      name: company.legacy_customer_name,
      toPayload: contactForTradeAccount,
      store: storeTradeAccountContactId,
    })
  }

  /**
   * Archive (`ARCHIVED`) or reactivate (`ACTIVE`) a contact in Xero — a client
   * who has cancelled is archived there as well as here.
   */
  const setContactStatus = async (contactId, status) => {
    await call('POST', `Contacts/${encodeURIComponent(contactId)}`, {
      body: { Contacts: [{ ContactID: contactId, ContactStatus: status }] },
    }).catch(rethrowValidation)
  }

  /**
   * Push one table's unlinked rows: link what the directory already holds
   * (email, then exact name), create the rest in batches, remember every id.
   * `rows` carry `id`, `email`, `name` for matching; `toPayload` shapes the
   * create; `failed` entries are keyed by `key(row)`.
   */
  const pushContacts = async ({ rows, directory, toPayload, store, key }) => {
    const toCreate = []
    let linked = 0
    for (const row of rows) {
      const existing =
        (row.email ? directory.byEmail.get(lower(row.email)) : null) ??
        directory.byName.get(lower(row.name))
      if (existing) {
        await store(row.id, existing)
        linked += 1
      } else {
        toCreate.push(row)
      }
    }

    let created = 0
    const failed = []
    for (let i = 0; i < toCreate.length; i += UPSERT_BATCH_SIZE) {
      const batch = toCreate.slice(i, i + UPSERT_BATCH_SIZE)
      let body
      try {
        // summarizeErrors=false answers per-element in request order, so one
        // bad row fails alone instead of sinking its whole batch.
        body = await call('POST', 'Contacts', {
          body: { Contacts: batch.map(toPayload) },
          query: { summarizeErrors: 'false' },
        })
      } catch (error) {
        const messages = validationMessages(error instanceof XeroHttpError ? error.body : null)
        for (const row of batch) {
          failed.push({ key: key(row), message: messages.join('; ') || 'batch refused' })
        }
        continue
      }
      const answers = body?.Contacts ?? []
      for (let j = 0; j < batch.length; j += 1) {
        const answer = answers[j]
        const errors = (answer?.ValidationErrors ?? []).map((v) => v.Message).filter(Boolean)
        if (answer?.ContactID && errors.length === 0) {
          await store(batch[j].id, answer.ContactID)
          created += 1
        } else {
          failed.push({ key: key(batch[j]), message: errors.join('; ') || 'not created' })
        }
      }
    }
    return { linked, created, failed }
  }

  const sumResults = (results) => ({
    linked: results.reduce((n, r) => n + r.linked, 0),
    created: results.reduce((n, r) => n + r.created, 0),
    failed: results.flatMap((r) => r.failed),
  })

  /**
   * Customers → Xero: every unlinked client company, plus every unlinked
   * client login that is NOT filed under a company (a person at a company
   * invoices as the company, so they get no contact of their own).
   */
  const syncContacts = async () => {
    const { rows: companies } = await pool.query(
      `SELECT * FROM trade_accounts
        WHERE archived_at IS NULL AND xero_contact_id IS NULL
        ORDER BY id`
    )
    const { rows: people } = await pool.query(
      `SELECT id, name, email FROM users u
        WHERE role IN ('customer', 'trade')
          AND archived_at IS NULL
          AND xero_contact_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM trade_account_users tau WHERE tau.user_id = u.id)
        ORDER BY id`
    )
    if (companies.length === 0 && people.length === 0) return { linked: 0, created: 0, failed: [] }

    const directory = contactDirectory(await fetchAllContacts())
    return sumResults([
      await pushContacts({
        rows: companies.map((c) => ({ ...c, name: c.legacy_customer_name })),
        directory,
        toPayload: contactForTradeAccount,
        store: storeTradeAccountContactId,
        key: (c) => c.legacy_customer_name,
      }),
      await pushContacts({
        rows: people,
        directory,
        toPayload: contactForUser,
        store: storeContactId,
        key: (u) => u.email,
      }),
    ])
  }

  /** Suppliers → Xero contacts flagged IsSupplier. Match on po_email, then name. */
  const syncSuppliers = async () => {
    const { rows: suppliers } = await pool.query(
      `SELECT * FROM suppliers
        WHERE archived_at IS NULL AND xero_contact_id IS NULL
        ORDER BY id`
    )
    if (suppliers.length === 0) return { linked: 0, created: 0, failed: [] }
    const directory = contactDirectory(await fetchAllContacts())
    return pushContacts({
      rows: suppliers.map((s) => ({ ...s, email: s.po_email })),
      directory,
      toPayload: contactForSupplier,
      store: storeSupplierContactId,
      key: (s) => s.name,
    })
  }

  /** Fill without blanking: COALESCE(Xero's value, ours). True when a row took it. */
  const refreshCompany = async (details) => {
    const { rowCount } = await pool.query(
      `UPDATE trade_accounts
          SET email = COALESCE($2, email), phone = COALESCE($3, phone),
              address = COALESCE($4, address), city = COALESCE($5, city),
              country = COALESCE($6, country), updated_at = now()
        WHERE xero_contact_id = $1`,
      [details.xero_contact_id, details.email, details.phone, details.address, details.city, details.country]
    )
    return rowCount > 0
  }

  const refreshSupplier = async (details) => {
    const { rowCount } = await pool.query(
      `UPDATE suppliers
          SET po_email = COALESCE($2, po_email), phone = COALESCE($3, phone),
              address = COALESCE($4, address), country = COALESCE($5, country),
              currency = COALESCE($6, currency), updated_at = now()
        WHERE xero_contact_id = $1`,
      [details.xero_contact_id, details.email, details.phone, details.address, details.country, details.currency]
    )
    return rowCount > 0
  }

  const refreshPerson = async (details) => {
    const { rowCount } = await pool.query(
      `UPDATE users SET phone = COALESCE($2, phone) WHERE xero_contact_id = $1`,
      [details.xero_contact_id, details.phone]
    )
    return rowCount > 0
  }

  /** An unlinked row of ours this contact is, by email then exact name. */
  const findUnlinked = async (table, emailColumn, nameColumn, details) => {
    // A null on either side matches nothing: `= NULL` is never true in SQL.
    const { rows } = await pool.query(
      `SELECT id FROM ${table}
        WHERE xero_contact_id IS NULL AND archived_at IS NULL
          AND (lower(${emailColumn}) = $1::text OR lower(${nameColumn}) = $2::text)
        ORDER BY (lower(${emailColumn}) = $1::text) DESC NULLS LAST, id LIMIT 1`,
      [lower(details.email) || null, lower(details.name) || null]
    )
    return rows[0]?.id ?? null
  }

  /** Where one pulled contact lands; the counters it bumps. False when nowhere. */
  const placePulledContact = async (details, result) => {
    // Already linked somewhere → refresh details there.
    const refreshed = [
      (await refreshCompany(details)) && (result.companies.updated += 1),
      (await refreshSupplier(details)) && (result.suppliers.updated += 1),
      (await refreshPerson(details)) && (result.people.updated += 1),
    ].some(Boolean)
    if (refreshed) return true

    // Unlinked in Xero's eyes — link an unlinked row of ours before creating.
    const companyId = await findUnlinked('trade_accounts', 'email', 'legacy_customer_name', details)
    if (companyId) {
      await storeTradeAccountContactId(companyId, details.xero_contact_id)
      await refreshCompany(details)
      result.companies.linked += 1
    }
    const supplierId = await findUnlinked('suppliers', 'po_email', 'name', details)
    if (supplierId) {
      await storeSupplierContactId(supplierId, details.xero_contact_id)
      await refreshSupplier(details)
      result.suppliers.linked += 1
    }
    if (companyId || supplierId) return true

    if (!details.name) return false
    if (details.is_customer) {
      await createTradeAccount(pool, {
        company_name: details.name,
        email: details.email,
        phone: details.phone,
        address: details.address,
        city: details.city,
        country: details.country,
        xero_contact_id: details.xero_contact_id,
      })
      result.companies.created += 1
    }
    if (details.is_supplier) {
      const created = await createSupplier(pool, {
        name: details.name,
        po_email: details.email,
        phone: details.phone,
        address: details.address,
        country: details.country,
        currency: details.currency,
      })
      await storeSupplierContactId(created.id, details.xero_contact_id)
      result.suppliers.created += 1
    }
    return details.is_customer || details.is_supplier
  }

  /**
   * Xero → platform. Every ACTIVE Xero contact lands somewhere:
   *   - already linked (by id, in any of the three tables) → details
   *     refreshed from Xero where Xero holds a value. Names are NEVER changed
   *     here — `trade_accounts.legacy_customer_name` is what the client
   *     portal matches invoice history on.
   *   - unlinked, matching an unlinked row by email or exact name → linked.
   *   - unlinked, IsCustomer → a new client company; IsSupplier → a new
   *     supplier; both → both. Neither (a contact nothing has been raised
   *     against yet in Xero) → skipped and counted, not guessed at.
   */
  const pullContacts = async () => {
    const contacts = await fetchAllContacts({ full: true })
    const active = contacts.filter((c) => (c.ContactStatus ?? 'ACTIVE') === 'ACTIVE')
    const result = {
      seen: active.length,
      companies: { updated: 0, linked: 0, created: 0 },
      suppliers: { updated: 0, linked: 0, created: 0 },
      people: { updated: 0 },
      skipped: 0,
      failed: [],
    }
    for (const contact of active) {
      const details = contactDetailsFromXero(contact)
      try {
        if (!(await placePulledContact(details, result))) result.skipped += 1
      } catch (error) {
        result.failed.push({ key: details.name ?? details.xero_contact_id, message: error.message })
      }
    }
    return result
  }

  // ---- items ----------------------------------------------------------------

  const syncItems = async () => {
    const { rows } = await pool.query(
      `SELECT c.sku, c.name AS colourway_name, p.name AS product_name
         FROM colourways c
         JOIN products p ON p.id = c.product_id
        WHERE c.archived_at IS NULL AND p.archived_at IS NULL
        ORDER BY c.sku`
    )
    let pushed = 0
    const failed = []
    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + UPSERT_BATCH_SIZE)
      let body
      try {
        // POST /Items upserts on Code (= SKU), so re-running the sync is a
        // refresh, never a duplicate.
        body = await call('POST', 'Items', {
          body: { Items: batch.map(itemForColourway) },
          query: { summarizeErrors: 'false' },
        })
      } catch (error) {
        const messages = validationMessages(error instanceof XeroHttpError ? error.body : null)
        for (const row of batch) {
          failed.push({ sku: row.sku, message: messages.join('; ') || 'batch refused' })
        }
        continue
      }
      const answers = body?.Items ?? []
      for (let j = 0; j < batch.length; j += 1) {
        const errors = (answers[j]?.ValidationErrors ?? []).map((v) => v.Message).filter(Boolean)
        if (errors.length === 0) pushed += 1
        else failed.push({ sku: batch[j].sku, message: errors.join('; ') })
      }
    }
    return { pushed, failed }
  }

  // ---- invoices -------------------------------------------------------------

  const pushOrderInvoice = async (
    orderId,
    { email: sendEmail = false, actor = { kind: 'xero' } } = {}
  ) => {
    const order = await getAdminOrder(pool, orderId)
    if (!order) return null // route answers 404
    // A quote the client has not accepted is not awaiting an invoice, and a
    // cancelled or refunded order never will be (INVOICEABLE_STATUSES).
    if (!INVOICEABLE_STATUSES.includes(order.status)) {
      throw new XeroConflictError(`An order in status "${order.status}" is not invoiceable.`)
    }
    // A pushed invoice is the duplicate gate — unless the last pull saw Xero
    // void or delete it, in which case the office may push a corrected one.
    // The dead id rides in the idempotency key so Xero does not hand the
    // voided invoice back as "the same request".
    const previous = order.xero_invoice_id && isDeadInXero(order.xero_invoice_status)
      ? order.xero_invoice_id
      : null
    if (order.xero_invoice_id && !previous) {
      throw new XeroConflictError(
        `This order is already in Xero as ${order.xero_invoice_ref ?? order.xero_invoice_id}.`
      )
    }
    // Same predicate `confirm` uses: a positive total with one $0.00 line
    // would otherwise reach Xero as a nil line. The total clause stays for
    // the one case the lines cannot catch — a 100% discount.
    const unpriced = unpricedLineCount(order.lines)
    if (unpriced > 0) {
      throw new XeroConflictError(
        `Price every line before invoicing — ${unpriced} line${unpriced === 1 ? ' is' : 's are'} still at $0.00.`
      )
    }
    if (Number(order.total_cents) <= 0) {
      throw new XeroConflictError('Price the order before invoicing — its total is still zero.')
    }

    const contactId = await ensureContactForOrder(order)
    const payload = invoiceForOrder(order, {
      contactId,
      accountCode: config.salesAccountCode,
      lineAmountTypes: config.lineAmountTypes,
      status: config.invoiceStatus,
      dueDays: config.invoiceDueDays,
    })
    const body = await call('POST', 'Invoices', {
      body: { Invoices: [payload] },
      query: { summarizeErrors: 'true' },
      // The idempotency key makes a double-click or a retry return the SAME
      // invoice — Xero-side insurance on top of our xero_invoice_id gate.
      idempotencyKey: previous ? `atelier-order-${orderId}-after-${previous}` : `atelier-order-${orderId}`,
    }).catch(rethrowValidation)

    const invoice = pickInvoice(body)
    if (!invoice) throw new XeroValidationError('Xero answered without an invoice — nothing stored.')

    // The WHERE guards a concurrent push; thanks to the idempotency key both
    // racers hold the same invoice, so losing the write changes nothing.
    await pool.query(
      `UPDATE orders
          SET xero_invoice_id = $2,
              xero_invoice_ref = COALESCE($3, xero_invoice_ref),
              xero_invoice_status = $4
        WHERE id = $1 AND xero_invoice_id IS NOT DISTINCT FROM $5`,
      [orderId, invoice.invoiceId, invoice.invoiceNumber, invoice.status, previous]
    )

    let emailed = false
    let warning = null

    // The invoice exists, so the order is waiting on payment: the push makes
    // the `pending_payment` move itself (with its letter) rather than leaving
    // the office to remember it. An order that cannot take the move — already
    // pending, or paid and beyond — keeps its status; the paid branch below
    // records the payment instead. Like the payment, a refused move is a
    // warning on a push that succeeded, never a rollback of it.
    if (canTransition(order.status, 'pending_payment')) {
      try {
        const moved = await setOrderStatus(pool, orderId, 'pending_payment', { actor })
        await notifyOrderTransition(moved)
      } catch (error) {
        warning = `Invoice created but the order did not move to pending payment: ${error.message}`
      }
    }

    if (sendEmail) {
      // Xero sends its own branded invoice email to the contact. Only an
      // AUTHORISED invoice can be emailed; a DRAFT deployment answers with a
      // warning rather than an error — the push itself succeeded.
      try {
        await call('POST', `Invoices/${invoice.invoiceId}/Email`, { body: {} })
        emailed = true
      } catch (error) {
        warning =
          error instanceof XeroHttpError
            ? `Invoice created but Xero did not email it: ${validationMessages(error.body).join('; ') || `status ${error.status}`}`
            : `Invoice created but Xero did not email it.`
      }
    }

    // A card checkout arrives already paid, and an order can be marked paid
    // before anyone pushes it — either way the invoice must not sit AUTHORISED
    // and unpaid in Xero for money the platform already holds. Recorded here
    // rather than left to the office to remember; a failure is a warning on a
    // push that succeeded, never a rollback of it.
    let payment = null
    if (PAID_STATUSES.includes(order.status)) {
      payment = await recordOrderPayment(orderId).catch((error) => ({
        recorded: false,
        reason: paymentFailureReason(error),
      }))
      if (!payment.recorded && !warning) warning = `Invoice created but not marked paid: ${payment.reason}`
    }

    return {
      order: await getAdminOrder(pool, orderId),
      invoice: { id: invoice.invoiceId, number: invoice.invoiceNumber },
      emailed,
      ...(payment ? { payment } : {}),
      ...(warning ? { warning } : {}),
    }
  }

  /**
   * Mark the order's Xero invoice PAID by recording a Payment against it for
   * exactly what Xero says is still due. Answers `{ recorded, reason? }` rather
   * than throwing for the three ordinary non-events — no invoice pushed yet, no
   * bank account configured, nothing outstanding — because none of them is a
   * reason to refuse the order transition that asked for it. Xero refusing the
   * payment IS thrown, so the caller can report it in its own words.
   *
   * Idempotent by construction: the amount is Xero's own AmountDue, so a second
   * call finds zero due and records nothing.
   */
  const recordOrderPayment = async (orderId) => {
    const order = await getAdminOrder(pool, orderId)
    if (!order) return null // route answers 404
    if (!order.xero_invoice_id) {
      return { recorded: false, reason: 'this order has no invoice in Xero yet.' }
    }
    if (!config.paymentAccountCode) {
      return {
        recorded: false,
        reason: 'XERO_PAYMENT_ACCOUNT_CODE is not set on the API, so payments are recorded in Xero by hand.',
      }
    }
    const read = await call('GET', `Invoices/${order.xero_invoice_id}`, {}).catch(rethrowValidation)
    const invoice = read?.Invoices?.[0] ?? null
    if (!invoice) throw new XeroValidationError('Xero answered without the invoice — nothing recorded.')
    const amountDue = Number(invoice.AmountDue ?? 0)
    if (!(amountDue > 0)) {
      return { recorded: false, reason: `${invoice.InvoiceNumber ?? 'the invoice'} is already paid in Xero.` }
    }
    const body = await call('PUT', 'Payments', {
      body: {
        Payments: [
          paymentForInvoice({
            invoiceId: order.xero_invoice_id,
            accountCode: config.paymentAccountCode,
            amount: amountDue,
            now: () => new Date(now()),
          }),
        ],
      },
      query: { summarizeErrors: 'true' },
      idempotencyKey: `atelier-order-${orderId}-payment`,
    }).catch(rethrowValidation)
    const paymentId = body?.Payments?.[0]?.PaymentID ?? null
    return { recorded: true, amount: amountDue, payment_id: paymentId, invoice_number: invoice.InvoiceNumber ?? null }
  }

  // ---- bills (purchase orders) ---------------------------------------------

  /**
   * Push a purchase order to Xero as an ACCPAY bill against its supplier.
   * Idempotent at both ends like the invoice push: `Idempotency-Key
   * atelier-po-<id>` at Xero, `purchase_orders.xero_bill_id` here (409 on a
   * second push) — unless Xero has since VOIDED/DELETED that bill, in which
   * case a fresh push is allowed under a fresh key. Every line must be priced:
   * an unpriced line would reach Xero as a nil amount, and a bill is what the
   * accountant pays against. Read with `finance: true` — a bill carries prices
   * whoever pressed the button; the purchase order handed BACK is read with
   * the caller's own grant, so a masked login stays masked.
   */
  const pushPurchaseOrderBill = async (purchaseOrderId, { finance = false } = {}) => {
    const order = await getPurchaseOrder(pool, purchaseOrderId, { finance: true })
    if (!order) return null // route answers 404
    if (order.status === 'cancelled') {
      throw new XeroConflictError('A cancelled purchase order is not billable.')
    }
    const previous =
      order.xero_bill_id && isDeadInXero(order.xero_bill_status) ? order.xero_bill_id : null
    if (order.xero_bill_id && !previous) {
      throw new XeroConflictError(
        `This purchase order is already in Xero as ${order.xero_bill_ref ?? order.xero_bill_id}.`
      )
    }
    if (order.lines.length === 0) {
      throw new XeroConflictError('This purchase order has no lines to bill.')
    }
    if (order.unpriced_lines > 0) {
      throw new XeroConflictError(
        `Price every line before billing — ${order.unpriced_lines} line${order.unpriced_lines === 1 ? ' is' : 's are'} unpriced.`
      )
    }
    if (!order.supplier_id) {
      throw new XeroConflictError('This purchase order names no supplier to bill against.')
    }

    const supplier = await getSupplier(pool, order.supplier_id)
    if (!supplier) throw new XeroConflictError('The house this purchase order is addressed to no longer exists.')
    const contactId = await ensureContactForSupplier(supplier)
    const payload = billForPurchaseOrder(order, {
      contactId,
      accountCode: config.purchasesAccountCode,
      lineAmountTypes: config.lineAmountTypes,
      status: config.billStatus,
      dueDays: config.invoiceDueDays,
      now: () => new Date(now()),
    })
    const body = await call('POST', 'Invoices', {
      body: { Invoices: [payload] },
      query: { summarizeErrors: 'true' },
      idempotencyKey: previous
        ? `atelier-po-${purchaseOrderId}-after-${previous}`
        : `atelier-po-${purchaseOrderId}`,
    }).catch(rethrowValidation)
    const bill = pickInvoice(body)
    if (!bill) throw new XeroValidationError('Xero answered without a bill — nothing stored.')
    const state = billStateFrom(body?.Invoices?.[0])

    await pool.query(
      `UPDATE purchase_orders
          SET xero_bill_id = $2, xero_bill_ref = $3, xero_bill_status = $4, xero_bill_paid_at = $5,
              updated_at = now()
        WHERE id = $1 AND xero_bill_id IS NOT DISTINCT FROM $6`,
      [purchaseOrderId, bill.invoiceId, bill.invoiceNumber, state.status, state.paidAt, previous]
    )
    return {
      purchase_order: await getPurchaseOrder(pool, purchaseOrderId, { finance }),
      bill: { id: bill.invoiceId, number: bill.invoiceNumber, status: state.status },
    }
  }

  /**
   * Store Xero's word for a bill on its purchase order (Status, the day it
   * was fully paid, the number). Xero saying PAID moves the order's own status
   * to `paid` where the machine allows it (sent or closed); a draft with a
   * bill, or an order already paid, is left where it is — the mirror columns
   * still say what Xero said. Shared by the on-demand sync and the pull.
   */
  const mirrorBillState = async (order, bill) => {
    const state = billStateFrom(bill)
    await pool.query(
      `UPDATE purchase_orders
          SET xero_bill_status = $2, xero_bill_paid_at = $3,
              xero_bill_ref = COALESCE($4, xero_bill_ref), updated_at = now()
        WHERE id = $1`,
      [order.id, state.status, state.paidAt, bill.InvoiceNumber ?? null]
    )
    if (state.status === 'PAID' && SOURCE_STATUSES.paid.includes(order.status)) {
      await payPurchaseOrder(pool, order.id)
    }
    return state
  }

  /**
   * Re-read the bill from Xero and mirror its Status / FullyPaidOnDate onto
   * the purchase order. This is how "paid in Xero" reaches the CRM — a poll on
   * demand, no webhook. Answers null for an unknown order and `{ synced: false }`
   * for one with no bill; both are non-events, not refusals.
   */
  const syncPurchaseOrderBill = async (purchaseOrderId, { finance = false } = {}) => {
    const order = await getPurchaseOrder(pool, purchaseOrderId, { finance })
    if (!order) return null
    if (!order.xero_bill_id) return { synced: false, reason: 'this purchase order has no bill in Xero yet.' }
    const read = await call('GET', `Invoices/${order.xero_bill_id}`, {}).catch(rethrowValidation)
    const bill = read?.Invoices?.[0] ?? null
    if (!bill) throw new XeroValidationError('Xero answered without the bill — nothing stored.')
    const state = await mirrorBillState(order, bill)
    return {
      synced: true,
      bill: { id: order.xero_bill_id, number: bill.InvoiceNumber ?? order.xero_bill_ref, status: state.status, paid_at: state.paidAt },
      purchase_order: await getPurchaseOrder(pool, purchaseOrderId, { finance }),
    }
  }

  // ---- the pull: what Xero says about what we pushed -----------------------

  const STATUS_BATCH = 40
  const SETTLED = ['PAID', 'VOIDED', 'DELETED']

  /** {InvoiceID -> {Status, InvoiceNumber}} for a set of ids, in batches. */
  const fetchInvoiceStatuses = async (ids) => {
    const out = new Map()
    for (let i = 0; i < ids.length; i += STATUS_BATCH) {
      const batch = ids.slice(i, i + STATUS_BATCH)
      const body = await call('GET', 'Invoices', {
        query: { IDs: batch.join(','), summaryOnly: 'true', pageSize: String(STATUS_BATCH) },
      })
      for (const invoice of body?.Invoices ?? []) {
        if (invoice?.InvoiceID) out.set(invoice.InvoiceID, invoice)
      }
    }
    return out
  }

  /**
   * Xero → platform for invoices and bills. Reads the status of every pushed
   * document that is not yet settled (PAID / VOIDED / DELETED are terminal)
   * and stores Xero's word for it. An invoice Xero shows PAID marks its
   * order paid here — the same move the CRM's status dropdown makes, with the
   * same letter — so a payment recorded at the accountant's desk reaches the
   * order desk without anyone re-keying it. An order the machine will not move
   * to `paid` (a quote, a cancelled order) is reported, not forced; one that is
   * already paid or beyond is left alone.
   */
  const pullStatuses = async () => {
    const result = {
      invoices: { checked: 0, updated: 0, orders_marked_paid: [], failed: [] },
      bills: { checked: 0, updated: 0, failed: [] },
    }

    const { rows: orders } = await pool.query(
      `SELECT id, order_number, status, xero_invoice_id, xero_invoice_status FROM orders
        WHERE xero_invoice_id IS NOT NULL
          AND (xero_invoice_status IS NULL OR xero_invoice_status <> ALL($1::text[]))
        ORDER BY id`,
      [SETTLED]
    )
    result.invoices.checked = orders.length
    const invoices = await fetchInvoiceStatuses(orders.map((o) => o.xero_invoice_id))
    for (const order of orders) {
      const invoice = invoices.get(order.xero_invoice_id)
      const status = invoice?.Status ?? null
      if (!status || status === order.xero_invoice_status) continue
      await pool.query(
        `UPDATE orders SET xero_invoice_status = $2, xero_invoice_ref = COALESCE($3, xero_invoice_ref) WHERE id = $1`,
        [order.id, status, invoice.InvoiceNumber ?? null]
      )
      result.invoices.updated += 1
      if (status !== 'PAID' || PAID_STATUSES.includes(order.status)) continue
      if (!canTransition(order.status, 'paid')) {
        result.invoices.failed.push({
          key: order.order_number,
          message: `paid in Xero but "${order.status}" here cannot be marked paid — move it on, then mark it paid.`,
        })
        continue
      }
      try {
        const paid = await markOrderPaid(pool, order.id, { kind: 'xero' })
        await notifyOrderTransition(paid)
        result.invoices.orders_marked_paid.push({ id: order.id, order_number: order.order_number })
      } catch (error) {
        result.invoices.failed.push({ key: order.order_number, message: error.message })
      }
    }

    const { rows: purchaseOrders } = await pool.query(
      `SELECT id, po_number, status, xero_bill_id, xero_bill_status FROM purchase_orders
        WHERE xero_bill_id IS NOT NULL
          AND (xero_bill_status IS NULL OR xero_bill_status <> ALL($1::text[]))
        ORDER BY id`,
      [SETTLED]
    )
    result.bills.checked = purchaseOrders.length
    const bills = await fetchInvoiceStatuses(purchaseOrders.map((po) => po.xero_bill_id))
    for (const purchaseOrder of purchaseOrders) {
      const bill = bills.get(purchaseOrder.xero_bill_id)
      const status = bill?.Status ?? null
      if (!status || status === purchaseOrder.xero_bill_status) continue
      try {
        await mirrorBillState(purchaseOrder, bill)
        result.bills.updated += 1
      } catch (error) {
        result.bills.failed.push({ key: purchaseOrder.po_number, message: error.message })
      }
    }
    return result
  }

  /** The whole Xero → platform direction in one call (the scheduled pull). */
  const pullAll = async () => ({
    contacts: await pullContacts(),
    ...(await pullStatuses()),
  })

  return {
    isConfigured: true,
    grantType: config.grantType,
    status,
    consentUrl,
    completeCallback,
    disconnect,
    syncContacts,
    syncSuppliers,
    syncItems,
    ensureTradeAccountContact,
    setContactStatus,
    pushOrderInvoice,
    recordOrderPayment,
    pushPurchaseOrderBill,
    syncPurchaseOrderBill,
    pullContacts,
    pullStatuses,
    pullAll,
  }
}
