/**
 * Suppliers: the house that INVOICES Atelier, as a first-class record.
 *
 * Until now a supplier existed twice and neither copy was a record: as free text
 * on `price_list_items.supplier` (derived from a filename prefix, 40 distinct
 * spellings) and as a vendored snapshot in `src/seed/data/suppliers.js`. A brand
 * is what a customer buys; a supplier is who Atelier pays, and one supplier sells
 * several brands (Rubelli sells Dominique Kieffer, Jim Thompson sells No.9
 * Thompson), so the two cannot be the same row.
 *
 * CURRENCY IS THE SUPPLIER'S INVOICING CURRENCY, NOT THE COUNTRY'S DEFAULT.
 * Jim Thompson is in Thailand and invoices USD; C&C Milano is in Italy and
 * invoices EUR. Deriving it from `country` is the mistake this column exists to
 * prevent, which is also why it is NULLABLE: a supplier can be recorded before an
 * invoice is on file, and an empty cell is honest where a guessed one silently
 * mis-converts every landed cost built on it. The backfill (US-006) sets it from
 * the price list, where every row already carries the currency it was quoted in.
 *
 * NO COST COLUMN IS ADDED TO `brands`. `src/catalogue/brands.js` serves brand
 * rows to ANONYMOUS visitors, so a discount or rate parked there would ship to
 * the public storefront; `test/price-list-exposure.test.js` asserts exactly that.
 * `brands` gains one integer FK and nothing else — the commercial terms live on
 * their own tables (US-002), which no client-facing read model joins.
 *
 * WHY `price_list_items.supplier` STAYS. It is part of the
 * `(supplier, category, code)` unique key the price-list import upserts on, so
 * dropping it would rewrite the upsert target and make every re-import insert
 * duplicates. `supplier_id` is added BESIDE it and backfilled; the free text
 * remains the row's identity and its traceability back to the source file.
 *
 * WHY THE TWO FK POLICIES DIFFER. `brands.supplier_id` is RESTRICT: a house
 * pointing at a supplier is a live commercial relationship, and deleting the
 * supplier must be refused loudly rather than silently unlinking 41 brands.
 * `price_list_items.supplier_id` is SET NULL: those rows are a historic rate
 * ledger that must survive the supplier record being tidied away, and the free
 * text still says who quoted them.
 *
 * `supplier_aliases` is what the backfill matches on. The price lists spell one
 * house several ways ('JV', 'JWALL', 'C&C MILANO'), so an alias is a lookup key,
 * not a business record — CASCADE, and unique on `lower(btrim(alias))` GLOBALLY,
 * because an alias that resolved to two suppliers would make the backfill pick
 * one at random.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('suppliers', {
    id: 'id',
    // Unique so a duplicate is refused by the database (23505 → 409), never by a
    // pre-check that races.
    name: { type: 'text', notNull: true, unique: true },
    slug: { type: 'text', notNull: true, unique: true },
    // The office's own abbreviation, printed on a PO. Staff-typed.
    short_code: { type: 'text' },
    // The token D365 composes into an item code ('F3518-003 23PF' → 'PF'). It
    // identifies the SUPPLIER, not the brand ('CF' covers Colefax & Fowler and
    // Jane Churchill), so it is the roll-up key back into the legacy corpus.
    d365_token: { type: 'text' },
    country: { type: 'text' },
    // See the header: the currency they INVOICE in. Never defaulted from country.
    currency: { type: 'text' },
    // Freight agent and Incoterm as negotiated with this house; both are
    // indicative in the seed snapshot and staff-correctable.
    agent: { type: 'text' },
    incoterm: { type: 'text' },
    po_email: { type: 'text' },
    // Matches the seed snapshot's vocabulary: 'averaged' is the one supplier-level
    // net discount, 'per-brand' the houses excluded from averaging (JV) whose
    // terms are handled brand by brand in supplier_brand_terms.
    discount_method: {
      type: 'text',
      check: "discount_method IN ('averaged','per-brand')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    archived_at: { type: 'timestamptz' },
  })

  // Same posture as every other archivable table: the common read filters on
  // archived_at IS NULL, so index only the live rows.
  pgm.createIndex('suppliers', 'archived_at', {
    name: 'suppliers_archived_at_live_idx',
    where: 'archived_at IS NULL',
  })

  // Partial unique: both codes are optional, but two suppliers sharing one would
  // make an item-code roll-up ambiguous, and NULLs must stay repeatable.
  pgm.createIndex('suppliers', 'd365_token', {
    name: 'suppliers_d365_token_unique',
    unique: true,
    where: 'd365_token IS NOT NULL',
  })
  pgm.createIndex('suppliers', 'short_code', {
    name: 'suppliers_short_code_unique',
    unique: true,
    where: 'short_code IS NOT NULL',
  })

  pgm.createTable('supplier_aliases', {
    id: 'id',
    // CASCADE: an alias is a lookup key belonging to the supplier, not a record
    // that should outlive it.
    supplier_id: {
      type: 'integer',
      notNull: true,
      references: 'suppliers',
      onDelete: 'CASCADE',
    },
    alias: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // Unique across ALL suppliers, case- and whitespace-insensitive: the price-list
  // spellings arrive from filenames ('JWALL', ' C&C Milano '), so the comparison
  // has to normalise, and one alias must resolve to exactly one supplier.
  pgm.createIndex('supplier_aliases', 'lower(btrim(alias))', {
    name: 'supplier_aliases_alias_lower_unique',
    unique: true,
  })
  pgm.createIndex('supplier_aliases', 'supplier_id')

  // RESTRICT — see the header. A brand link is a live relationship.
  pgm.addColumns('brands', {
    supplier_id: {
      type: 'integer',
      references: 'suppliers',
      onDelete: 'RESTRICT',
    },
  })
  pgm.createIndex('brands', 'supplier_id')

  // SET NULL — the rate ledger outlives the supplier record; `supplier` free text
  // stays as the row's identity and upsert key.
  pgm.addColumns('price_list_items', {
    supplier_id: {
      type: 'integer',
      references: 'suppliers',
      onDelete: 'SET NULL',
    },
  })
  pgm.createIndex('price_list_items', 'supplier_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropIndex('price_list_items', 'supplier_id')
  pgm.dropColumns('price_list_items', ['supplier_id'])
  pgm.dropIndex('brands', 'supplier_id')
  pgm.dropColumns('brands', ['supplier_id'])
  pgm.dropTable('supplier_aliases')
  pgm.dropIndex('suppliers', 'short_code', { name: 'suppliers_short_code_unique' })
  pgm.dropIndex('suppliers', 'd365_token', { name: 'suppliers_d365_token_unique' })
  pgm.dropIndex('suppliers', 'archived_at', { name: 'suppliers_archived_at_live_idx' })
  pgm.dropTable('suppliers')
}
