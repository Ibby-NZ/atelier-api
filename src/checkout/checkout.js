// Stripe Checkout for finished goods (B2C card payment, FR-4).
//
// Everything that touches money is resolved server-side from the database:
// the request carries only { sku, qty } per line plus a shipping zone. Client
// prices are never trusted. Fabric-type products are rejected — they go through
// the order-request flow (US-012), not card checkout. The cart + zone are
// stashed in the Stripe session metadata so the webhook (US-011) can rebuild the
// order without a pending row here.

import { getShippingQuote } from '../shipping/rates.js'

// Throw an Error whose statusCode Fastify will honour on the reply.
const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Resolves each requested { sku, qty } against the catalogue, enforcing that the
// product is a purchasable finished good with a retail price and enough stock.
// Returns priced lines; throws a 422 on the first line that fails a rule.
export const validateCheckoutLines = async (pool, lines) => {
  const validated = []
  for (const { sku, qty } of lines) {
    const { rows } = await pool.query(
      `SELECT c.id AS colourway_id,
              p.name,
              p.slug AS product_slug,
              p.product_type,
              p.retail_price_cents,
              p.currency,
              p.show_on_website,
              i.qty_available,
              i.qty_reserved
         FROM colourways c
         JOIN products p ON p.id = c.product_id
         LEFT JOIN inventory i ON i.colourway_id = c.id
        WHERE c.sku = $1`,
      [sku]
    )
    const row = rows[0]
    if (!row || !row.show_on_website) {
      throw httpError(422, `No purchasable product for SKU "${sku}".`)
    }
    if (row.product_type === 'fabric') {
      throw httpError(
        422,
        `"${row.name}" is a fabric — use an order request, not card checkout.`
      )
    }
    if (row.retail_price_cents === null) {
      throw httpError(422, `"${row.name}" has no retail price for card checkout.`)
    }

    // pg returns numeric columns as strings; a missing inventory row reads as 0.
    const available = Number(row.qty_available ?? 0) - Number(row.qty_reserved ?? 0)
    if (!Number.isFinite(available) || available < qty) {
      throw httpError(422, `Insufficient stock for SKU "${sku}".`)
    }

    validated.push({
      sku,
      qty,
      colourway_id: row.colourway_id,
      name: row.name,
      unit_price_cents: row.retail_price_cents,
      currency: row.currency,
    })
  }
  return validated
}

const toStripeLineItem = (line) => ({
  price_data: {
    currency: line.currency.toLowerCase(),
    product_data: { name: line.name },
    unit_amount: line.unit_price_cents,
  },
  quantity: line.qty,
})

const shippingLineItem = (zone, quote, currency) => ({
  price_data: {
    currency: currency.toLowerCase(),
    product_data: { name: `Shipping — ${zone}` },
    unit_amount: quote.rate_cents,
  },
  quantity: 1,
})

/**
 * Validate a cart, add a live shipping quote, and create a Stripe Checkout
 * Session (test mode). Returns the redirect URL and session id.
 *
 * @param {{ pool: import('pg').Pool, stripe: import('stripe').Stripe, storeBaseUrl: string }} deps
 * @param {{ lines: Array<{ sku: string, qty: number }>, zone: string, user?: { id: string, email: string } | null }} input
 * @returns {Promise<{ url: string, session_id: string }>}
 */
export const createCheckoutSession = async (
  { pool, stripe, storeBaseUrl },
  { lines, zone, user = null }
) => {
  if (!stripe) {
    throw httpError(503, 'Card checkout is not configured (STRIPE_SECRET_KEY unset).')
  }

  const validated = await validateCheckoutLines(pool, lines)
  const currency = validated[0].currency
  const totalQty = validated.reduce((sum, line) => sum + line.qty, 0)

  const quote = await getShippingQuote(pool, { zone, qty: totalQty })
  if (!quote) {
    throw httpError(400, `Unknown shipping zone "${zone}".`)
  }

  const lineItems = [
    ...validated.map(toStripeLineItem),
    shippingLineItem(zone, quote, currency),
  ]

  // The webhook rebuilds the order from this metadata (US-011). Only sku + qty
  // are carried; every price is re-resolved server-side there too.
  const cart = validated.map(({ sku, qty }) => ({ sku, qty }))

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    success_url: `${storeBaseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${storeBaseUrl}/cart`,
    client_reference_id: user ? String(user.id) : undefined,
    customer_email: user ? user.email : undefined,
    metadata: {
      cart: JSON.stringify(cart),
      zone,
      shipping_cents: String(quote.rate_cents),
    },
  })

  return { url: session.url, session_id: session.id }
}

/**
 * Verify a Checkout Session with Stripe and return the customer-facing summary
 * used by the store success page (US-019). The order itself is created
 * asynchronously by the webhook (US-011), but `order_number` is deterministic
 * (`WEB-<session id>`), so the success page can show it without waiting.
 *
 * @param {{ stripe: import('stripe').Stripe }} deps
 * @param {string} sessionId
 * @returns {Promise<{ order_number: string, paid: boolean, amount_total_cents: number|null, currency: string|null, email: string|null }>}
 */
export const retrieveCheckoutSession = async ({ stripe }, sessionId) => {
  if (!stripe) {
    throw httpError(503, 'Card checkout is not configured (STRIPE_SECRET_KEY unset).')
  }

  let session
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId)
  } catch {
    throw httpError(404, 'Checkout session not found.')
  }
  if (!session || !session.id) {
    throw httpError(404, 'Checkout session not found.')
  }

  return {
    order_number: `WEB-${session.id}`,
    paid: session.payment_status === 'paid',
    amount_total_cents: session.amount_total ?? null,
    currency: session.currency ? session.currency.toUpperCase() : null,
    email: session.customer_details?.email || session.customer_email || null,
  }
}
