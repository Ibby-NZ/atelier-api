/**
 * Import of the normalised Dynamics 365 exports (produced by
 * scripts/convert-d365-exports.js) into the `legacy_*` staging tables.
 *
 * Upsert key is the D365 record GUID, so re-running the import against a fresh
 * export refreshes rows in place. That is the point: Atelier runs live on D365
 * until cutover, so this pipeline has to run repeatedly and stay idempotent.
 * Rows absent from a later export are kept — a deleted D365 record does not
 * silently vanish from staging.
 *
 * Nothing here writes to the live catalogue or commerce tables. See
 * docs/d365-export-analysis.md for why, and for the mapping that comes next.
 */

const CHUNK_SIZE = 500
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Column list per entity. Names are the staging columns; the converter emits
 * exactly these keys. `guid` is the conflict target and is excluded from the
 * UPDATE set. Types drive the `unnest` cast — pg needs an explicit array type per
 * column, and a text[] would fail against a numeric/boolean/timestamp column.
 */
const NUMERIC = 'numeric'
const BOOLEAN = 'boolean'
const TIMESTAMP = 'timestamp'
const DATE = 'date'
const JSONB = 'jsonb'
const TEXT = 'text'
const UUID_TYPE = 'uuid'

const AUDIT_COLUMNS = {
  source_file: TEXT,
  exported_at: TIMESTAMP,
  raw: JSONB,
  row_checksum: TEXT,
}

// owner/status/audit tail shared by the 30 Jul entities.
const STAMP_COLUMNS = {
  owner: TEXT,
  status: TEXT,
  status_reason: TEXT,
  created_by: TEXT,
  created_on: TIMESTAMP,
  modified_by: TEXT,
  modified_on: TIMESTAMP,
}

