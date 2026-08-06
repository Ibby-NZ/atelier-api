/**
 * Reporting: the date-range index the reports scan on, and the finance-visibility
 * flag their masking is derived from.
 *
 * ## `orders.created_at` index
 *
 * Every report in Epic 5 is a date range first and a filter second — "revenue
 * this quarter", "what has not been invoiced this month" — so `created_at` is the
 * primary scan on `orders`. Today only `user_id` and `status` are indexed
 * (`1784603440195_users-orders-shipping-schema.js`), which are the *account* and
 * *lifecycle* access paths: neither helps a range predicate, so the planner reads
 * the whole table for every report and every export.
 *
 * A plain ascending btree, not a composite and not DESC. A btree range scan is
 * direction-agnostic, so `ORDER BY created_at DESC` uses it just as well; and a
 * composite `(status, created_at)` would only serve the reports that filter on
 * the default population — the status filter is overridable (architecture.md
 * § Reporting), so the column that is ALWAYS in the predicate is the one to
 * index.
 *
 * ## `users.can_view_finance`
 *
 * Server-side masking needs an explicit answer to "may this login see cost and
 * margin", and today there is none: the CRM maps every staff login to full
 * director access, so its masking has never fired. Role alone will not do it —
 * `backoffice` covers the showroom and the accounts desk alike, and the office
 * has said it wants the two separated.
 *
 * NOT NULL DEFAULT false. Finance visibility must fail CLOSED: a column that
 * could be NULL turns "nobody has decided yet" into a value every reader has to
 * interpret, and the interpretations drift. Every existing login therefore starts
 * without it, and the backfill below grants it to directors — the role that
 * already sees every cost figure in the CRM, so granting it changes nothing about
 * what they can reach and everything about what a `backoffice` login can.
 *
 * The backfill statement is EXPORTED so `test/admin-reports.test.js` can run the
 * exact statement this migration ran against its own fixtures, rather than a
 * retyped copy that could drift. node-pg-migrate reads only `up`/`down`; the same
 * posture as `1786593600000_featured-rank.js`.
 *
 * It carries its own `AND can_view_finance = false` guard so re-running it is a
 * genuine no-op rather than a write of the same value — which is what lets the
 * test run it twice and assert the second run touched nothing.
 */

/** Grant finance visibility to every director. Idempotent by construction. */
export const DIRECTOR_BACKFILL_SQL = `
UPDATE users
   SET can_view_finance = true
 WHERE role = 'director'
   AND can_view_finance = false`

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createIndex('orders', 'created_at')
  pgm.addColumns('users', {
    can_view_finance: { type: 'boolean', notNull: true, default: false },
  })
  pgm.sql(DIRECTOR_BACKFILL_SQL)
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('users', ['can_view_finance'])
  pgm.dropIndex('orders', 'created_at')
}
