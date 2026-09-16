/**
 * Sample requests — the storefront's "Request a sample" enquiry cart (16 Sep
 * 2026): a shopper collects colourways on a list and sends them as ONE request,
 * which lands here as `pending` for the back office to send or decline.
 *
 * A DIFFERENT record from `sample_orders` (showroom stocking from the houses)
 * and from `samples` (the physical register): this is a client asking Atelier
 * for cuttings, not Atelier asking a house, and it names a person, not a
 * showroom. Same two-table shape as an order: a header the office moves through
 * a tiny lifecycle, and lines that snapshot what was asked for.
 *
 * `colourway_id` is SET NULL and the line keeps its own sku / product / colour
 * text: a request is a record of what someone asked for on the day, and the
 * catalogue being tidied afterwards must neither block that tidy-up nor blank
 * the request. `user_id` is SET NULL like every other client record.
 *
 * Not stock: nothing here reads or writes an inventory figure, and the samples
 * schema test's source scan covers this file.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('sample_requests', {
    id: 'id',
    request_number: { type: 'text', notNull: true, unique: true },
    user_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    contact_name: { type: 'text' },
    contact_email: { type: 'text', notNull: true },
    contact_phone: { type: 'text' },
    notes: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'sent', 'declined')",
    },
    sent_at: { type: 'timestamptz' },
    declined_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    archived_at: { type: 'timestamptz' },
  })
  pgm.createIndex('sample_requests', 'status')
  pgm.createIndex('sample_requests', 'user_id')
  pgm.createIndex('sample_requests', 'created_at')

  pgm.createTable('sample_request_lines', {
    id: 'id',
    sample_request_id: {
      type: 'integer',
      notNull: true,
      references: 'sample_requests',
      onDelete: 'CASCADE',
    },
    colourway_id: { type: 'integer', references: 'colourways', onDelete: 'SET NULL' },
    sku: { type: 'text', notNull: true },
    product_name: { type: 'text' },
    colourway_name: { type: 'text' },
    brand_name: { type: 'text' },
    note: { type: 'text' },
  })
  pgm.createIndex('sample_request_lines', 'sample_request_id')
  pgm.createIndex('sample_request_lines', 'colourway_id')
}

export const down = (pgm) => {
  pgm.dropTable('sample_request_lines')
  pgm.dropTable('sample_requests')
}
