/**
 * Legacy D365 staging, round two — the 30 Jul pull.
 *
 * Adds the seven entities that landed after the first four: contacts, reserves,
 * cuttings, item locations, purchase orders, purchase invoices, sales invoices.
 * Same conventions as 1785542400000_legacy-d365-staging: D365 GUID primary key,
 * export row checksum, `source_file`, and a `raw` jsonb holding every non-empty
 * source column by logical name. Naive `timestamp` throughout (Excel serials are
 * rendered in the exporting user's local time).
 *
 * Two of these change earlier conclusions:
 *
 *  - `legacy_reserves` is the REAL source of reserved quantity. The `Reserve`
 *    column on the stock item is a free-text staff note; this entity carries a
 *    numeric `quantity` plus an expiry date, so `inventory.qty_reserved` does have
 *    a legacy source after all.
 *  - `legacy_sales_invoices` carries both a sales-order reference and the Xero
 *    invoice id, which is the join the A2 ("what counts as a sale") and A4 (Xero
 *    boundary) decisions need. It is real invoiced history, unlike the 48-row
 *    open-orders export.
 *
 * Portal identity columns on `contact` (password hash, security stamp) are dropped
 * at conversion time and never reach this schema.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */

const AUDIT = {
  source_file: { type: 'text', notNull: true },
  exported_at: { type: 'timestamp' },
  raw: { type: 'jsonb', notNull: true },
  imported_at: { type: 'timestamptz', notNull: true, default: 'now()' },
}

const KEY = {
  guid: { type: 'uuid', primaryKey: true },
  row_checksum: { type: 'text' },
}

const STAMPS = {
  owner: { type: 'text' },
  status: { type: 'text' },
  status_reason: { type: 'text' },
  created_by: { type: 'text' },
  created_on: { type: 'timestamp' },
  modified_by: { type: 'text' },
  modified_on: { type: 'timestamp' },
}

const MONEY = { type: 'numeric(18,4)' }
const QTY = { type: 'numeric(18,4)' }
const RATE = { type: 'numeric(18,6)' }

