// Stripe webhook processing (FR-4): a completed Checkout Session becomes a paid
// order with lines, and inventory is decremented. Processing is idempotent on
// the Stripe event id via the webhook_events ledger — a replayed event claims
// no row and creates nothing.
//
// Money is never trusted from the webhook payload: line prices are re-resolved
// from the database off the cart (sku + qty) stashed in the session metadata by
// the checkout endpoint (US-010), through the shared `resolveCartLines`.
// shipping_cents is carried in metadata.

import { resolveCartLines } from '../catalogue/line-prices.js'
import { orderNumber } from '../orders/order-number.js'

// Free text the shopper typed at checkout and Stripe handed back. Metadata is
// strings throughout and an absent key reads as undefined, so an empty value is
// "not given", never a note that says nothing.
const metaText = (value) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? null : text
}

// The delivery details Stripe collected during the hosted checkout. Newer
// Stripe API versions move these under `collected_information`; older ones put
// `shipping_details` at the top level. Read both so an API-version bump does not
// silently start dropping addresses. Returns nulls when nothing was collected
// (a session created before shipping collection was switched on, or a replay of
// an old event).
const deliveryDetails = (session) => {
  const shipping =
    session.collected_information?.shipping_details ?? session.shipping_details ?? null
  const address = shipping?.address ?? null

  return {
    shippingAddress: address
      ? {
          name: shipping.name ?? session.customer_details?.name ?? null,
          line1: address.line1 ?? null,
          line2: address.line2 ?? null,
          city: address.city ?? null,
          state: address.state ?? null,
          postal_code: address.postal_code ?? null,
          country: address.country ?? null,
        }
      : null,
    contactPhone: session.customer_details?.phone ?? null,
  }
}

// Build the paid order + lines and decrement inventory. Runs inside the caller's
// transaction so a failure rolls back the ledger claim too.
const createPaidOrder = async (client, session) => {
  const cart = JSON.parse(session.metadata?.cart ?? '[]')
  const zone = session.metadata?.zone ?? null
  const shippingCents = Number(session.metadata?.shipping_cents ?? 0)

  const lines = await resolveCartLines(client, cart, session.metadata?.trade === 'true')
  const subtotalCents = lines.reduce(
    (sum, line) => sum + line.unit_price_cents * line.qty,
    0
  )
  const totalCents = subtotalCents + shippingCents

  // Logged-in checkouts carry the user id in client_reference_id; guests carry
  // an email Stripe collected. An order has one or the other, never both.
  const userId = session.client_reference_id
    ? Number(session.client_reference_id)
    : null
  const guestEmail = userId
    ? null
    : session.customer_details?.email ?? session.customer_email ?? null

  // A human number the client can read back to the office (`WEB-9F3A21BC`), not
  // `WEB-<stripe session id>`. Idempotency does not rest on it: the ledger claim
  // and this INSERT commit together, so a retried event either finds the claim
  // taken (creates nothing) or rolls the whole thing back.
  const number = orderNumber('WEB')

  const { shippingAddress, contactPhone } = deliveryDetails(session)

  const { rows } = await client.query(
    `INSERT INTO orders
       (user_id, guest_email, order_number, kind, status,
        subtotal_cents, shipping_cents, total_cents, shipping_zone, stripe_session_id,
        shipping_address, contact_phone, notes, client_reference, customer_po_number)
     VALUES ($1, $2, $3, 'checkout', 'paid', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, order_number, kind, user_id, guest_email, total_cents`,
    [
      userId,
      guestEmail,
      number,
      subtotalCents,
      shippingCents,
      totalCents,
      zone,
      session.id,
      shippingAddress ? JSON.stringify(shippingAddress) : null,
      contactPhone,
      // What the shopper typed on the store's checkout form, carried across
      // Stripe in metadata because this is where the order row is written.
      metaText(session.metadata?.notes),
      metaText(session.metadata?.client_reference),
      metaText(session.metadata?.customer_po_number),
    ]
  )
  const order = rows[0]

  for (const line of lines) {
    await client.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
       VALUES ($1, $2, $3, $4)`,
      [order.id, line.colourway_id, line.qty, line.unit_price_cents]
    )
    await client.query(
      `UPDATE inventory
          SET qty_available = qty_available - $1
        WHERE colourway_id = $2`,
      [line.qty, line.colourway_id]
    )
  }

  // guest_email / user_id / total_cents let the caller send a checkout receipt
  // (US-015) without a second query; `kind` lets it name the order in the
  // back-office alert (W12 US-004) without re-reading the row it just wrote.
  return {
    id: order.id,
    order_number: order.order_number,
    kind: order.kind,
    user_id: order.user_id,
    guest_email: order.guest_email,
    total_cents: order.total_cents,
  }
}

/**
 * Claim the event in the idempotency ledger and, for a completed checkout
 * session, create the paid order. All in one transaction.
 *
 * @param {import('pg').Pool} pool
 * @param {{ id: string, type: string, data: { object: object } }} event
 * @returns {Promise<{ duplicate: boolean, handled?: boolean, order?: { id: number, order_number: string } }>}
 */
export const processStripeEvent = async (pool, event) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const claim = await client.query(
      `INSERT INTO webhook_events (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.id]
    )
    if (claim.rowCount === 0) {
      await client.query('ROLLBACK')
      return { duplicate: true }
    }

    let order
    if (event.type === 'checkout.session.completed') {
      order = await createPaidOrder(client, event.data.object)
    }

    await client.query('COMMIT')
    return { duplicate: false, handled: Boolean(order), order }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
