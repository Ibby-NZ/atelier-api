// Order-request and backorder flow (US-012, FR-5/FR-6).
//
// A customer (or guest) asks the back office to cut and invoice fabric. Nothing
// is charged here — the request records lines with cut requirements, reserves
// stock, and waits for manual back-office verification (US-014). Pricing is
// deliberately left at 0: the invoice amount is set by the back office at
// confirmation, not by the client.
//
// Availability decides the kind:
//   - every line in stock            -> kind = 'order_request'
//   - any line short on stock        -> kind = 'backorder_request', and the
//                                       caller must pass accepted_lead_time=true
//                                       (otherwise 422 — they haven't agreed to
//                                       wait for the backorder).
// Stock is reserved (qty_reserved incremented) in the same transaction so two
// concurrent requests can't both claim the same metres.

import { randomUUID } from 'node:crypto'
import { canSeeTradeCatalogue, LISTED_SKU_CONDITION } from '../catalogue/visibility.js'

// Mirror of the auth EMAIL_PATTERN — Fastify's Ajv has no email format, so the
// 422 field-level check is hand-rolled here.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// Throw an Error whose statusCode Fastify will honour on the reply.
const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * Field-level input validation that returns 422 messages (schema violations are
 * 400; these business rules — qty > 0, a valid email — return 422 per the story).
 *
 * @param {{ lines: Array<{ qty_metres?: number }>, contact?: { email?: string } }} body
 * @param {{ hasUser: boolean }} ctx
 * @returns {Array<{ field: string, message: string }>} empty when valid
 */
export const validateOrderRequestInput = (body, { hasUser }) => {
  const errors = []

  body.lines.forEach((line, index) => {
    const qty = line.qty_metres
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) {
      errors.push({
        field: `lines[${index}].qty_metres`,
        message: 'Quantity must be a number greater than 0.',
      })
    }
  })

  const email = body.contact?.email
  if (email !== undefined && email !== null && email !== '') {
    if (!EMAIL_RE.test(email)) {
      errors.push({ field: 'contact.email', message: 'A valid email is required.' })
    }
  } else if (!hasUser) {
    // Guests have no session to fall back on — they must supply an email.
    errors.push({
      field: 'contact.email',
      message: 'An email address is required to place a request as a guest.',
    })
  }

  return errors
}

/**
 * Pack a guest's contact details into the one line `orders.notes` carries.
 *
 * Exported so the back office's manual create writes the SAME shape — the CRM
 * renders `notes` verbatim, and a second spelling of "who this is for" would be
 * two things for a person to read instead of one.
 *
 * @param {{ name?: string, email?: string, phone?: string }} [contact]
 * @param {string} [fallbackEmail]  the signed-in user's address, when there is one
 * @returns {string|null}
 */
export const buildNotes = (contact, fallbackEmail) => {
  const parts = []
  if (contact?.name) parts.push(`Name: ${contact.name}`)
  const email = contact?.email ?? fallbackEmail
  if (email) parts.push(`Email: ${email}`)
  if (contact?.phone) parts.push(`Phone: ${contact.phone}`)
  return parts.length > 0 ? parts.join(' | ') : null
}

