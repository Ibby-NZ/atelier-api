// The discount rules on a sales order (Rebecca-R2): which percentages any
// back-office user may set, which are a director-only override, and the one
// formula that turns a subtotal and a discount into a total.
//
// THIS MODULE IS PURE AND IMPORTS NOTHING, the `order-states.js` posture, for
// the same two reasons that module gives:
//   - The CRM mirrors it (`atelier-crm/src/screens/adminOrders.js` carries the
//     same tiers) so the Custom option is disabled for non-directors rather
//     than discovered as a 403 — the API stays the authority, the mirror only
//     decides what is DRAWN.
//   - It unit-tests with no database (`test/discount-rules.test.js`), which is
//     what keeps `discountedTotalCents` and the SQL in `recomputeOrderMoney`
//     honest about each other: the DB suite asserts the API's answer equals
//     this formula's.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * The tiers ANY back-office user may set. 5% and 10% are the discounts
 * "already included" in Atelier's pricing; 0 is here because taking a discount
 * OFF again must never need a director. Everything else is an override.
 *
 * `Number()` before the includes, because a stored `discount_pct` is pg
 * `numeric` and arrives as a string ('5.00') — a tier must not stop being
 * standard on the round trip.
 */
export const STANDARD_DISCOUNT_TIERS = Object.freeze([0, 5, 10])

/** @param {number|string} pct */
export const isStandardDiscount = (pct) =>
  STANDARD_DISCOUNT_TIERS.includes(Number(pct))

/**
 * The one total formula, mirrored by the SQL in `recomputeOrderMoney`
 * (src/orders/admin-orders.js) — change either and the DB suite fails.
 *
 * The discount applies to the GOODS, never to freight: `subtotal_cents` stays
 * the un-discounted figure, the discount is taken once over the whole
 * subtotal (per-line rounding would multiply the error by the line count),
 * and shipping rides on top unchanged. `Math.round` and Postgres `ROUND`
 * agree for every non-negative value, both taking .5 up.
 *
 * @param {number|string} subtotalCents
 * @param {number|string} discountPct
 * @param {number|string} shippingCents
 * @returns {number}
 */
export const discountedTotalCents = (subtotalCents, discountPct, shippingCents) =>
  Math.round(Number(subtotalCents) * (1 - Number(discountPct) / 100)) +
  Number(shippingCents)

/**
 * The gate on WRITING a discount. Standard tiers pass for anyone the route
 * guard already admitted; anything else is the director-only override the
 * requirement names, and an override must carry a non-blank reason — a unique
 * discount with no story is what this gate exists to prevent.
 *
 * Throws the same `{ statusCode }` errors the rest of this domain does: 403
 * when the caller may not, 422 when the caller may but has not said why.
 *
 * @param {{ pct: number|string, reason?: string|null, role?: string }} input
 */
export const checkDiscountWrite = ({ pct, reason, role }) => {
  if (isStandardDiscount(pct)) return
  // The route guard is requireRole('backoffice') and director INHERITS
  // backoffice, so the guard cannot draw this line — only the handler's view
  // of `request.user.role` can (the admin-users self-protection posture).
  if (role !== 'director') {
    throw httpError(
      403,
      'Only a director may apply a discount outside the standard 0%, 5% and 10% tiers.'
    )
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw httpError(
      422,
      'A discount outside the standard tiers must record a reason.'
    )
  }
}
