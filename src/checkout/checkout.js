// Stripe Checkout for finished goods (B2C card payment, FR-4).
//
// Everything that touches money is resolved server-side from the database:
// the request carries only { sku, qty } per line plus a shipping zone. Client
// prices are never trusted. A product not sold retail is rejected — it goes
// through the order-request flow (US-012), a quote, not card checkout. Until
// 1 Oct 2026 the rule was the type (fabric refused); it is the product's own
// Retail tick now (`products.sell_retail`). The cart + zone are
// stashed in the Stripe session metadata so the webhook (US-011) can rebuild the
// order without a pending row here.

import { getShippingQuote } from '../shipping/rates.js'
import { gstCents } from '../orders/gst.js'
import {
  canSeeTradeCatalogue,
  canSeeTradePricing,
  LISTED_SKU_CONDITION,
  STORE_CURRENCY,
} from '../catalogue/visibility.js'

// Throw an Error whose statusCode Fastify will honour on the reply.
const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// The shipping-rate tiers are the three NZ zones, so the delivery address Stripe
// collects has to be a New Zealand one — offering more countries would take
// money for a parcel we have no rate for.
export const SHIPPING_COUNTRIES = Object.freeze(['NZ'])

// Shown to shoppers when STRIPE_SECRET_KEY is unset. Deliberately says nothing
// about environment variables: the API boots fine without Stripe (so the rest of
// the store works), but a customer hitting "Pay by card" must get a message that
// makes sense to them, not our config naming. The operator sees the real cause
// in the startup log and in .env.example.
const CARD_PAYMENT_UNAVAILABLE =
  'Card payment is unavailable right now. Please get in touch and we will complete your order.'