export const LEGACY_TABLES = Object.freeze({
  product_prices: {
    table: 'legacy_product_prices',
    columns: Object.freeze({
      guid: UUID_TYPE,
      code: TEXT,
      description: TEXT,
      range_name: TEXT,
      item_type: TEXT,
      pack_type: TEXT,
      contents: TEXT,
      width: TEXT,
      repeat: TEXT,
      vertical_repeat: TEXT,
      date_effective: DATE,
      duty_rate: TEXT,
      freight_rate: TEXT,
      currency: TEXT,
      exchange_rate: NUMERIC,
      price_exchange_rate: NUMERIC,
      wholesale_rate: NUMERIC,
      wholesale_rate_base: NUMERIC,
      export_price: NUMERIC,
      export_price_base: NUMERIC,
      price_ex_duty_nz: NUMERIC,
      price_incl_duty_nz: NUMERIC,
      landed_cost_nz: NUMERIC,
      retail_sell_price_nz: NUMERIC,
      trade_sell_price_nz: NUMERIC,
      trade_sell_price_under_5m_nz: NUMERIC,
      sell_price_5pct_nz: NUMERIC,
      sell_price_10pct_nz: NUMERIC,
      set_prices_manually: BOOLEAN,
      manual_duty_pct: NUMERIC,
      manual_markup_to_trade_pct: NUMERIC,
      manual_freight_shipping_nz: NUMERIC,
      manual_price_incl_freight_nz: NUMERIC,
      manual_trade_ex_freight_nz: NUMERIC,
      manual_wholesale_price: NUMERIC,
      manual_wholesale_price_base: NUMERIC,
      tracking_category_1: TEXT,
      tracking_category_2: TEXT,
      status: TEXT,
      status_reason: TEXT,
      created_by: TEXT,
      created_on: TIMESTAMP,
      modified_by: TEXT,
      modified_on: TIMESTAMP,
      ...AUDIT_COLUMNS,
    }),
  },
  stock_items: {
    table: 'legacy_stock_items',
    columns: Object.freeze({
      guid: UUID_TYPE,
      item_code: TEXT,
      name: TEXT,
      supplier: TEXT,
      range_name: TEXT,
      item_type: TEXT,
      item_measure: TEXT,
      product_price_list: TEXT,
      opening_stock: NUMERIC,
      stock_on_hand: NUMERIC,
      stock_available: NUMERIC,
      xero_stock_on_hand: NUMERIC,
      xero_to_d365_difference: NUMERIC,
      available_cuts: TEXT,
      reserve_note: TEXT,
      total_inventory_adjustments: NUMERIC,
      total_purchase_invoices: NUMERIC,
      total_purchase_orders: NUMERIC,
      total_sales_invoices: NUMERIC,
      total_sales_orders: NUMERIC,
      min_qty_to_avoid_surcharge: NUMERIC,
      retail_price: NUMERIC,
      retail_price_base: NUMERIC,
      trade_price: NUMERIC,
      trade_price_base: NUMERIC,
      trade_price_with_surcharge: NUMERIC,
      trade_price_with_surcharge_base: NUMERIC,
      currency: TEXT,
      exchange_rate: NUMERIC,
      can_sell: BOOLEAN,
      can_purchase: BOOLEAN,
      can_track: BOOLEAN,
      sales_account: TEXT,
      purchasing_account: TEXT,
      inventory_account: TEXT,
      sales_tax_rate: TEXT,
      purchasing_tax_rate: TEXT,
      sales_description: TEXT,
      purchasing_description: TEXT,
      tracking_category_1: TEXT,
      tracking_category_2: TEXT,
      owner: TEXT,
      status: TEXT,
      status_reason: TEXT,
      created_by: TEXT,
      created_on: TIMESTAMP,
      modified_by: TEXT,
      modified_on: TIMESTAMP,
      ...AUDIT_COLUMNS,
    }),
  },
  accounts: {
    table: 'legacy_accounts',
    columns: Object.freeze({
      guid: UUID_TYPE,
      name: TEXT,
      atelier_account_number: TEXT,
      exonet_dr_account_number: TEXT,
      exonet_crac_number: TEXT,
      xero_contact_id: TEXT,
      is_customer: BOOLEAN,
      is_supplier: BOOLEAN,
      customer_type: TEXT,
      relationship_type: TEXT,
      business_type: TEXT,
      classification: TEXT,
      industry: TEXT,
      marketing_category: TEXT,
      rating: TEXT,
      parent_account: TEXT,
      owner: TEXT,
      primary_contact: TEXT,
      primary_contact_email: TEXT,
      email: TEXT,
      main_phone: TEXT,
      other_phone: TEXT,
      fax: TEXT,
      website: TEXT,
      territory: TEXT,
      province: TEXT,
      address1_composite: TEXT,
      address1_name: TEXT,
      address1_street1: TEXT,
      address1_street2: TEXT,
      address1_street3: TEXT,
      address1_city: TEXT,
      address1_state: TEXT,
      address1_postal_code: TEXT,
      address1_country: TEXT,
      address1_county: TEXT,
      address1_type: TEXT,
      address2_composite: TEXT,
      address2_name: TEXT,
      address2_street1: TEXT,
      address2_street2: TEXT,
      address2_street3: TEXT,
      address2_city: TEXT,
      address2_state: TEXT,
      address2_postal_code: TEXT,
      address2_country: TEXT,
      address2_county: TEXT,
      address2_type: TEXT,
      shipping_method: TEXT,
      currency: TEXT,
      exchange_rate: NUMERIC,
      discount: NUMERIC,
      credit_limit: NUMERIC,
      credit_limit_base: NUMERIC,
      credit_hold: BOOLEAN,
      payment_terms: TEXT,
      payment_terms_sales: TEXT,
      payment_terms_bills: TEXT,
      payment_with_order: BOOLEAN,
      bill_days: NUMERIC,
      sales_days: NUMERIC,
      sales_days_suffix: TEXT,
      exo_sales_payment_terms: TEXT,
      exo_bill_payment_terms: TEXT,
      default_reserve_days: NUMERIC,
      order_stock_check_details: TEXT,
      sales_warning_message: TEXT,
      oldest_sample_due_back: TIMESTAMP,
      last_sales_contact: TIMESTAMP,
      next_sales_contact_due: TIMESTAMP,
      marketing_only: BOOLEAN,
      do_not_send_marketing_materials: BOOLEAN,
      gdpr_optout: BOOLEAN,
      do_not_email: BOOLEAN,
      do_not_bulk_email: BOOLEAN,
      do_not_phone: BOOLEAN,
      do_not_fax: BOOLEAN,
      do_not_postal_mail: BOOLEAN,
      do_not_bulk_postal_mail: BOOLEAN,
      follow_email_activity: BOOLEAN,
      preferred_contact_method: TEXT,
      last_date_included_in_campaign: TIMESTAMP,
      description: TEXT,
      status: TEXT,
      status_reason: TEXT,
      created_by: TEXT,
      created_on: TIMESTAMP,
      modified_by: TEXT,
      modified_on: TIMESTAMP,
      ...AUDIT_COLUMNS,
    }),
  },
  sales_orders: {
    table: 'legacy_sales_orders',
    columns: Object.freeze({
      guid: UUID_TYPE,
      number: TEXT,
      customer: TEXT,
      contact: TEXT,
      reference: TEXT,
      order_date: TIMESTAMP,
      expected_delivery_date: TIMESTAMP,
      total_ex_gst: NUMERIC,
      gst: NUMERIC,
      total_incl_gst: NUMERIC,
      total_ex_gst_base: NUMERIC,
      gst_base: NUMERIC,
      total_incl_gst_base: NUMERIC,
      currency: TEXT,
      exchange_rate: NUMERIC,
      pricing_type: TEXT,
      sales_order_discount_pct: NUMERIC,
      deliver_to: TEXT,
      mark_parcel: TEXT,
      last_sent: TIMESTAMP,
      on_behalf_of: TEXT,
      owner: TEXT,
      status: TEXT,
      status_reason: TEXT,
      created_by: TEXT,
      created_on: TIMESTAMP,
      modified_by: TEXT,
      modified_on: TIMESTAMP,
      ...AUDIT_COLUMNS,
    }),
  },

  // ---- 30 Jul pull --------------------------------------------------------
  contacts: {
    table: 'legacy_contacts',
    columns: Object.freeze({
      guid: UUID_TYPE,
      full_name: TEXT,
      first_name: TEXT,
      last_name: TEXT,
      middle_name: TEXT,
      salutation: TEXT,
      suffix: TEXT,
      nickname: TEXT,
      job_title: TEXT,
      department: TEXT,
      company_name: TEXT,
      role: TEXT,
      relationship_type: TEXT,
      territory: TEXT,
      email: TEXT,
      email2: TEXT,
      email3: TEXT,
      business_phone: TEXT,
      business_phone2: TEXT,
      home_phone: TEXT,
      telephone3: TEXT,
      mobile_phone: TEXT,
      fax: TEXT,
      website: TEXT,
      address1_composite: TEXT,
      address1_street1: TEXT,
      address1_street2: TEXT,
      address1_city: TEXT,
      address1_state: TEXT,
      address1_postal_code: TEXT,
      address1_country: TEXT,
      address1_phone: TEXT,
      address2_composite: TEXT,
      address3_composite: TEXT,
      shipping_method: TEXT,
      payment_terms: TEXT,
      price_list: TEXT,
      currency: TEXT,
      exchange_rate: NUMERIC,
      credit_limit: NUMERIC,
      credit_hold: BOOLEAN,
      back_office_customer: BOOLEAN,
      lead_source: TEXT,
      preferred_contact_method: TEXT,
      is_primary_contact: BOOLEAN,
      xero_contact_number: TEXT,
      xero_contact_person_id: TEXT,
      oldest_sample_due_back: TIMESTAMP,
      include_in_emails: BOOLEAN,
      marketing_only: BOOLEAN,
      do_not_send_marketing_materials: BOOLEAN,
      gdpr_optout: BOOLEAN,
      do_not_email: BOOLEAN,
      do_not_bulk_email: BOOLEAN,
      do_not_phone: BOOLEAN,
      do_not_fax: BOOLEAN,
      do_not_postal_mail: BOOLEAN,
      do_not_bulk_postal_mail: BOOLEAN,
      follow_email_activity: BOOLEAN,
      last_date_included_in_campaign: TIMESTAMP,
      description: TEXT,
      ...STAMP_COLUMNS,
      ...AUDIT_COLUMNS,
    }),
  },
  reserves: {
    table: 'legacy_reserves',
    columns: Object.freeze({
      guid: UUID_TYPE,
      name: TEXT,
      reserve_number: TEXT,
      range_name: TEXT,
      customer: TEXT,
      customer_contact: TEXT,
      customer_owner: TEXT,
      product: TEXT,
      product_code: TEXT,
      colour_code: TEXT,
      supplier: TEXT,
      quantity: NUMERIC,
      reserved_until: TIMESTAMP,
      default_reserved_until: TIMESTAMP,
      cfa: TEXT,
      comments: TEXT,
      order_stock_check_details: TEXT,
      ...STAMP_COLUMNS,
      ...AUDIT_COLUMNS,
    }),
  },
  cuttings: {
    table: 'legacy_cuttings',
    columns: Object.freeze({
      guid: UUID_TYPE,
      name: TEXT,
      range_name: TEXT,
      customer: TEXT,
      customer_contact: TEXT,
      customer_owner: TEXT,
      product: TEXT,
      product_code: TEXT,
      colour_code: TEXT,
      supplier: TEXT,
      quantity: NUMERIC,
      comments: TEXT,
      order_stock_check_details: TEXT,
      ...STAMP_COLUMNS,
      ...AUDIT_COLUMNS,
    }),
  },
  item_locations: {
    table: 'legacy_item_locations',
    columns: Object.freeze({
      guid: UUID_TYPE,
      description: TEXT,
      item: TEXT,
      location: TEXT,
      opening_units_in_stock: NUMERIC,
      total_stock_on_hand: NUMERIC,
      total_stock_available: NUMERIC,
      total_item_adjustments: NUMERIC,
      total_purchase_invoices: NUMERIC,
      total_purchase_orders: NUMERIC,
      total_sales_invoices: NUMERIC,
      total_sales_orders: NUMERIC,
      ...STAMP_COLUMNS,
      ...AUDIT_COLUMNS,
    }),
  },
  purchase_orders: {
    table: 'legacy_purchase_orders',
    columns: Object.freeze({
      guid: UUID_TYPE,
      number: TEXT,
      vendor: TEXT,
      vendor_contact: TEXT,
      order_date: TIMESTAMP,
      pickup_date: TIMESTAMP,
      reference: TEXT,
      summary: TEXT,
      attention: TEXT,
      phone: TEXT,
      location: TEXT,
      shipping_agent: TEXT,
      shipping_contact: TEXT,
      delivery_address: TEXT,
      delivery_instructions: TEXT,
      currency: TEXT,
      exchange_rate: NUMERIC,
      total_ex_gst: NUMERIC,
      gst: NUMERIC,
      total_incl_gst: NUMERIC,
      total_ex_gst_base: NUMERIC,
      gst_base: NUMERIC,
      total_incl_gst_base: NUMERIC,
      last_sent: TIMESTAMP,
      ...STAMP_COLUMNS,
      ...AUDIT_COLUMNS,
    }),
  },
  purchase_invoices: {
    table: 'legacy_purchase_invoices',
    columns: Object.freeze({
      guid: UUID_TYPE,
      number: TEXT,
      vendor: TEXT,
      invoice_date: TIMESTAMP,
      due_date: TIMESTAMP,
      reference: TEXT,
      summary: TEXT,
      shipping_agents_invoice_number: TEXT,
      currency: TEXT,
      exchange_rate: NUMERIC,
      total_ex_gst: NUMERIC,
      gst: NUMERIC,
      total_incl_gst: NUMERIC,
      total_ex_gst_base: NUMERIC,
      gst_base: NUMERIC,
      total_incl_gst_base: NUMERIC,
      temp_invoice_date: TIMESTAMP,
      temp_invoice_due_date: TIMESTAMP,
      xero_invoice_id: TEXT,
      xero_interface_error: TEXT,
      ...STAMP_COLUMNS,
      ...AUDIT_COLUMNS,
    }),
  },
  sales_invoices: {
    table: 'legacy_sales_invoices',
    columns: Object.freeze({
      guid: UUID_TYPE,
      number: TEXT,
      invoice_suffix: TEXT,
      customer: TEXT,
      customer_contact: TEXT,
      sales_order: TEXT,
      invoice_date: TIMESTAMP,
      due_date: TIMESTAMP,
      reference: TEXT,
      summary: TEXT,
      currency: TEXT,
      exchange_rate: NUMERIC,
      total_ex_gst: NUMERIC,
      gst: NUMERIC,
      total_incl_gst: NUMERIC,
      total_ex_gst_base: NUMERIC,
      gst_base: NUMERIC,
      total_incl_gst_base: NUMERIC,
      pricing_type: TEXT,
      sales_invoice_discount_pct: NUMERIC,
      temp_invoice_date: TIMESTAMP,
      temp_invoice_due_date: TIMESTAMP,
      xero_invoice_id: TEXT,
      xero_interface_error: TEXT,
      last_sent: TIMESTAMP,
      ...STAMP_COLUMNS,
      ...AUDIT_COLUMNS,
    }),
  },
})

