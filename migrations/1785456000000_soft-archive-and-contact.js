/**
 * Soft-archive support + contact enquiries.
 *
 * The back office needs to remove clients, stock, price-list items, catalogue
 * entries and orders from their working lists WITHOUT destroying commerce or
 * accounting records — `order_lines.colourway_id` is ON DELETE RESTRICT and a
 * deleted user would SET NULL across their order history. So "delete" in the
 * CRM is a soft archive: a nullable `archived_at` timestamp. A row with
 * `archived_at IS NOT NULL` is hidden from the default admin and public reads
 * but stays fully intact and restorable.
 *
 * `contact_enquiries` backs the storefront contact form (the live atelier.co.nz
 * has one; ours was static text). Each submission is both emailed to the back
 * office and stored here so nothing is lost. `user_id` is SET NULL — a
 * logged-in sender is linked, but the enquiry survives the account being
 * archived/removed. It carries its own `archived_at` so the inbox can be tidied
 * the same way as everything else.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
const ARCHIVABLE_TABLES = [
  'orders',
  'users',
  'brands',
  'collections',
  'products',
  'colourways',
  'price_list_items',
]

export const up = (pgm) => {
  for (const table of ARCHIVABLE_TABLES) {
    pgm.addColumns(table, {
      archived_at: { type: 'timestamptz' },
    })
    // Partial index: the common read filters on archived_at IS NULL, so index
    // only the live rows (small, hot set) rather than the whole column.
    pgm.createIndex(table, 'archived_at', {
      name: `${table}_archived_at_live_idx`,
      where: 'archived_at IS NULL',
    })
  }

  pgm.createTable('contact_enquiries', {
    id: 'id',
    name: { type: 'text', notNull: true },
    email: { type: 'text', notNull: true },
    phone: { type: 'text' },
    subject: { type: 'text' },
    message: { type: 'text', notNull: true },
    // Where the enquiry originated, so a future newsletter/trade form can share
    // the table. Defaults to the storefront contact form.
    source: { type: 'text', notNull: true, default: 'contact_form' },
    user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    archived_at: { type: 'timestamptz' },
  })
  pgm.createIndex('contact_enquiries', 'created_at')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('contact_enquiries')
  for (const table of ARCHIVABLE_TABLES) {
    pgm.dropIndex(table, 'archived_at', {
      name: `${table}_archived_at_live_idx`,
    })
    pgm.dropColumns(table, ['archived_at'])
  }
}
