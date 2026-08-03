/**
 * Trade account applications.
 *
 * The storefront trade form mirrors the paper form on atelier.co.nz
 * (/trade-account-application/): business details, accounts + design contacts,
 * communication preferences, trading account details, a trade reference and the
 * Terms of Trade consent block. Registering still creates the users row
 * (role='trade', unapproved); this table stores the submitted form so the CRM's
 * Applicants tab can show the whole application, not just an approve checkbox.
 *
 * `user_id` is SET NULL like contact_enquiries — the application is a business
 * record and survives the account being removed. Approval state is NOT stored
 * here: `users.trade_approved` stays the single source of truth, so the admin
 * read joins users rather than duplicating a status column that could desync.
 *
 * Free-text fields (directors, trade reference) stay text — the paper form
 * collects them as prose and the back office reads them, nothing queries them.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('trade_applications', {
    id: 'id',
    user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },

    // Customer details
    business_name: { type: 'text', notNull: true },
    registered_name: { type: 'text' },
    postal_address: { type: 'text', notNull: true },
    delivery_address: { type: 'text', notNull: true },
    landline_phone: { type: 'text', notNull: true },
    mobile_phone: { type: 'text', notNull: true },

    // Accounts contact
    accounts_contact_name: { type: 'text', notNull: true },
    accounts_contact_person: { type: 'text', notNull: true },
    accounts_email: { type: 'text', notNull: true },

    // Design contact
    design_contact_name: { type: 'text', notNull: true },
    design_contact_email: { type: 'text', notNull: true },
    design_contact_phone: { type: 'text', notNull: true },
    design_qualifications: { type: 'text', notNull: true },

    // Communication preferences
    mailchimp_opt_in: { type: 'boolean', notNull: true },
    primary_contact_email: { type: 'text', notNull: true },
    wants_showroom_visit: { type: 'boolean', notNull: true, default: false },
    wants_account_manager: { type: 'boolean', notNull: true, default: false },

    // Trading account details
    nzbn: { type: 'text', notNull: true },
    business_type: { type: 'text', notNull: true },
    registered_office_address: { type: 'text', notNull: true },
    directors_names_addresses: { type: 'text', notNull: true },
    directors_dates_of_birth: { type: 'text', notNull: true },
    cash_account_acceptable: { type: 'boolean', notNull: true },

    // Trade reference
    trade_reference: { type: 'text', notNull: true },

    // Consent block
    terms_accepted: { type: 'boolean', notNull: true },
    customer_full_name: { type: 'text', notNull: true },
    signatory_name: { type: 'text', notNull: true },
    signatory_position: { type: 'text', notNull: true },
    signature: { type: 'text', notNull: true },

    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.addConstraint('trade_applications', 'trade_applications_business_type_check', {
    check: "business_type IN ('limited_liability_company', 'sole_trader', 'partnership')",
  })
  pgm.createIndex('trade_applications', 'created_at')
  pgm.createIndex('trade_applications', 'user_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('trade_applications')
}