const invalid = (entity, index, field, detail) =>
  new Error(`${entity} record ${index}: invalid ${field} (${detail})`)

/**
 * Rejects the batch before any SQL runs. Catches duplicate GUIDs too — a
 * multi-row upsert cannot touch the same conflict key twice in one statement
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time").
 *
 * @param {string} entity
 * @param {ReadonlyArray<Record<string, unknown>>} records
 * @returns {ReadonlyArray<Record<string, unknown>>} the records, untouched
 */
export const validateLegacyRecords = (entity, records) => {
  const spec = LEGACY_TABLES[entity]
  if (!spec) throw new Error(`unknown legacy entity "${entity}"`)
  if (!Array.isArray(records)) throw new Error(`${entity} records must be an array`)

  const seen = new Set()
  records.forEach((record, index) => {
    if (record === null || typeof record !== 'object') {
      throw invalid(entity, index, 'record', 'not an object')
    }
    if (typeof record.guid !== 'string' || !UUID.test(record.guid)) {
      throw invalid(entity, index, 'guid', `expected a UUID, got ${JSON.stringify(record.guid)}`)
    }
    if (typeof record.source_file !== 'string' || record.source_file.trim() === '') {
      throw invalid(entity, index, 'source_file', 'expected a non-empty string')
    }
    if (record.raw === null || typeof record.raw !== 'object') {
      throw invalid(entity, index, 'raw', 'expected an object of D365 logical-name values')
    }
    const unknown = Object.keys(record).filter((key) => !(key in spec.columns))
    if (unknown.length > 0) {
      throw invalid(entity, index, 'record', `unknown column(s): ${unknown.join(', ')}`)
    }
    if (seen.has(record.guid)) {
      throw invalid(entity, index, 'guid', `duplicate record GUID ${record.guid}`)
    }
    seen.add(record.guid)
  })
  return records
}

