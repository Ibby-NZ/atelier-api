/**
 * A manual pricing override on a sales order (Rebecca-R2).
 *
 * The client's ask: "a manual over-ride for pricing that has a Directors-only
 * security on it, so that only the Directors can apply a unique discount above
 * the 5% & 10% already included." So the column is a PERCENTAGE, not an
 * adjusted total: the money keeps being recomputed from the lines in the one
 * place it always was (`recomputeOrderMoney`), and the discount is an input to
 * that recompute rather than a second spelling of the total that could
 * disagree with it the next time a line is edited.
 *
 * `discount_pct` is `numeric(5,2)` because a director's override is a number
 * somebody negotiated ("7.5 for the Hutchinson job"), not one of an enum —
 * the 0/5/10 standard tiers are a POLICY (src/orders/discounts.js), enforced
 * in the handler where the caller's role is known, never a CHECK. The CHECK
 * only pins what no negotiation can change: a discount is between nothing and
 * everything.
 *
 * `discount_reason` is why the override was given, required by the API
 * whenever the percentage leaves the standard tiers — a unique discount with
 * no story is exactly what the director gate exists to prevent. Nullable
 * because the standard tiers need no justification.
 *
 * `discount_applied_by` is WHO set it, written server-side from the session
 * (never from the body). ON DELETE SET NULL: the order is a financial record
 * and must survive the account of whoever discounted it — same posture as
 * `orders.user_id`.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('orders', {
    discount_pct: {
      type: 'numeric(5,2)',
      notNull: true,
      default: 0,
      check: 'discount_pct >= 0 AND discount_pct <= 100',
    },
    discount_reason: { type: 'text' },
    discount_applied_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('orders', ['discount_pct', 'discount_reason', 'discount_applied_by'])
}
