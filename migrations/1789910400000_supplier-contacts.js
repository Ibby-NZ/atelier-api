/**
 * Supplier contact management: who to talk to at a house, and when Atelier
 * last did.
 *
 * The client's feedback named both gaps directly: "there doesn't appear to be
 * any contact details (phone, address etc) and we need multiple contacts within
 * each company", and "there is no tracking of when we were last in contact with
 * them". Until now the only contact-ish field on `suppliers` was `po_email` —
 * an internal ordering address, not a person.
 *
 * THREE SHAPES, ONE MIGRATION:
 *   - General contact details on `suppliers` itself (phone/address/website/notes)
 *     — the showrooms address-book shape (1786680000000) minus `city` (suppliers
 *     already carry `country`) and minus `contact_*` (people are rows below).
 *   - `supplier_contacts`: the PEOPLE. Several per house is the whole point
 *     (Colefax has a sales contact and an accounts contact).
 *   - `supplier_contact_log`: APPEND-ONLY history of staff↔supplier contact —
 *     date, who at Atelier, how (call/email/visit/showroom), a note, and an
 *     optional follow-up date. The newest entry is surfaced on the supplier
 *     list so the office can see at a glance who has gone quiet.
 *
 * WHY BOTH CHILDREN CASCADE. They are address-book data about the supplier,
 * not business records that must survive it — exactly the `supplier_aliases`
 * reasoning. Keeping them CASCADE also leaves `deleteOrExplain`'s blocker
 * story unchanged: brands (RESTRICT) + price_list_items (SET NULL), nothing new.
 *
 * WHO-DID-IT ON THE LOG is the `sample_loan_reminders.sent_by` pair: an FK that
 * SET NULLs when the staff account is deleted, beside a NOT NULL `staff_name`
 * snapshot so the entry stays legible forever ("visit — Rebecca" must not decay
 * into "visit — nobody").
 *
 * `contacted_on` is a DATE, not a timestamptz: staff log "we called them on the
 * 2nd", often a day or two later, and a back-dated entry must carry its day.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('suppliers', {
    phone: { type: 'text' },
    address: { type: 'text' },
    // Same name the column has on brands.
    website_url: { type: 'text' },
    notes: { type: 'text' },
  })

  pgm.createTable('supplier_contacts', {
    id: 'id',
    supplier_id: {
      type: 'integer',
      notNull: true,
      references: 'suppliers',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    // Free text: "Export manager", "Accounts" — the houses don't share a
    // vocabulary, so there is nothing to CHECK.
    role: { type: 'text' },
    email: { type: 'text' },
    phone: { type: 'text' },
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('supplier_contacts', 'supplier_id')

  pgm.createTable('supplier_contact_log', {
    id: 'id',
    supplier_id: {
      type: 'integer',
      notNull: true,
      references: 'suppliers',
      onDelete: 'CASCADE',
    },
    contacted_on: { type: 'date', notNull: true, default: pgm.func('CURRENT_DATE') },
    staff_user_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    staff_name: { type: 'text', notNull: true },
    method: {
      type: 'text',
      notNull: true,
      check: "method IN ('call','email','visit','showroom')",
    },
    note: { type: 'text' },
    follow_up_on: { type: 'date' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // One index serves both readers: the paginated log (newest first) and the
  // supplier list's LATERAL "most recent entry" probe.
  pgm.createIndex(
    'supplier_contact_log',
    ['supplier_id', { name: 'contacted_on', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
    { name: 'supplier_contact_log_recent_idx' }
  )
}

export const down = (pgm) => {
  pgm.dropTable('supplier_contact_log')
  pgm.dropTable('supplier_contacts')
  pgm.dropColumns('suppliers', ['phone', 'address', 'website_url', 'notes'])
}
