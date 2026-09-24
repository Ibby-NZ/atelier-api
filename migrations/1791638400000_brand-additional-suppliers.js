/**
 * Two back-office link tables: a house invoiced by more than one supplier, and
 * the discount tier staff pick for a product.
 *
 * BRAND_ADDITIONAL_SUPPLIERS. The office buys some houses through two
 * invoicing entities — Stroheim comes from Fabricut AND from Jim Thompson.
 * `brands.supplier_id` stays exactly what it is: the MAIN supplier, the one
 * pricing, purchase-order planning, the backfill and the reporting codes
 * already derive from. This table holds only the OTHER suppliers, so the main
 * one is never stated twice (src/suppliers/brand-suppliers.js refuses adding
 * the main supplier here, and re-pointing the main supplier drops it from
 * here). A purchase order may be raised against any of them; the choice is
 * snapshotted onto the document like the rest of the supplier fields.
 * Both FKs CASCADE: a link describes a live relationship, not a business record
 * that outlives it — the `supplier_aliases` posture. Purchase orders keep
 * their own RESTRICT edge to `suppliers`, so history is never at risk.
 *
 * PRODUCT_DISCOUNT_TIERS. A house with labelled tiers (JV: 40 / 45 / 50%)
 * had its tier picked only by matching the line's category string to the
 * label, which the CRM's category picker could never produce. This is the
 * explicit choice, one per product. It is COST DATA: no storefront read model
 * may join it, and it is read and written only from src/suppliers/ behind the
 * finance gate. Deleting the tier CASCADEs the choice away, so the product
 * falls back to category matching rather than pointing at nothing.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable(
    'brand_additional_suppliers',
    {
      brand_id: { type: 'integer', notNull: true, references: 'brands', onDelete: 'CASCADE' },
      supplier_id: { type: 'integer', notNull: true, references: 'suppliers', onDelete: 'CASCADE' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { constraints: { primaryKey: ['brand_id', 'supplier_id'] } }
  )
  // The PK leads on brand_id; supplier screens read the other way round.
  pgm.createIndex('brand_additional_suppliers', 'supplier_id')

  pgm.createTable('product_discount_tiers', {
    product_id: { type: 'integer', primaryKey: true, references: 'products', onDelete: 'CASCADE' },
    tier_id: {
      type: 'integer',
      notNull: true,
      references: 'supplier_discount_tiers',
      onDelete: 'CASCADE',
    },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('product_discount_tiers', 'tier_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('product_discount_tiers')
  pgm.dropTable('brand_additional_suppliers')
}
