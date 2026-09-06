/**
 * Staff-asserted sales attribution on an order, while A6 (salesperson vs owner
 * vs account holder) is still an open decision with the client.
 *
 * NEVER derived from `legacy_accounts.owner`: 72% of that column is a shared
 * login ('Atelier Sales' 491 rows, 'Showroom #' 135), so a backfill from it
 * would attribute half the ledger to a login that is not a person. The column
 * starts NULL everywhere and staff assign it order by order in the CRM;
 * `sales-by-rep` reports NULL as an explicit 'Unassigned' row rather than
 * dropping it.
 *
 * Nullable FK, SET NULL on user deletion — the order outlives the account and
 * simply becomes unassigned again. No index: the reports range-scan
 * `orders.created_at`, and an order-desk rep filter is deferred until asked
 * for.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('orders', {
    sales_rep_user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
  })
}

export const down = (pgm) => {
  pgm.dropColumns('orders', ['sales_rep_user_id'])
}