// Resolve one requested SKU inside the transaction, locking the colourway row
// (FOR UPDATE OF c — the inventory row is the nullable side of the LEFT JOIN and
// can't be locked) so concurrent requests for the same SKU serialise their
// read-then-reserve. Throws 422 when the SKU isn't a listed product.
//
// `LISTED_SKU_CONDITION` is the published-and-unarchived gate the public read
// models apply. Archiving a house does NOT unpublish its products, so without it
// a departed maison's SKU 404s on the storefront and still reserves stock here.
//
// `includeTradeOnly` mirrors the catalogue gate: cutting metres off a
// represented house's roll is a trade transaction, so a signed-out visitor can
// only request from the houses they can browse. This DOES narrow the guest
// order-request flow (FR-5/FR-6) to the open houses — deliberately: a guest who
// cannot see a design has no legitimate way to have its SKU. Same 422 text as an
// unknown SKU, so the refusal confirms nothing about what exists — including
// whether the house has left.
const resolveLine = async (client, line, includeTradeOnly) => {
  const { rows } = await client.query(
    `SELECT c.id AS colourway_id,
            p.name,
            b.trade_only,
            i.qty_available,
            i.qty_reserved
       FROM colourways c
       JOIN products p ON p.id = c.product_id
       JOIN brands b ON b.id = p.brand_id
       LEFT JOIN inventory i ON i.colourway_id = c.id
      WHERE c.sku = $1 AND ${LISTED_SKU_CONDITION}
      FOR UPDATE OF c`,
    [line.sku]
  )
  const row = rows[0]
  if (!row || (row.trade_only && !includeTradeOnly)) {
    throw httpError(422, `No product available for SKU "${line.sku}".`)
  }

  // pg returns numeric columns as strings; a missing inventory row reads as 0.
  const hasInventory = row.qty_available !== null
  const available = Number(row.qty_available ?? 0) - Number(row.qty_reserved ?? 0)
  const short = !Number.isFinite(available) || available < line.qty_metres

  return {
    sku: line.sku,
    qty_metres: line.qty_metres,
    cut_requirements: line.cut_requirements ?? null,
    colourway_id: row.colourway_id,
    hasInventory,
    short,
  }
}

/**
 * Create an order request (or backorder request) and reserve stock.
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   lines: Array<{ sku: string, qty_metres: number, cut_requirements?: string }>,
 *   contact?: { name?: string, email?: string, phone?: string },
 *   acceptedLeadTime?: boolean,
 *   user?: { id: number, email: string } | null,
 * }} input
 * @returns {Promise<{ order: object }>}
 */
export const createOrderRequest = async (
  pool,
  { lines, contact = {}, acceptedLeadTime = false, user = null }
) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const includeTradeOnly = canSeeTradeCatalogue(user)
    const resolved = []
    for (const line of lines) {
      resolved.push(await resolveLine(client, line, includeTradeOnly))
    }

    const anyShort = resolved.some((line) => line.short)
    if (anyShort && !acceptedLeadTime) {
      throw httpError(
        422,
        'Some items are short on available stock. Accept the quoted lead time to place a backorder.'
      )
    }

    const kind = anyShort ? 'backorder_request' : 'order_request'
    const prefix = anyShort ? 'BO' : 'REQ'
    const orderNumber = `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`

    const userId = user ? user.id : null
    const guestEmail = user ? null : contact.email ?? null
    const notes = buildNotes(contact, user?.email)

    const { rows: orderRows } = await client.query(
      `INSERT INTO orders
         (user_id, guest_email, order_number, kind, status,
          subtotal_cents, shipping_cents, total_cents, notes)
       VALUES ($1, $2, $3, $4, 'requested', 0, 0, 0, $5)
       RETURNING id, order_number, kind, status`,
      [userId, guestEmail, orderNumber, kind, notes]
    )
    const order = orderRows[0]

    for (const line of resolved) {
      await client.query(
        `INSERT INTO order_lines
           (order_id, colourway_id, qty, unit_price_cents, cut_requirements)
         VALUES ($1, $2, $3, 0, $4)`,
        [order.id, line.colourway_id, line.qty_metres, line.cut_requirements]
      )
      // Reserve the requested metres. A short (backorder) line still reserves —
      // the demand is committed; the back office reconciles at confirmation.
      if (line.hasInventory) {
        await client.query(
          `UPDATE inventory
              SET qty_reserved = qty_reserved + $1
            WHERE colourway_id = $2`,
          [line.qty_metres, line.colourway_id]
        )
      }
    }

    await client.query('COMMIT')

    return {
      order: {
        id: order.id,
        order_number: order.order_number,
        kind: order.kind,
        status: order.status,
        lines: resolved.map((line) => ({
          sku: line.sku,
          qty_metres: line.qty_metres,
          cut_requirements: line.cut_requirements,
        })),
      },
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
