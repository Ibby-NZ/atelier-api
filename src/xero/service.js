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
import { getAdminOrder } from '../orders/admin-orders.js'
import { unpricedLineCount } from '../orders/order-states.js'
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
  contactForUser,
  invoiceForOrder,
  itemForColourway,
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

/** A push refused by our own rules (already pushed, declined, unpriced). */
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

export const createXeroService = ({ pool, config, http, now = () => Date.now() }) => {
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

  /** Every contact in the org, as {email -> id} and {name -> id} maps. */
  const fetchContactDirectory = async () => {
    const byEmail = new Map()
    const byName = new Map()
    const lower = (v) => String(v ?? '').trim().toLowerCase()
    for (let page = 1; ; page += 1) {
      const body = await call('GET', 'Contacts', {
        query: { summaryOnly: 'true', page: String(page), pageSize: String(CONTACT_PAGE_SIZE) },
      })
      const contacts = body?.Contacts ?? []
      for (const contact of contacts) {
        if (contact.EmailAddress && !byEmail.has(lower(contact.EmailAddress))) {
          byEmail.set(lower(contact.EmailAddress), contact.ContactID)
        }
        if (contact.Name && !byName.has(lower(contact.Name))) {
          byName.set(lower(contact.Name), contact.ContactID)
        }
      }
      if (contacts.length < CONTACT_PAGE_SIZE) break
    }
    return { byEmail, byName, lower }
  }

  const storeContactId = (userId, contactId) =>
    pool.query(`UPDATE users SET xero_contact_id = $2 WHERE id = $1`, [userId, contactId])

  /** Create one contact, retrying a name collision with "Name (email)". */
  const createContact = async (person) => {
    const payload = contactForUser(person)
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
      if (!taken || !person.email) rethrowValidation(error)
      const body = await call('POST', 'Contacts', {
        body: { Contacts: [{ ...payload, Name: `${payload.Name} (${person.email})` }] },
        query: { summarizeErrors: 'true' },
      }).catch(rethrowValidation)
      return pickContact(body)
    }
  }

  /**
   * The Xero contact an order invoices as. Account orders link (and remember)
   * users.xero_contact_id; guest orders match-or-create by their email but
   * have no row to remember it on.
   */
  const ensureContactForOrder = async (order) => {
    if (order.user_id) {
      const { rows } = await pool.query(
        `SELECT id, name, email, xero_contact_id FROM users WHERE id = $1`,
        [order.user_id]
      )
      const user = rows[0]
      if (!user) throw new XeroConflictError('The account this order belongs to no longer exists.')
      if (user.xero_contact_id) return user.xero_contact_id
      const found = await searchContact({ email: user.email, name: user.name })
      const contactId = found ?? (await createContact({ name: user.name, email: user.email }))
      await storeContactId(user.id, contactId)
      return contactId
    }
    if (!order.guest_email) {
      throw new XeroConflictError(
        'This order has no account and no contact email — nobody to invoice.'
      )
    }
    const found = await searchContact({ email: order.guest_email, name: order.guest_email })
    return found ?? createContact({ name: order.guest_email, email: order.guest_email })
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

  const syncContacts = async () => {
    const { rows: users } = await pool.query(
      `SELECT id, name, email FROM users
        WHERE role IN ('customer', 'trade')
          AND archived_at IS NULL
          AND xero_contact_id IS NULL
        ORDER BY id`
    )
    if (users.length === 0) return { linked: 0, created: 0, failed: [] }

    const directory = await fetchContactDirectory()
    const toCreate = []
    let linked = 0
    for (const user of users) {
      const existing =
        directory.byEmail.get(directory.lower(user.email)) ??
        directory.byName.get(directory.lower(user.name))
      if (existing) {
        await storeContactId(user.id, existing)
        linked += 1
      } else {
        toCreate.push(user)
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
          body: { Contacts: batch.map(contactForUser) },
          query: { summarizeErrors: 'false' },
        })
      } catch (error) {
        const messages = validationMessages(error instanceof XeroHttpError ? error.body : null)
        for (const user of batch) {
          failed.push({ email: user.email, message: messages.join('; ') || 'batch refused' })
        }
        continue
      }
      const answers = body?.Contacts ?? []
      for (let j = 0; j < batch.length; j += 1) {
        const answer = answers[j]
        const errors = (answer?.ValidationErrors ?? []).map((v) => v.Message).filter(Boolean)
        if (answer?.ContactID && errors.length === 0) {
          await storeContactId(batch[j].id, answer.ContactID)
          created += 1
        } else {
          failed.push({ email: batch[j].email, message: errors.join('; ') || 'not created' })
        }
      }
    }
    return { linked, created, failed }
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

  const pushOrderInvoice = async (orderId, { email: sendEmail = false } = {}) => {
    const order = await getAdminOrder(pool, orderId)
    if (!order) return null // route answers 404
    if (order.status === 'declined') {
      throw new XeroConflictError('A declined order is not invoiceable.')
    }
    if (order.xero_invoice_id) {
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
      idempotencyKey: `atelier-order-${orderId}`,
    }).catch(rethrowValidation)

    const invoice = pickInvoice(body)
    if (!invoice) throw new XeroValidationError('Xero answered without an invoice — nothing stored.')

    // The WHERE guards a concurrent push; thanks to the idempotency key both
    // racers hold the same invoice, so losing the write changes nothing.
    await pool.query(
      `UPDATE orders
          SET xero_invoice_id = $2,
              xero_invoice_ref = COALESCE($3, xero_invoice_ref)
        WHERE id = $1 AND xero_invoice_id IS NULL`,
      [orderId, invoice.invoiceId, invoice.invoiceNumber]
    )

    let emailed = false
    let warning = null
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

    return {
      order: await getAdminOrder(pool, orderId),
      invoice: { id: invoice.invoiceId, number: invoice.invoiceNumber },
      emailed,
      ...(warning ? { warning } : {}),
    }
  }

  return {
    isConfigured: true,
    grantType: config.grantType,
    status,
    consentUrl,
    completeCallback,
    disconnect,
    syncContacts,
    syncItems,
    pushOrderInvoice,
  }
}
