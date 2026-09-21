/**
 * Which price list an order was written off — trade or retail — stated ON the
 * order rather than derived from the account at read time.
 *
 * Derivation was the tempting version and it is wrong both ways: a walk-in can
 * be given trade terms for a job, and an approved trade client can be quoted
 * retail for a one-off. The account's role answers what the STOREFRONT quotes
 * (`canSeeTradePricing`); it does not answer what the office actually charged,
 * which is the question the order desk asks on every row.
 *
 * NOT NULL with a `retail` default: every order was priced off one list or the
 * other, and a third "unknown" state is a column the list has to explain. The
 * backfill applies the rule the storefront priced by at the time — approved
 * trade only, exactly `canSeeTradePricing` — so existing orders read the way
 * they were quoted. Guest orders have no account and stay retail.
 *
 * No index: the value is displayed and edited per order, never filtered on.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('orders', {
    price_type: { type: 'text', notNull: true, default: 'retail' },
  })
  pgm.addConstraint('orders', 'orders_price_type_check', {
    check: "price_type IN ('trade', 'retail')",
  })
  pgm.sql(`UPDATE orders o
              SET price_type = 'trade'
             FROM users u
            WHERE u.id = o.user_id
              AND u.role = 'trade'
              AND u.trade_approved`)
}

export const down = (pgm) => {
  pgm.dropColumns('orders', ['price_type'])
}
