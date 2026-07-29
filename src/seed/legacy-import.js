/**
 * Import of the normalised Dynamics 365 exports (produced by
 * scripts/convert-d365-exports.py) into the `legacy_*` staging tables.
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
