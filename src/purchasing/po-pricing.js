// A purchase-order line priced from the catalogue rather than typed (24 Sep
// 2026: "purchase orders should use wholesale price ... and take into
// consideration supplier freight rates and supplier discounts").
//
// Two figures, each from ONE place, both through the pricing engine's own
// steps so a purchase order and the Pricing screen can never disagree:
//   - `unit_price`, in the SUPPLIER's currency: the design's wholesale rate
//     (`products.wholesale_rate`, filled by the wholesale import) less the
//     supplier's own discount (`suppliers.default_discount`, typed on the
//     supplier page) — the waterfall's "export price" step. Every house the
//     supplier invoices buys at it: a house has no purchase-order discount of
//     its own, and its sale discount prices sales only (1 Oct 2026);
//   - `freight_per_unit`, NZ$: the house's freight rate from the freight
//     ledger at the variation's freight class (its own, else its product's) —
//     the waterfall's "freight" step. A percentage rate needs the
//     duty-paid price, so it stays null wherever duty or FX is not set.
//
// Blank is not zero, the engine's rule: a design with no wholesale rate, or a
// house with no discount stated, prices to NULL — an unpriced line the office
// keys by hand — never to a number somebody would read as the house's price.
// A pricing refusal (a supplier that no longer invoices the house, say) leaves
// the line unpriced too: raising the purchase order is the act, and a price is
// only its first guess.

import { previewWaterfall } from '../pricing/pricing-parameters.js'

const NO_PRICE = Object.freeze({ unit_price: null, freight_per_unit: null })

const stepAmount = (waterfall, step) =>
  waterfall.steps.find((entry) => entry.step === step)?.amount ?? null

/**
 * The catalogue's price and freight for one goods line of a purchase order.
 *
 * @param {{ query: Function }} db the purchase order's transaction client
 * @param {{ purchaseOrderId: number, colourwayId: number }} line
 * @returns {Promise<{ unit_price: number|null, freight_per_unit: number|null }>}
 */
export const priceLineFromCatalogue = async (db, { purchaseOrderId, colourwayId }) => {
  const { rows } = await db.query(
    `SELECT po.brand_id, po.supplier_id, p.id AS product_id, p.category, p.wholesale_rate
       FROM purchase_orders po
       CROSS JOIN colourways c
       JOIN products p ON p.id = c.product_id
      WHERE po.id = $1 AND c.id = $2`,
    [purchaseOrderId, colourwayId]
  )
  const row = rows[0]
  if (!row) return NO_PRICE
  try {
    const { waterfall } = await previewWaterfall(db, {
      brandId: row.brand_id,
      supplierId: row.supplier_id,
      productId: row.product_id,
      colourwayId,
      category: row.category,
      wholesaleRate: row.wholesale_rate == null ? null : Number(row.wholesale_rate),
      purchase: true,
    })
    return Object.freeze({
      unit_price: stepAmount(waterfall, 'export_price'),
      freight_per_unit: stepAmount(waterfall, 'freight_amount'),
    })
  } catch (error) {
    // A refusal the engine words for a person (422/404) is a price it cannot
    // give; anything else is a real fault and must surface.
    if (error?.statusCode >= 400 && error.statusCode < 500) return NO_PRICE
    throw error
  }
}