export const up = (pgm) => {
  // ---- Contacts (contact) --------------------------------------------------
  // The account's people. Account email is sparse (454/866) while the contact's is
  // not, so this is where usable email actually lives.
  pgm.createTable('legacy_contacts', {
    ...KEY,
    full_name: { type: 'text' },
    first_name: { type: 'text' },
    last_name: { type: 'text' },
    middle_name: { type: 'text' },
    salutation: { type: 'text' },
    suffix: { type: 'text' },
    nickname: { type: 'text' },
    job_title: { type: 'text' },
    department: { type: 'text' },
    company_name: { type: 'text' },
    role: { type: 'text' },
    relationship_type: { type: 'text' },
    territory: { type: 'text' },

    email: { type: 'text' },
    email2: { type: 'text' },
    email3: { type: 'text' },
    business_phone: { type: 'text' },
    business_phone2: { type: 'text' },
    home_phone: { type: 'text' },
    telephone3: { type: 'text' },
    mobile_phone: { type: 'text' },
    fax: { type: 'text' },
    website: { type: 'text' },

    address1_composite: { type: 'text' },
    address1_street1: { type: 'text' },
    address1_street2: { type: 'text' },
    address1_city: { type: 'text' },
    address1_state: { type: 'text' },
    address1_postal_code: { type: 'text' },
    address1_country: { type: 'text' },
    address1_phone: { type: 'text' },
    address2_composite: { type: 'text' },
    address3_composite: { type: 'text' },
    shipping_method: { type: 'text' },

    payment_terms: { type: 'text' },
    price_list: { type: 'text' },
    currency: { type: 'text' },
    exchange_rate: RATE,
    credit_limit: MONEY,
    credit_hold: { type: 'boolean' },
    back_office_customer: { type: 'boolean' },
    lead_source: { type: 'text' },
    preferred_contact_method: { type: 'text' },
    is_primary_contact: { type: 'boolean' },

    xero_contact_number: { type: 'text' },
    xero_contact_person_id: { type: 'text' },
    oldest_sample_due_back: { type: 'timestamp' },

    // Same D365 polarity trap as legacy_accounts: TRUE means "do not contact",
    // even though the export renders false as the words "Allow" / "Send".
    include_in_emails: { type: 'boolean' },
    marketing_only: { type: 'boolean' },
    do_not_send_marketing_materials: { type: 'boolean' },
    gdpr_optout: { type: 'boolean' },
    do_not_email: { type: 'boolean' },
    do_not_bulk_email: { type: 'boolean' },
    do_not_phone: { type: 'boolean' },
    do_not_fax: { type: 'boolean' },
    do_not_postal_mail: { type: 'boolean' },
    do_not_bulk_postal_mail: { type: 'boolean' },
    follow_email_activity: { type: 'boolean' },
    last_date_included_in_campaign: { type: 'timestamp' },

    description: { type: 'text' },
    ...STAMPS,
    ...AUDIT,
  })
  pgm.createIndex('legacy_contacts', 'company_name')
  pgm.createIndex('legacy_contacts', 'email')
  pgm.createIndex('legacy_contacts', 'xero_contact_number')

  // ---- Reserves (fulmar_reserve) ------------------------------------------
  // The actual reserved-quantity ledger: numeric qty + expiry + customer.
  pgm.createTable('legacy_reserves', {
    ...KEY,
    name: { type: 'text' },
    reserve_number: { type: 'text' },
    range_name: { type: 'text' },
    customer: { type: 'text' },
    customer_contact: { type: 'text' },
    customer_owner: { type: 'text' },
    product: { type: 'text' },
    product_code: { type: 'text' },
    colour_code: { type: 'text' },
    supplier: { type: 'text' },
    quantity: QTY,
    reserved_until: { type: 'timestamp' },
    default_reserved_until: { type: 'timestamp' },
    cfa: { type: 'text' },
    comments: { type: 'text' },
    order_stock_check_details: { type: 'text' },
    ...STAMPS,
    ...AUDIT,
  })
  pgm.createIndex('legacy_reserves', 'product_code')
  pgm.createIndex('legacy_reserves', 'customer')
  pgm.createIndex('legacy_reserves', 'reserved_until')

  // ---- Cuttings (fulmar_cutting) ------------------------------------------
  pgm.createTable('legacy_cuttings', {
    ...KEY,
    name: { type: 'text' },
    range_name: { type: 'text' },
    customer: { type: 'text' },
    customer_contact: { type: 'text' },
    customer_owner: { type: 'text' },
    product: { type: 'text' },
    product_code: { type: 'text' },
    colour_code: { type: 'text' },
    supplier: { type: 'text' },
    quantity: QTY,
    comments: { type: 'text' },
    order_stock_check_details: { type: 'text' },
    ...STAMPS,
    ...AUDIT,
  })
  pgm.createIndex('legacy_cuttings', 'product_code')
  pgm.createIndex('legacy_cuttings', 'customer')

  // ---- Item locations (fulmxero_itemlocation) -----------------------------
  // Per-location stock. `legacy_stock_items` holds the roll-up; this is the split.
  pgm.createTable('legacy_item_locations', {
    ...KEY,
    description: { type: 'text' },
    item: { type: 'text' },
    location: { type: 'text' },
    opening_units_in_stock: QTY,
    total_stock_on_hand: QTY,
    total_stock_available: QTY,
    total_item_adjustments: QTY,
    total_purchase_invoices: QTY,
    total_purchase_orders: QTY,
    total_sales_invoices: QTY,
    total_sales_orders: QTY,
    ...STAMPS,
    ...AUDIT,
  })
  pgm.createIndex('legacy_item_locations', 'item')
  pgm.createIndex('legacy_item_locations', 'location')

  // ---- Purchase orders (fulmxero_purchaseorder) ---------------------------
  // Header only — no PO lines in this pull, so outstanding-balance
  // (ordered − received) is still not computable.
  pgm.createTable('legacy_purchase_orders', {
    ...KEY,
    number: { type: 'text' },
    vendor: { type: 'text' },
    vendor_contact: { type: 'text' },
    order_date: { type: 'timestamp' },
    pickup_date: { type: 'timestamp' },
    reference: { type: 'text' },
    summary: { type: 'text' },
    attention: { type: 'text' },
    phone: { type: 'text' },
    location: { type: 'text' },
    // A13: the per-supplier default shipping agent, which is empty on the account.
    shipping_agent: { type: 'text' },
    shipping_contact: { type: 'text' },
    delivery_address: { type: 'text' },
    delivery_instructions: { type: 'text' },
    currency: { type: 'text' },
    exchange_rate: RATE,
    total_ex_gst: MONEY,
    gst: MONEY,
    total_incl_gst: MONEY,
    total_ex_gst_base: MONEY,
    gst_base: MONEY,
    total_incl_gst_base: MONEY,
    last_sent: { type: 'timestamp' },
    ...STAMPS,
    ...AUDIT,
  })
  pgm.createIndex('legacy_purchase_orders', 'number')
  pgm.createIndex('legacy_purchase_orders', 'vendor')
  pgm.createIndex('legacy_purchase_orders', 'shipping_agent')

  // ---- Purchase invoices (fulmxero_purchaseinvoice) -----------------------
  pgm.createTable('legacy_purchase_invoices', {
    ...KEY,
    number: { type: 'text' },
    vendor: { type: 'text' },
    invoice_date: { type: 'timestamp' },
    due_date: { type: 'timestamp' },
    reference: { type: 'text' },
    summary: { type: 'text' },
    shipping_agents_invoice_number: { type: 'text' },
    currency: { type: 'text' },
    exchange_rate: RATE,
    total_ex_gst: MONEY,
    gst: MONEY,
    total_incl_gst: MONEY,
    total_ex_gst_base: MONEY,
    gst_base: MONEY,
    total_incl_gst_base: MONEY,
    temp_invoice_date: { type: 'timestamp' },
    temp_invoice_due_date: { type: 'timestamp' },
    xero_invoice_id: { type: 'text' },
    xero_interface_error: { type: 'text' },
    ...STAMPS,
    ...AUDIT,
  })
  pgm.createIndex('legacy_purchase_invoices', 'number')
  pgm.createIndex('legacy_purchase_invoices', 'vendor')
  pgm.createIndex('legacy_purchase_invoices', 'xero_invoice_id')

  // ---- Sales invoices (fulmxero_salesinvoice) -----------------------------
  // The A2/A4 spine: invoiced sales history, each row carrying its sales-order
  // reference AND its Xero invoice id.
  pgm.createTable('legacy_sales_invoices', {
    ...KEY,
    number: { type: 'text' },
    invoice_suffix: { type: 'text' },
    customer: { type: 'text' },
    customer_contact: { type: 'text' },
    sales_order: { type: 'text' },
    invoice_date: { type: 'timestamp' },
    due_date: { type: 'timestamp' },
    reference: { type: 'text' },
    summary: { type: 'text' },
    currency: { type: 'text' },
    exchange_rate: RATE,
    total_ex_gst: MONEY,
    gst: MONEY,
    total_incl_gst: MONEY,
    total_ex_gst_base: MONEY,
    gst_base: MONEY,
    total_incl_gst_base: MONEY,
    pricing_type: { type: 'text' },
    sales_invoice_discount_pct: { type: 'numeric(18,4)' },
    temp_invoice_date: { type: 'timestamp' },
    temp_invoice_due_date: { type: 'timestamp' },
    xero_invoice_id: { type: 'text' },
    xero_interface_error: { type: 'text' },
    last_sent: { type: 'timestamp' },
    ...STAMPS,
    ...AUDIT,
  })
  pgm.createIndex('legacy_sales_invoices', 'number')
  pgm.createIndex('legacy_sales_invoices', 'customer')
  pgm.createIndex('legacy_sales_invoices', 'sales_order')
  pgm.createIndex('legacy_sales_invoices', 'xero_invoice_id')
  pgm.createIndex('legacy_sales_invoices', 'invoice_date')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('legacy_sales_invoices')
  pgm.dropTable('legacy_purchase_invoices')
  pgm.dropTable('legacy_purchase_orders')
  pgm.dropTable('legacy_item_locations')
  pgm.dropTable('legacy_cuttings')
  pgm.dropTable('legacy_reserves')
  pgm.dropTable('legacy_contacts')
}