// Resolves each requested { sku, qty } against the catalogue, enforcing that the
// product is a purchasable finished good with a price this viewer may be charged
// and enough stock. Returns priced lines; throws a 422 on the first line that
// fails a rule.
//
// `includeTrade` is the PRICE gate (FR-3, approved trade only) and is the same
// predicate the catalogue read models use — so the figure the shopper was shown
// on the card is the figure Stripe takes. Without it the store quoted the trade
// price and charged retail.
//
// EVERY line is `STORE_CURRENCY`, trade and retail alike. Both price columns
// hold New Zealand cents; `p.currency` is the SUPPLIER's and describes neither
// (see visibility.js). Reading the retail line's currency off it sent
// `unit_amount: 42900` to Stripe under `usd` for a house that invoices Atelier
// in US dollars — a 1.8x overcharge on a figure the card had shown as NZ$429 —
// and the mixed-currency refusal below could not catch it, because to that
// check a wholly-USD cart looks consistent.
//
// `includeTradeOnly` closes the same door the catalogue does: a SKU a visitor
// cannot browse is a SKU they cannot buy. Without it the gate would be cosmetic
// — the cart takes a bare SKU, so anyone who ever saw one (or guessed it) could
// transact on a represented house while signed out. It is answered with the
// SAME 422 as an unknown SKU deliberately: a checkout error is not the place to
// confirm which designs exist — nor that a house has left.
//
// `LISTED_SKU_CONDITION` is the published-and-unarchived gate the public read
// models apply. Archiving a house does NOT unpublish its products, so without it
// a departed maison's finished goods 404 on the storefront and still take money.
export const validateCheckoutLines = async (
  pool,
  lines,
  { includeTradeOnly = false, includeTrade = false } = {}
) => {
  const validated = []
  for (const { sku, qty } of lines) {
    const { rows } = await pool.query(
      `SELECT c.id AS colourway_id,
              p.name,
              p.slug AS product_slug,
              p.sell_retail,
              COALESCE(c.retail_price_cents, p.retail_price_cents) AS retail_price_cents,
              COALESCE(c.trade_price_cents, p.trade_price_cents) AS trade_price_cents,
              b.trade_only,
              i.qty_available,
              i.qty_reserved
         FROM colourways c
         JOIN products p ON p.id = c.product_id
         JOIN brands b ON b.id = p.brand_id
         LEFT JOIN inventory i ON i.colourway_id = c.id
        WHERE c.sku = $1 AND ${LISTED_SKU_CONDITION}`,
      [sku]
    )
    const row = rows[0]
    if (!row || (row.trade_only && !includeTradeOnly)) {
      throw httpError(422, `No purchasable product for SKU "${sku}".`)
    }
    if (!row.sell_retail) {
      throw httpError(
        422,
        `"${row.name}" is sold by quote only — use an order request, not card checkout.`
      )
    }
    const tradePriceCents = includeTrade ? row.trade_price_cents : null
    const unitPriceCents = tradePriceCents ?? row.retail_price_cents
    if (unitPriceCents === null) {
      throw httpError(422, `"${row.name}" has no price for card checkout.`)
    }

    // pg returns numeric columns as strings; a missing inventory row reads as 0.
    const available = Number(row.qty_available ?? 0) - Number(row.qty_reserved ?? 0)
    if (!Number.isFinite(available) || available < qty) {
      // The remaining count is part of the message so the store can tell the
      // shopper what to change instead of just refusing the cart.
      const remaining = Number.isFinite(available) && available > 0 ? available : 0
      throw httpError(
        422,
        `Insufficient stock for SKU "${sku}" — ${remaining} available.`
      )
    }

    validated.push({
      sku,
      qty,
      colourway_id: row.colourway_id,
      name: row.name,
      unit_price_cents: unitPriceCents,
      currency: STORE_CURRENCY,
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

const gstLineItem = (cents, currency) => ({
  price_data: {
    currency: currency.toLowerCase(),
    product_data: { name: 'GST 15%' },
    unit_amount: cents,
  },
  quantity: 1,
})

// The delivery details the store collected, as Stripe's PaymentIntent
// `shipping` shape (so the parcel address shows on the payment in the
// dashboard) and as flat metadata keys (so the webhook can persist them from
// the signature-verified event alone). Country is fixed: the zone tiers only
// price New Zealand.
const stripeShipping = (customer) => ({
  name: customer.name,
  phone: customer.phone,
  address: {
    line1: customer.address.line1,
    line2: customer.address.line2 || undefined,
    city: customer.address.city,
    postal_code: customer.address.postal_code,
    country: SHIPPING_COUNTRIES[0],
  },
})

const shippingMetadata = (customer) => ({
  ship_name: customer.name,
  ship_phone: customer.phone,
  ship_line1: customer.address.line1,
  ship_line2: customer.address.line2 ?? '',
  ship_city: customer.address.city,
  ship_postal_code: customer.address.postal_code,
})

const shippingLineItem = (zone, quote, currency) => ({
  price_data: {
    currency: currency.toLowerCase(),
    product_data: { name: `Shipping — ${zone}` },
    unit_amount: quote.rate_cents,
  },
  quantity: 1,
})

// The free text a shopper may add at checkout, kept as Stripe metadata entries
// and dropped when blank — metadata is strings throughout, so an empty one would
// reach the order row as a note that says nothing. Returns a new object; nothing
// is mutated.
const filledMetadata = (entries) =>
  Object.fromEntries(
    entries
      .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
      .filter(([, value]) => value !== '')
  )

/**
 * Validate a cart, add a live shipping quote, and create a Stripe Checkout
 * Session (test mode). Returns the redirect URL and session id.
 *
 * @param {{ pool: import('pg').Pool, stripe: import('stripe').Stripe, storeBaseUrl: string }} deps
 * @param {{ lines: Array<{ sku: string, qty: number }>, zone: string, customer: { name: string, email: string, phone: string, address: { line1: string, line2?: string, city: string, postal_code: string } }, user?: { id: string, email: string } | null, notes?: string | null, clientReference?: string | null, customerPoNumber?: string | null }} input
 * @returns {Promise<{ url: string, session_id: string }>}
 */
export const createCheckoutSession = async (
  { pool, stripe, storeBaseUrl },
  {
    lines,
    zone,
    customer,
    user = null,
    notes = null,
    clientReference = null,
    customerPoNumber = null,
  }
) => {
  if (!stripe) {
    throw httpError(503, CARD_PAYMENT_UNAVAILABLE)
  }

  const trade = canSeeTradePricing(user)
  const validated = await validateCheckoutLines(pool, lines, {
    includeTradeOnly: canSeeTradeCatalogue(user),
    includeTrade: trade,
  })

  // One Stripe session charges in one currency, and the goods, the freight and
  // the GST are all priced in it. That used to need a mixed-cart refusal here,
  // because a line took its currency from the supplier's; now every line is the
  // selling region's, so the cart cannot be mixed and there is nothing to refuse.
  const currency = STORE_CURRENCY
  const totalQty = validated.reduce((sum, line) => sum + line.qty, 0)

  const quote = await getShippingQuote(pool, { zone, qty: totalQty })
  if (!quote) {
    throw httpError(400, `Unknown shipping zone "${zone}".`)
  }

  // GST is charged on goods AND freight (domestic NZ delivery is taxable).
  const goodsCents = validated.reduce((sum, line) => sum + line.unit_price_cents * line.qty, 0)
  const gst = gstCents(goodsCents + quote.rate_cents)
  const lineItems = [
    ...validated.map(toStripeLineItem),
    shippingLineItem(zone, quote, currency),
    gstLineItem(gst, currency),
  ]

  // The webhook rebuilds the order from this metadata (US-011). Only sku + qty
  // are carried; every price is re-resolved server-side there too. `trade` is
  // the price BASIS, not a price: the webhook has to re-resolve on the same
  // basis this session was quoted on, or an approved trade shopper pays the
  // trade figure at Stripe and the order records retail. It is written by this
  // server and returned inside a signature-verified event — the same standing
  // `shipping_cents` already has.
  const cart = validated.map(({ sku, qty }) => ({ sku, qty }))

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    // Off, or a shopper abroad is shown Stripe's converted USD (with NZD as a
    // toggle) for a cart the store quoted in NZD — the order and the invoice
    // are NZD whatever the buyer's location.
    adaptive_pricing: { enabled: false },
    line_items: lineItems,
    success_url: `${storeBaseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${storeBaseUrl}/cart`,
    // The store collects the delivery details (Sept 2026) so Stripe must NOT
    // ask again: no shipping_address_collection / phone_number_collection. The
    // address rides on the PaymentIntent and in metadata (see stripeShipping).
    // Shipping is priced by our own zone tiers above, so no Stripe
    // shipping_options are offered either.
    payment_intent_data: { shipping: stripeShipping(customer) },
    billing_address_collection: 'auto',
    client_reference_id: user ? String(user.id) : undefined,
    // The address the shopper confirmed on our page, account or not — an
    // account holder may well want the receipt somewhere other than the login.
    customer_email: customer.email,
    metadata: {
      cart: JSON.stringify(cart),
      zone,
      shipping_cents: String(quote.rate_cents),
      gst_cents: String(gst),
      trade: String(trade),
      // The order row is written by the webhook, not here, so anything the
      // shopper typed has to travel with the session or it is lost. Stripe caps
      // a metadata value at 500 characters — the body schema caps them lower.
      ...filledMetadata([
        ['notes', notes],
        ['client_reference', clientReference],
        ['customer_po_number', customerPoNumber],
      ]),
      ...shippingMetadata(customer),
    },
  })

  return { url: session.url, session_id: session.id }
}

// The lines of the order the webhook wrote, in the shape the success page
// shows them. Money comes off the ORDER, never off the live catalogue: what the
// client paid is what they must see afterwards, whatever the price is today.
const orderLines = async (pool, orderId) => {
  const { rows } = await pool.query(
    `SELECT c.sku, p.name, ol.qty, ol.unit_price_cents
       FROM order_lines ol
       JOIN colourways c ON c.id = ol.colourway_id
       JOIN products p ON p.id = c.product_id
      WHERE ol.order_id = $1
      ORDER BY ol.id`,
    [orderId]
  )
  // pg hands numeric `qty` back as a string; the success page multiplies it.
  return rows.map((row) => ({
    sku: row.sku,
    name: row.name,
    qty: Number(row.qty),
    unit_price_cents: row.unit_price_cents,
  }))
}

/**
 * Verify a Checkout Session with Stripe and return the customer-facing summary
 * used by the store success page (US-019).
 *
 * The order itself is created asynchronously by the webhook (US-011) and carries
 * a human `order_number` (`WEB-9F3A21BC`), so this looks the row up by
 * `orders.stripe_session_id` rather than deriving a number from the session id.
 * The webhook is usually there first, but it is a different HTTP request from a
 * different origin: when it has not landed yet the answer is `pending: true`
 * with a null number and no lines, and the store polls (it must never invent a
 * number, and must never wait for one before telling the shopper they paid).
 *
 * The session id is the only key the caller presents, exactly as before — it
 * comes back from Stripe on the redirect and is unguessable, so the delivery
 * address and lines behind it belong to whoever holds it.
 *
 * @param {{ pool: import('pg').Pool, stripe: import('stripe').Stripe }} deps
 * @param {string} sessionId
 * @returns {Promise<{ order_number: string|null, pending: boolean, paid: boolean, amount_total_cents: number|null, currency: string|null, email: string|null, lines: object[], shipping_address: object|null }>}
 */
export const retrieveCheckoutSession = async ({ pool, stripe }, sessionId) => {
  if (!stripe) {
    throw httpError(503, CARD_PAYMENT_UNAVAILABLE)
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

  const { rows } = await pool.query(
    `SELECT id, order_number, shipping_address
       FROM orders
      WHERE stripe_session_id = $1`,
    [session.id]
  )
  const order = rows[0] ?? null

  return {
    order_number: order ? order.order_number : null,
    pending: order === null,
    paid: session.payment_status === 'paid',
    amount_total_cents: session.amount_total ?? null,
    currency: session.currency ? session.currency.toUpperCase() : null,
    email: session.customer_details?.email || session.customer_email || null,
    lines: order ? await orderLines(pool, order.id) : [],
    shipping_address: order?.shipping_address ?? null,
  }
}

/**
 * What the checkout form starts with for a signed-in shopper (Sept 2026):
 * the account's name/email, then the most recent card checkout's delivery
 * address and phone (already in Stripe's structured shape), then — for a trade
 * account — the trade application's business name, delivery address and
 * phones. Every field is editable on the page; this is only the first draft.
 * Nothing here is authoritative for the order: the body of
 * POST /checkout/session is.
 *
 * @param {import('pg').Pool} pool
 * @param {{ id: number, name?: string|null, email: string }} user
 */
export const getCheckoutPrefill = async (pool, user) => {
  const [orders, applications] = await Promise.all([
    pool.query(
      `SELECT shipping_address, contact_phone
         FROM orders
        WHERE user_id = $1 AND kind = 'checkout' AND shipping_address IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [user.id]
    ),
    pool.query(
      `SELECT business_name, delivery_address, mobile_phone, landline_phone
         FROM trade_applications
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [user.id]
    ),
  ])
  const last = orders.rows[0] ?? null
  const application = applications.rows[0] ?? null
  const address = last?.shipping_address ?? null
  return {
    name: user.name || address?.name || application?.business_name || '',
    email: user.email,
    phone: last?.contact_phone || application?.mobile_phone || application?.landline_phone || '',
    address: {
      // A trade application's delivery address is one free-text block, so it
      // lands in line1 for the shopper to split; a past order is structured.
      line1: address?.line1 ?? application?.delivery_address ?? '',
      line2: address?.line2 ?? '',
      city: address?.city ?? '',
      postal_code: address?.postal_code ?? '',
    },
  }
}
