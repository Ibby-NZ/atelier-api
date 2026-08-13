/**
 * The client's own two numbers on a sales order (W12 US-001, FR-115).
 *
 * `client_reference` is whatever the client calls this job — "Cnr Ponsonby Rd
 * apt 4B", "Hutchinson residence, lounge". It is how the office finds an order
 * when the caller does not have our order number, which is most calls.
 *
 * **`customer_po_number` IS THE CLIENT'S OWN PURCHASE-ORDER NUMBER — the number
 * THEY issued to US and quoted down the phone. It is not one of our purchase
 * orders.** W13 introduces a `purchase_orders` table for the orders Atelier
 * places on its suppliers, with its own sequence-issued number; the two are
 * opposite ends of the trade and will be confused the first time somebody greps
 * for "po". They never join, and neither is derivable from the other. The
 * column name keeps `customer_` for exactly that reason — do not "tidy" it to
 * `po_number`.
 *
 * Both nullable text: most orders have neither, a trade account raising a job
 * for a client has one or both, and there is no format to constrain — a PO
 * number is a string the client's own system issued and we have no say in it.
 * Nullable rather than `DEFAULT ''` so "they gave us no PO" and "they gave us a
 * blank one" are the same absence, which is what US-006 clears them back to.
 *
 * ## No index, deliberately
 *
 * US-003 searches both columns with `ILIKE '%term%'` (a reference is typed from
 * memory, so an anchored match finds nothing). **A btree cannot serve a leading
 * wildcard**, so an index on either column would be built, maintained on every
 * order write, and never chosen by the planner — the speculative index this
 * story exists to not add. The predicate that IS index-served is the date range,
 * and `orders.created_at` already carries the btree
 * `1786680000000_reporting-finance-access.js` added for exactly this shape of
 * query. The only index that would help the free-text search is a pg_trgm GIN,
 * which needs an extension this database does not install, on a table holding
 * hundreds of rows. Revisit when the orders table is large enough for the
 * sequential scan to show up in a slow-query log, not before.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('orders', {
    client_reference: { type: 'text' },
    customer_po_number: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('orders', ['client_reference', 'customer_po_number'])
}
