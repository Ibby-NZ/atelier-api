/**
 * Price history — the ledger that lets the office look an old price up instead
 * of encoding the year in a SKU to preserve it.
 *
 * The client goes back to a superseded price 50 to 100 times a year, and the
 * only reason a rate from 2023 is still reachable today is that somebody put
 * "2023" in the item code. They will drop that practice when a lookup exists;
 * this is the store behind it.
 *
 * TWO TABLES WITH REAL FOREIGN KEYS, NOT ONE POLYMORPHIC TABLE. A polymorphic
 * (entity, row_id) key cannot BE a foreign key, so nothing stops a history row
 * pointing at a row that has gone, and nothing stops two entities colliding on
 * an id. `d365_overrides` already records what keying on a string costs — it
 * needs its own staleness machinery precisely because the database cannot hold
 * the edge for it. Two tables cost one extra `createTable` and buy the edge.
 *
 * THE COLUMN THAT IS NOT NULL IS `source`, NOT `reason`, and that is where the
 * mandatory-note commitment gets honest. A typed reason per row is impossible
 * across a 19,500-row import, so a MANUAL edit demands one (the API answers 422
 * without it) and an IMPORT generates one per row from `source_file` and
 * `date_effective`. "The 12 August Colefax file said so" is a better answer than
 * any sentence typed 19,500 times. The CHECK is what makes the rule
 * unbypassable: it holds for the CRM, for the AdminJS panel, for a route added
 * later and for a psql session, which is what the instruction actually means.
 *
 * `source` carries its own value CHECK because the reason rule keys on the
 * literal 'manual' — an unconstrained column would let a typo ('Manual') write
 * a manual edit with no reason at all and raise nothing.
 *
 * APPEND-ONLY. No UPDATE, no DELETE, no `archived_at`, and no lifecycle registry
 * entry. A mis-typed reason is corrected by a NEW row: an editable audit is not
 * an audit. Same posture as `sample_loans`; `test/price-history.test.js` scans
 * `src/` and fails on an `UPDATE`/`DELETE FROM` against either table.
 *
 * `ON DELETE RESTRICT`, NOT CASCADE, AND IT IS LOAD-BEARING. With CASCADE,
 * deleting a price-list item would destroy exactly the history this feature
 * exists to preserve — silently — and the next `npm run import:pricing` would
 * re-create the row looking new. So the `price_list_item` lifecycle entry gains
 * its first probe, `product` gains one too, and `REIMPORT_WARNING`'s success
 * envelope becomes unreachable for any item whose price has ever moved. That is
 * correct.
 *
 * `changed_at` AND `date_effective` ARE TWO DIFFERENT AXES AND MUST NEVER BE
 * CONFLATED. `changed_at` is when OUR ledger changed; `date_effective` is what
 * the supplier's paper said. A quote given on 3 March used the rate the ledger
 * held on 3 March, whatever date the supplier had printed on the list. The
 * as-at lookup keys on `changed_at` and returns `date_effective` beside it so a
 * reader sees both.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('price_list_item_price_history', {
    id: 'id',
    // RESTRICT: see the header. This edge is the whole point.
    price_list_item_id: {
      type: 'integer',
      notNull: true,
      references: 'price_list_items',
      onDelete: 'RESTRICT',
    },
    // Both NOT NULL: price_list_items.wholesale_rate is NOT NULL, so a change
    // always has both halves. Same precision as the column they come from.
    old_rate: { type: 'numeric(12,4)', notNull: true },
    new_rate: { type: 'numeric(12,4)', notNull: true },
    // The supplier's invoicing currency at the time. A rate is a number and a
    // currency; storing only the number makes an old rate uninterpretable if
    // the house ever re-denominates.
    currency: { type: 'text', notNull: true },
    // What the supplier's paper said. Nullable — plenty of drops state none.
    date_effective: { type: 'date' },
    source: {
      type: 'text',
      notNull: true,
      check: "source IN ('import','manual')",
    },
    // Copied off the row, so an import row names the drop it came in on.
    source_file: { type: 'text', notNull: true },
    reason: { type: 'text' },
    // The staff member who made a manual edit. SET NULL: the audit outlives the
    // account and merely stops naming it — the policy d365_overrides and
    // trade_accounts.linked_by_user_id already take.
    changed_by_user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // Shalakha's instruction, in the schema rather than in a screen.
  pgm.addConstraint(
    'price_list_item_price_history',
    'price_list_item_price_history_manual_reason_check',
    { check: "source <> 'manual' OR (reason IS NOT NULL AND btrim(reason) <> '')" }
  )

  // The as-at lookup is "newest row for this item at or before a date", so the
  // index is the item then the time, descending — one index scan, one row.
  pgm.createIndex('price_list_item_price_history', [
    'price_list_item_id',
    { name: 'changed_at', sort: 'DESC' },
  ])

  pgm.createTable('product_price_history', {
    id: 'id',
    product_id: {
      type: 'integer',
      notNull: true,
      references: 'products',
      onDelete: 'RESTRICT',
    },
    // A product carries TWO prices and either may move, so both are recorded on
    // every row: the pair is the product's price, and a row showing one number
    // in isolation cannot say whether the other moved with it. Nullable because
    // the columns they mirror are — most of the catalogue has no retail price
    // (FR-3) and only fabrics carry a trade one.
    old_retail_price_cents: { type: 'integer' },
    new_retail_price_cents: { type: 'integer' },
    old_trade_price_cents: { type: 'integer' },
    new_trade_price_cents: { type: 'integer' },
    currency: { type: 'text', notNull: true },
    source: {
      type: 'text',
      notNull: true,
      check: "source IN ('import','manual')",
    },
    // Nullable, unlike the price-list side: `products` has no source_file column
    // of its own, so this is whatever the writer declared (the seed says 'seed').
    source_file: { type: 'text' },
    reason: { type: 'text' },
    changed_by_user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.addConstraint('product_price_history', 'product_price_history_manual_reason_check', {
    check: "source <> 'manual' OR (reason IS NOT NULL AND btrim(reason) <> '')",
  })

  pgm.createIndex('product_price_history', [
    'product_id',
    { name: 'changed_at', sort: 'DESC' },
  ])
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('product_price_history')
  pgm.dropTable('price_list_item_price_history')
}
