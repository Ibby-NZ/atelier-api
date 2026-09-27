// Cart-line price resolution: given `[{ sku, qty }]` and a price BASIS, what the
// catalogue charges for each line right now.
//
// Shared deliberately. The Stripe webhook rebuilds a paid order from the cart
// stashed in the session metadata and must never take a price from the payload
// (`src/webhooks/CLAUDE.md`); the order-request flow wants the same figure as an
// indicative price the back office can still edit. One copy, so the two can
// never quote differently for the same SKU.

/**
 * Re-resolve each cart line's colourway + current price from the DB, on the
 * price BASIS the caller was quoted on (for checkout that is
 * `session.metadata.trade`, written by the checkout endpoint). Resolving retail
 * for a session Stripe charged at trade would record an order for money nobody
 * paid.
 *
 * @param {{ query: Function }} client pg client (inside a transaction) or pool
 * @param {Array<{ sku: string, qty: number }>} cart
 * @param {boolean} trade resolve on the trade basis (approved trade only)
 * @returns {Promise<Array<{ colourway_id: number, qty: number, unit_price_cents: number }>>}
 * @throws {Error} when a SKU has no price on that basis
 */
export const resolveCartLines = async (client, cart, trade) => {
  const lines = []
  for (const { sku, qty } of cart) {
    const { rows } = await client.query(
      `SELECT c.id AS colourway_id, p.name,
              COALESCE(c.retail_price_cents, p.retail_price_cents) AS retail_price_cents,
              COALESCE(c.trade_price_cents, p.trade_price_cents) AS trade_price_cents
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
