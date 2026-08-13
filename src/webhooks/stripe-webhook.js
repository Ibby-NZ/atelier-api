// Stripe webhook processing (FR-4): a completed Checkout Session becomes a paid
// order with lines, and inventory is decremented. Processing is idempotent on
// the Stripe event id via the webhook_events ledger — a replayed event claims
// no row and creates nothing.
//
// Money is never trusted from the webhook payload: line prices are re-resolved
// from the database off the cart (sku + qty) stashed in the session metadata by
// the checkout endpoint (US-010). shipping_cents is carried in metadata.

// Re-resolve each cart line's colourway + current price from the DB, on the
// price BASIS the session was quoted on (`metadata.trade`, written by the
// checkout endpoint). Resolving retail for a session Stripe charged at trade
// would record an order for money nobody paid.
const resolveCartLines = async (client, cart, trade) => {
  const lines = []
  for (const { sku, qty } of cart) {
    const { rows } = await client.query(
      `SELECT c.id AS colourway_id, p.name, p.retail_price_cents, p.trade_price_cents
         FROM colourways c
         JOIN products p ON p.id = c.product_id
        WHERE c.sku = $1`,
      [sku]
    )
    const row = rows[0]
    const unitPriceCents = row
      ? (trade ? row.trade_price_cents : null) ?? row.retail_price_cents
      : null
    if (unitPriceCents === null) {
      throw new Error(`Webhook cannot resolve a price for SKU "${sku}".`)
    }
    lines.push({
      colourway_id: row.colourway_id,
      qty,
      unit_price_cents: unitPriceCents,
    })
  }
  return lines
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

  // Derived from the session id (unique per checkout), so the order number is
  // stable even if this handler is retried before the ledger claim commits.
  const orderNumber = `WEB-${session.id}`

  const { shippingAddress, contactPhone } = deliveryDetails(session)

  const { rows } = await client.query(
    `INSERT INTO orders
       (user_id, guest_email, order_number, kind, status,
        subtotal_cents, shipping_cents, total_cents, shipping_zone, stripe_session_id,
        shipping_address, contact_phone)
     VALUES ($1, $2, $3, 'checkout', 'paid', $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, order_number, user_id, guest_email, total_cents`,
    [
      userId,
      guestEmail,
      orderNumber,
      subtotalCents,
      shippingCents,
      totalCents,
      zone,
      session.id,
      shippingAddress ? JSON.stringify(shippingAddress) : null,
      contactPhone,
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
  // (US-015) without a second query.
  return {
    id: order.id,
    order_number: order.order_number,
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