const buildUpsertSql = (spec) => {
  const columns = Object.keys(spec.columns)
  const casts = columns.map((column, i) => `$${i + 1}::${spec.columns[column]}[]`)
  const updates = columns
    .filter((column) => column !== 'guid')
    .map((column) => `"${column}" = EXCLUDED."${column}"`)
  return `
    INSERT INTO ${spec.table} (${columns.map((c) => `"${c}"`).join(', ')})
    SELECT * FROM unnest(${casts.join(', ')})
    ON CONFLICT (guid) DO UPDATE SET
      ${updates.join(',\n      ')},
      imported_at = now()`
}

const toParam = (value, type) => {
  if (value === undefined || value === null) return null
  // pg maps a raw JS object to a Postgres record, not jsonb — same trap as
  // hex_tones in the catalogue seed.
  return type === JSONB ? JSON.stringify(value) : value
}

const upsertChunk = async (client, spec, sql, chunk) => {
  const columns = Object.keys(spec.columns)
  const arrays = columns.map((column) =>
    chunk.map((record) => toParam(record[column], spec.columns[column]))
  )
  await client.query(sql, arrays)
}

/**
 * Validates then upserts one entity's records in a single transaction
 * (all-or-nothing). Safe to re-run: the conflict target is the D365 GUID.
 *
 * @param {import('pg').Pool} pool
 * @param {string} entity  a key of LEGACY_TABLES
 * @param {ReadonlyArray<Record<string, unknown>>} records
 * @returns {Promise<Readonly<{ entity: string, table: string, records: number }>>}
 */
export const importLegacyEntity = async (pool, entity, records) => {
  validateLegacyRecords(entity, records)
  const spec = LEGACY_TABLES[entity]
  const sql = buildUpsertSql(spec)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (let offset = 0; offset < records.length; offset += CHUNK_SIZE) {
      await upsertChunk(client, spec, sql, records.slice(offset, offset + CHUNK_SIZE))
    }
    await client.query('COMMIT')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Surface the original failure, not the rollback's.
    }
    throw error
  } finally {
    client.release()
  }
  return Object.freeze({ entity, table: spec.table, records: records.length })
}
