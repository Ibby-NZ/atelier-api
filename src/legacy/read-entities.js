// The four Dynamics-365 staging entities the back office can browse, and the
// column/search/filter whitelists that make one config-driven query path safe:
// the entity name and every column name come from here and are never user input,
// while every filter/search VALUE flows through a parameterised placeholder.
//
// Moved out of legacy-read.js so that src/legacy/override-schema.js can read the
// same declaration without importing the read model (which imports it back).
// legacy-read.js re-exports LEGACY_ENTITIES, so nothing outside this directory
// needs to know the config moved.
//
// THE KEYS ARE THE URL VOCABULARY AND ARE NOT THE IMPORT VOCABULARY. These are
// what `/admin/legacy/:entity` takes; LEGACY_TABLES and
// `POST /admin/legacy/import/:entity` take `product_prices`, `stock_items`,
// `sales_orders`, `accounts`. Three of the four names differ and two of those
// are irregular renames, so the two can only be related by the explicit
// `importEntity` key below — never by a string transform.
//
// Seven of the eleven staging tables (contacts, sales_invoices, purchase_orders,
// purchase_invoices, item_locations, reserves, cuttings) have no read route and
// therefore no override capability. Two of them — sales_invoices and cuttings —
// are served to CLIENTS by src/trade-accounts/client-legacy.js, which writes its
// own SQL against the staging tables and is deliberately outside the merge.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

export const ENTITIES = Object.freeze({
  accounts: {
    table: 'legacy_accounts',
    // The LEGACY_TABLES key. src/legacy/override-schema.js resolves every
    // column's cast type through it, so the two can never drift.
    importEntity: 'accounts',
    columns: [
      'guid', 'name', 'atelier_account_number', 'customer_type', 'is_customer',
      'is_supplier', 'primary_contact', 'primary_contact_email', 'email',
      'main_phone', 'other_phone', 'address1_city', 'province', 'territory',
      'currency', 'discount', 'credit_limit', 'payment_terms', 'owner',
      'status', 'status_reason', 'xero_contact_id',
    ],
    search: ['name', 'atelier_account_number', 'primary_contact', 'email'],
    numeric: ['discount', 'credit_limit'],
    // Commercial terms. Editing one is gated on `can_view_finance` — a login
    // that may not SEE a cost figure in a report must not be able to SET one
    // here. See src/routes/admin-legacy.js.
    commercial: ['discount', 'credit_limit', 'payment_terms'],
    filters: { is_customer: 'boolean', is_supplier: 'boolean', customer_type: 'text', owner: 'text' },
    order: 'name ASC NULLS LAST',
  },
  'sales-orders': {
    table: 'legacy_sales_orders',
    importEntity: 'sales_orders',
    columns: [
      'guid', 'number', 'customer', 'contact', 'reference', 'order_date',
      'expected_delivery_date', 'total_ex_gst', 'gst', 'total_incl_gst',
      'currency', 'pricing_type', 'sales_order_discount_pct', 'deliver_to',
      'owner', 'status', 'status_reason',
    ],
    search: ['number', 'customer', 'reference'],
    numeric: ['total_ex_gst', 'gst', 'total_incl_gst', 'sales_order_discount_pct'],
    commercial: [
      'total_ex_gst', 'gst', 'total_incl_gst', 'sales_order_discount_pct',
      'pricing_type',
    ],
    filters: { status_reason: 'text', pricing_type: 'text', owner: 'text' },
    order: 'order_date DESC NULLS LAST, number DESC',
  },
  stock: {
    table: 'legacy_stock_items',
    importEntity: 'stock_items',
    columns: [
      'guid', 'item_code', 'name', 'supplier', 'range_name', 'item_type',
      'item_measure', 'stock_on_hand', 'stock_available', 'reserve_note',
      'retail_price', 'trade_price', 'currency', 'product_price_list',
      'can_sell', 'status', 'status_reason',
    ],
    search: ['item_code', 'name', 'supplier', 'range_name'],
    numeric: ['stock_on_hand', 'stock_available', 'retail_price', 'trade_price'],
    commercial: ['retail_price', 'trade_price', 'product_price_list'],
    filters: { supplier: 'text', item_type: 'text', product_price_list: 'text' },
    order: 'name ASC NULLS LAST, item_code ASC',
  },
  prices: {
    table: 'legacy_product_prices',
    importEntity: 'product_prices',
    columns: [
      'guid', 'code', 'description', 'range_name', 'item_type', 'pack_type',
      'contents', 'width', 'repeat', 'vertical_repeat', 'currency',
      'exchange_rate', 'price_exchange_rate', 'wholesale_rate', 'landed_cost_nz',
      'retail_sell_price_nz', 'trade_sell_price_nz', 'trade_sell_price_under_5m_nz',
      'set_prices_manually', 'status', 'status_reason',
    ],
    search: ['code', 'description', 'range_name'],
    numeric: [
      'exchange_rate', 'price_exchange_rate', 'wholesale_rate', 'landed_cost_nz',
      'retail_sell_price_nz', 'trade_sell_price_nz', 'trade_sell_price_under_5m_nz',
    ],
    // Every price on the row, the two FX rates every one of them is derived
    // through, and the manual-pricing flag that decides whether D365 recomputes
    // them.
    commercial: [
      'exchange_rate', 'price_exchange_rate', 'wholesale_rate', 'landed_cost_nz',
      'retail_sell_price_nz', 'trade_sell_price_nz', 'trade_sell_price_under_5m_nz',
      'set_prices_manually',
    ],
    filters: { range_name: 'text', item_type: 'text' },
    order: 'code ASC NULLS LAST',
  },
})

export const LEGACY_ENTITIES = Object.freeze(Object.keys(ENTITIES))

export const entityConfig = (entity) => {
  if (!Object.hasOwn(ENTITIES, entity)) {
    throw httpError(404, `Unknown legacy entity "${entity}".`)
  }
  return ENTITIES[entity]
}
