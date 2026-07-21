/**
 * Catalogue schema: brands, collections, products, colourways, inventory.
 * Field names mirror atelier-app/src/data/realCatalogue.js and atelier.js designs[].
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('brands', {
    id: 'id',
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true, unique: true },
    story: { type: 'text' },
    country: { type: 'text' },
    currency: { type: 'text', notNull: true },
    is_international: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('collections', {
    id: 'id',
    brand_id: {
      type: 'integer',
      notNull: true,
      references: 'brands',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('collections', 'collections_brand_id_slug_unique', {
    unique: ['brand_id', 'slug'],
  })

  pgm.createTable('products', {
    id: 'id',
    brand_id: {
      type: 'integer',
      notNull: true,
      references: 'brands',
      onDelete: 'CASCADE',
    },
    collection_id: {
      type: 'integer',
      references: 'collections',
      onDelete: 'SET NULL',
    },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true, unique: true },
    product_type: { type: 'text', notNull: true },
    composition: { type: 'text' },
    width: { type: 'text' },
    application: { type: 'text' },
    rubs: { type: 'text' },
    price_band: { type: 'text' },
    lead_time: { type: 'text' },
    retail_price_cents: { type: 'integer' },
    currency: { type: 'text', notNull: true },
    show_on_website: { type: 'boolean', notNull: true, default: false },
    hi_res_asset_url: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('products', 'products_product_type_check', {
    check: "product_type IN ('fabric', 'finished_good')",
  })
  pgm.createIndex('products', 'brand_id')
  pgm.createIndex('products', 'collection_id')

  pgm.createTable('colourways', {
    id: 'id',
    product_id: {
      type: 'integer',
      notNull: true,
      references: 'products',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    sku: { type: 'text', notNull: true, unique: true },
    hex_tones: { type: 'jsonb' },
    image_url: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('colourways', 'product_id')

  // One inventory row per colourway; reservations tracked separately from stock.
  pgm.createTable('inventory', {
    id: 'id',
    colourway_id: {
      type: 'integer',
      notNull: true,
      unique: true,
      references: 'colourways',
      onDelete: 'CASCADE',
    },
    qty_available: { type: 'numeric(12,2)', notNull: true, default: 0 },
    qty_reserved: { type: 'numeric(12,2)', notNull: true, default: 0 },
    unit: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('inventory', 'inventory_unit_check', {
    check: "unit IN ('metres', 'units')",
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('inventory')
  pgm.dropTable('colourways')
  pgm.dropTable('products')
  pgm.dropTable('collections')
  pgm.dropTable('brands')
}
