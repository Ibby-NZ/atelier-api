/**
 * Legacy D365 staging schema — the landing zone for the Dynamics 365 exports in
 * `incoming/data-exports/` (see `docs/d365-export-analysis.md`).
 *
 * These tables are deliberately SEPARATE from the live commerce/catalogue tables:
 *
 *  - the A1/A2/A3 definitions (cost source, what counts as a sale, stock authority)
 *    are still unsettled, so the mapping into live tables is not yet decidable;
 *  - Atelier runs live on D365 until cutover, so the import has to run repeatedly —
 *    a staging table keyed on the D365 GUID makes a re-pull an idempotent upsert;
 *  - `orders`/`order_lines` are owned by the Stripe webhook and the admin-orders
 *    state machine. Injecting historic D365 orders there would desync `qty_reserved`.
 *
 * Every table carries the D365 record GUID as the primary key, the export's row
 * checksum (so a re-pull can tell changed rows from unchanged ones), the source
 * filename, and a `raw` jsonb holding every non-empty column verbatim keyed by D365
 * logical name. Typed columns are the ones we actually query; `raw` guarantees
 * nothing from the export is lost even though the environment is being wound down.
 *
 * Timestamps are `timestamp` (no zone) on purpose: the export writes Excel serials
 * rendered in the exporting user's local time, so tagging them UTC would silently
 * shift every date by the NZ offset.
 *
 * Bank-account columns are dropped at conversion time and never reach this schema.
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

const MONEY = { type: 'numeric(18,4)' }
const QTY = { type: 'numeric(18,4)' }

export const up = (pgm) => {
  // ---- Product Prices (atelier_productprices) — the §3.5 gold dataset -------
  // Inputs + all eight waterfall outputs + the FX pair + the manual-override lane.
  pgm.createTable('legacy_product_prices', {
    ...KEY,
    code: { type: 'text' },
    description: { type: 'text' },
    range_name: { type: 'text' },
    item_type: { type: 'text' },
    pack_type: { type: 'text' },
    contents: { type: 'text' },
    width: { type: 'text' },
    repeat: { type: 'text' },
    vertical_repeat: { type: 'text' },
    date_effective: { type: 'date' },

    // Parameters that survive into the export (the other three live on the range).
    duty_rate: { type: 'text' },
    freight_rate: { type: 'text' },
    currency: { type: 'text' },
    exchange_rate: { type: 'numeric(18,6)' },
    price_exchange_rate: { type: 'numeric(18,6)' },

    // Waterfall: wholesale -> export -> ex duty -> incl duty -> landed -> retail/trade -> tiers.
    wholesale_rate: MONEY,
    wholesale_rate_base: MONEY,
    export_price: MONEY,
    export_price_base: MONEY,
    price_ex_duty_nz: MONEY,
    price_incl_duty_nz: MONEY,
    landed_cost_nz: MONEY,
    retail_sell_price_nz: MONEY,
    trade_sell_price_nz: MONEY,
    trade_sell_price_under_5m_nz: MONEY,
    sell_price_5pct_nz: MONEY,
    sell_price_10pct_nz: MONEY,

    // The `atelier_manual*` override lane. Populated on <0.4% of rows; paired with
    // set_prices_manually, this is the calculated/override split from Build Spec §3.4.
    set_prices_manually: { type: 'boolean' },
    manual_duty_pct: { type: 'numeric(18,6)' },
    manual_markup_to_trade_pct: { type: 'numeric(18,6)' },
    manual_freight_shipping_nz: MONEY,
    manual_price_incl_freight_nz: MONEY,
    manual_trade_ex_freight_nz: MONEY,
    manual_wholesale_price: MONEY,
    manual_wholesale_price_base: MONEY,

    tracking_category_1: { type: 'text' },
    tracking_category_2: { type: 'text' },
    status: { type: 'text' },
    status_reason: { type: 'text' },
    created_by: { type: 'text' },
    created_on: { type: 'timestamp' },
    modified_by: { type: 'text' },
    modified_on: { type: 'timestamp' },
    ...AUDIT,
  })
  pgm.createIndex('legacy_product_prices', 'code')
  pgm.createIndex('legacy_product_prices', 'range_name')
  pgm.createIndex('legacy_product_prices', 'set_prices_manually')

  // ---- Stock Items (fulmxero_item) ----------------------------------------
  // One row per saleable SKU. `product_price_list` is a D365 lookup and exports as
  // the linked record's display name, not a GUID — it is a TEXT join key, and it is
  // null on ~14% of rows.
  pgm.createTable('legacy_stock_items', {
    ...KEY,
    item_code: { type: 'text' },
    name: { type: 'text' },
    supplier: { type: 'text' },
    range_name: { type: 'text' },
    item_type: { type: 'text' },
    item_measure: { type: 'text' },
    product_price_list: { type: 'text' },

    opening_stock: QTY,
    stock_on_hand: QTY,
    stock_available: QTY,
    xero_stock_on_hand: QTY,
    xero_to_d365_difference: QTY,
    // Both are free text, not quantities. `Reserve` is a staff note ("ALL 53.5m -
    // Leanne / Harvey") — 112 rows populated, none numeric. Consequence:
    // `inventory.qty_reserved` has NO legacy source and cannot be migrated.
    available_cuts: { type: 'text' },
    reserve_note: { type: 'text' },
    total_inventory_adjustments: QTY,
    total_purchase_invoices: QTY,
    total_purchase_orders: QTY,
    total_sales_invoices: QTY,
    total_sales_orders: QTY,

    min_qty_to_avoid_surcharge: QTY,
    retail_price: MONEY,
    retail_price_base: MONEY,
    trade_price: MONEY,
    trade_price_base: MONEY,
    trade_price_with_surcharge: MONEY,
    trade_price_with_surcharge_base: MONEY,
    currency: { type: 'text' },
    exchange_rate: { type: 'numeric(18,6)' },

    can_sell: { type: 'boolean' },
    can_purchase: { type: 'boolean' },
    can_track: { type: 'boolean' },

    // The Xero chart-of-accounts mapping lives on the stock item, not the account.
    sales_account: { type: 'text' },
    purchasing_account: { type: 'text' },
    inventory_account: { type: 'text' },
    sales_tax_rate: { type: 'text' },
    purchasing_tax_rate: { type: 'text' },
    sales_description: { type: 'text' },
    purchasing_description: { type: 'text' },
    tracking_category_1: { type: 'text' },
    tracking_category_2: { type: 'text' },

    owner: { type: 'text' },
    status: { type: 'text' },
    status_reason: { type: 'text' },
    created_by: { type: 'text' },
    created_on: { type: 'timestamp' },
    modified_by: { type: 'text' },
    modified_on: { type: 'timestamp' },
    ...AUDIT,
  })
  pgm.createIndex('legacy_stock_items', 'item_code')
  pgm.createIndex('legacy_stock_items', 'product_price_list')
  pgm.createIndex('legacy_stock_items', 'supplier')

  // ---- Accounts (account) --------------------------------------------------
  // One D365 `account` row is a customer, a supplier, or both — split on the flags,
  // never on the view name the export came from.
  pgm.createTable('legacy_accounts', {
    ...KEY,
    name: { type: 'text' },
    atelier_account_number: { type: 'text' },
    exonet_dr_account_number: { type: 'text' },
    exonet_crac_number: { type: 'text' },
    xero_contact_id: { type: 'text' },

    is_customer: { type: 'boolean' },
    is_supplier: { type: 'boolean' },
    customer_type: { type: 'text' },
    relationship_type: { type: 'text' },
    business_type: { type: 'text' },
    classification: { type: 'text' },
    industry: { type: 'text' },
    marketing_category: { type: 'text' },
    rating: { type: 'text' },
    parent_account: { type: 'text' },
    owner: { type: 'text' },
    primary_contact: { type: 'text' },
    primary_contact_email: { type: 'text' },

    email: { type: 'text' },
    main_phone: { type: 'text' },
    other_phone: { type: 'text' },
    fax: { type: 'text' },
    website: { type: 'text' },

    // A7: territory is the macro-region, province the city/region. Both populated.
    territory: { type: 'text' },
    province: { type: 'text' },

    address1_composite: { type: 'text' },
    address1_name: { type: 'text' },
    address1_street1: { type: 'text' },
    address1_street2: { type: 'text' },
    address1_street3: { type: 'text' },
    address1_city: { type: 'text' },
    address1_state: { type: 'text' },
    address1_postal_code: { type: 'text' },
    address1_country: { type: 'text' },
    address1_county: { type: 'text' },
    address1_type: { type: 'text' },

    address2_composite: { type: 'text' },
    address2_name: { type: 'text' },
    address2_street1: { type: 'text' },
    address2_street2: { type: 'text' },
    address2_street3: { type: 'text' },
    address2_city: { type: 'text' },
    address2_state: { type: 'text' },
    address2_postal_code: { type: 'text' },
    address2_country: { type: 'text' },
    address2_county: { type: 'text' },
    address2_type: { type: 'text' },
    shipping_method: { type: 'text' },

    currency: { type: 'text' },
    exchange_rate: { type: 'numeric(18,6)' },
    discount: { type: 'numeric(18,4)' },
    credit_limit: MONEY,
    credit_limit_base: MONEY,
    credit_hold: { type: 'boolean' },
    payment_terms: { type: 'text' },
    payment_terms_sales: { type: 'text' },
    payment_terms_bills: { type: 'text' },
    payment_with_order: { type: 'boolean' },
    bill_days: { type: 'numeric(18,4)' },
    sales_days: { type: 'numeric(18,4)' },
    sales_days_suffix: { type: 'text' },
    exo_sales_payment_terms: { type: 'text' },
    exo_bill_payment_terms: { type: 'text' },

    default_reserve_days: { type: 'numeric(18,4)' },
    order_stock_check_details: { type: 'text' },
    sales_warning_message: { type: 'text' },
    oldest_sample_due_back: { type: 'timestamp' },
    last_sales_contact: { type: 'timestamp' },
    next_sales_contact_due: { type: 'timestamp' },

    // Consent state — must survive migration before any Mailchimp push.
    // Polarity is D365's, not the display label's: these are `donot*` attributes, so
    // TRUE means "do not contact". The export renders true/false as
    // "Do Not Allow"/"Allow" and "Do Not Send"/"Send" — the words read inverted.
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
    preferred_contact_method: { type: 'text' },
    last_date_included_in_campaign: { type: 'timestamp' },

    description: { type: 'text' },
    status: { type: 'text' },
    status_reason: { type: 'text' },
    created_by: { type: 'text' },
    created_on: { type: 'timestamp' },
    modified_by: { type: 'text' },
    modified_on: { type: 'timestamp' },
    ...AUDIT,
  })
  pgm.createIndex('legacy_accounts', 'name')
  pgm.createIndex('legacy_accounts', 'xero_contact_id')
  pgm.createIndex('legacy_accounts', 'is_customer')
  pgm.createIndex('legacy_accounts', 'is_supplier')

  // ---- Sales Orders (fulmxero_salesorder) ----------------------------------
  // Header only. The line-item entity is a separate export and is NOT yet available;
  // without it there is no SKU, qty or unit price for any legacy order.
  pgm.createTable('legacy_sales_orders', {
    ...KEY,
    number: { type: 'text' },
    customer: { type: 'text' },
    contact: { type: 'text' },
    reference: { type: 'text' },
    order_date: { type: 'timestamp' },
    expected_delivery_date: { type: 'timestamp' },

    total_ex_gst: MONEY,
    gst: MONEY,
    total_incl_gst: MONEY,
    total_ex_gst_base: MONEY,
    gst_base: MONEY,
    total_incl_gst_base: MONEY,
    currency: { type: 'text' },
    exchange_rate: { type: 'numeric(18,6)' },

    // A12: the discount tier is recorded per ORDER, not per account.
    pricing_type: { type: 'text' },
    sales_order_discount_pct: { type: 'numeric(18,4)' },

    deliver_to: { type: 'text' },
    mark_parcel: { type: 'text' },
    last_sent: { type: 'timestamp' },
    on_behalf_of: { type: 'text' },
    owner: { type: 'text' },
    owning_business_unit: { type: 'text' },
    status: { type: 'text' },
    status_reason: { type: 'text' },
    created_by: { type: 'text' },
    created_on: { type: 'timestamp' },
    modified_by: { type: 'text' },
    modified_on: { type: 'timestamp' },
    ...AUDIT,
  })
  pgm.createIndex('legacy_sales_orders', 'number')
  pgm.createIndex('legacy_sales_orders', 'customer')
  pgm.createIndex('legacy_sales_orders', 'status_reason')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('legacy_sales_orders')
  pgm.dropTable('legacy_accounts')
  pgm.dropTable('legacy_stock_items')
  pgm.dropTable('legacy_product_prices')
}
