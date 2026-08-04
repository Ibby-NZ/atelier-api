/**
 * Trade accounts: the link between a storefront LOGIN and a D365 CUSTOMER.
 *
 * `users` is a person who can sign in. A trade client is a company, and every
 * historical record Atelier holds — invoices, cuttings, reserves, sales orders —
 * belongs to the company, in the `legacy_*` staging tables. Nothing joined the
 * two, so an approved trade account could see trade pricing and its own web
 * orders and nothing else. This is that join.
 *
 * TWO TABLES, NOT A COLUMN ON `users`, and deliberately OUTSIDE the `legacy_*`
 * namespace: `importLegacyEntity` upserts every mapped column to EXCLUDED on the
 * D365 GUID, so anything Atelier stored on a legacy row would be destroyed by
 * the next `npm run import:legacy`. These tables are ours; the import never
 * touches them.
 *
 * WHY THE GUID *AND* THE NAME. The D365 account GUID is the stable identity and
 * is what a human links to. But the transaction exports do not carry it: a
 * lookup column exports as the target's DISPLAY NAME, so
 * `legacy_sales_invoices.customer` is the account's `name` as text (documented
 * in docs/d365-export-analysis.md). So the GUID is the key and
 * `legacy_customer_name` is a SNAPSHOT of the name taken at link time, which is
 * what the reads actually match on.
 *
 * WHY `name_is_ambiguous`. Account names are NOT unique — 866 rows, 865 distinct
 * names ('peter kedgley architects' twice, holding 2 invoices between them). A
 * name-equality predicate therefore returns the UNION of every account sharing
 * that name, which is a cross-client disclosure by construction. The flag is
 * computed once at link time and every client-facing read requires it to be
 * false, so a colliding name serves NOTHING and is raised to staff rather than
 * quietly serving someone else's financial history.
 *
 * WHY `UNIQUE (user_id)`. One login belongs to one company. Without it a
 * back-office mis-click links a person to a second firm, and a viewer query that
 * returns one row starts returning a non-deterministic one — intermittent
 * cross-company disclosure. "This designer works for two firms" is a real case;
 * it needs a deliberate design (which company's history? both? a switcher?), not
 * a silent side effect. The composite PK still allows several logins per
 * company, which IS the common case — the trade application collects a design
 * contact and an accounts contact.
 *
 * The account-manager columns are nullable and STAFF-SET. They are not derived
 * from `legacy_accounts.owner`: 72% of that column is a shared login ('Atelier
 * Sales' 491, 'Showroom #' 135), and A6 (salesperson vs owner vs account holder)
 * is still open. Null degrades to the generic showroom contact block, which is
 * the honest default.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('trade_accounts', {
    id: 'id',
    // The D365 account this company is in Dynamics. Stable across re-exports;
    // unique because two trade_accounts rows for one customer would each serve
    // the same history under different account-manager details.
    legacy_account_guid: { type: 'uuid', notNull: true, unique: true },
    // Snapshot of legacy_accounts.name at link time — the join key into the
    // transaction tables, which carry the customer as a display name.
    legacy_customer_name: { type: 'text', notNull: true },
    // True when that name matched more than one legacy account. Client reads
    // fail closed on it.
    name_is_ambiguous: { type: 'boolean', notNull: true, default: false },

    // Client-visible account manager. Null → the storefront shows the generic
    // showroom contact instead of inventing an attribution.
    account_manager_name: { type: 'text' },
    account_manager_email: { type: 'text' },
    account_manager_phone: { type: 'text' },

    // Who made the link. SET NULL: the audit trail outlives the staff account,
    // same posture as trade_applications.user_id.
    linked_by_user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },

    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createIndex('trade_accounts', 'legacy_customer_name')

  pgm.createTable('trade_account_users', {
    trade_account_id: {
      type: 'integer',
      notNull: true,
      references: 'trade_accounts',
      onDelete: 'CASCADE',
    },
    // CASCADE, not SET NULL: this row is an access grant, not a business
    // record. A deleted login must not leave a dangling grant behind.
    user_id: {
      type: 'integer',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.addConstraint('trade_account_users', 'trade_account_users_pkey', {
    primaryKey: ['trade_account_id', 'user_id'],
  })
  // One login, one company — see the header note. This is the constraint that
  // makes a single-row viewer query safe.
  pgm.addConstraint('trade_account_users', 'trade_account_users_user_id_unique', {
    unique: ['user_id'],
  })

  // The client-facing reads all match `lower(btrim(customer))` against the
  // snapshotted name. Without these the portal sequentially scans 7,002
  // invoices / 1,886 cuttings / 969 reserves on every page load.
  pgm.createIndex('legacy_sales_invoices', 'lower(btrim(customer))', {
    name: 'legacy_sales_invoices_customer_lower_idx',
  })
  pgm.createIndex('legacy_cuttings', 'lower(btrim(customer))', {
    name: 'legacy_cuttings_customer_lower_idx',
  })
  pgm.createIndex('legacy_reserves', 'lower(btrim(customer))', {
    name: 'legacy_reserves_customer_lower_idx',
  })
  pgm.createIndex('legacy_accounts', 'lower(btrim(name))', {
    name: 'legacy_accounts_name_lower_idx',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropIndex('legacy_accounts', 'lower(btrim(name))', {
    name: 'legacy_accounts_name_lower_idx',
  })
  pgm.dropIndex('legacy_reserves', 'lower(btrim(customer))', {
    name: 'legacy_reserves_customer_lower_idx',
  })
  pgm.dropIndex('legacy_cuttings', 'lower(btrim(customer))', {
    name: 'legacy_cuttings_customer_lower_idx',
  })
  pgm.dropIndex('legacy_sales_invoices', 'lower(btrim(customer))', {
    name: 'legacy_sales_invoices_customer_lower_idx',
  })
  pgm.dropTable('trade_account_users')
  pgm.dropTable('trade_accounts')
}
