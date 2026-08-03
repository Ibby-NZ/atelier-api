// Read-only access to the Dynamics-365 staging tables (legacy_* — see
// migrations/1785542400000_legacy-d365-staging.js and docs/d365-export-analysis.md).
//
// The CRM needs to BROWSE Atelier's real customers, sales orders, stock and
// prices. These tables are a re-importable mirror of a system Atelier still runs
// live on, so this module is deliberately READ-ONLY: no create/update/delete.
// Any edit here would be overwritten by the next `npm run import:legacy`, and the
// staging→live promotion is a separate, still-unsettled pass. Native CRUD lives
// on the real platform tables (users/inventory/price-list-items/orders), not here.
//
// The single write path is the bulk import itself, and it lives elsewhere:
// src/routes/admin-legacy-import.js (director-only, one entity batch per
// request). Read routes stay read-only; do not add mutations to this module.
//
// One config-driven query path serves all four entities: column/search/filter
// whitelists per entity mean the entity name and column names are never user
// input, while every filter/search VALUE flows through a parameterised
// placeholder (same posture as the public catalogue read).

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

// Numeric columns come back from pg as strings; coerce so the CRM gets numbers.
const num = (v) => (v === null || v === undefined ? null : Number(v))

const ENTITIES = Object.freeze({
  accounts: {
    table: 'legacy_accounts',
    columns: [
      'guid', 'name', 'atelier_account_number', 'customer_type', 'is_customer',
      'is_supplier', 'primary_contact', 'primary_contact_email', 'email',
      'main_phone', 'other_phone', 'address1_city', 'province', 'territory',
      'currency', 'discount', 'credit_limit', 'payment_terms', 'owner',
      'status', 'status_reason', 'xero_contact_id',
    ],
    search: ['name', 'atelier_account_number', 'primary_contact', 'email'],
    numeric: ['discount', 'credit_limit'],
    filters: { is_customer: 'boolean', is_supplier: 'boolean', customer_type: 'text', owner: 'text' },
    order: 'name ASC NULLS LAST',
  },
  'sales-orders': {
    table: 'legacy_sales_orders',
    columns: [
      'guid', 'number', 'customer', 'contact', 'reference', 'order_date',
      'expected_delivery_date', 'total_ex_gst', 'gst', 'total_incl_gst',
      'currency', 'pricing_type', 'sales_order_discount_pct', 'deliver_to',
      'owner', 'status', 'status_reason',
    ],
    search: ['number', 'customer', 'reference'],
    numeric: ['total_ex_gst', 'gst', 'total_incl_gst', 'sales_order_discount_pct'],
    filters: { status_reason: 'text', pricing_type: 'text', owner: 'text' },
    order: 'order_date DESC NULLS LAST, number DESC',
  },
  stock: {
    table: 'legacy_stock_items',
    columns: [
      'guid', 'item_code', 'name', 'supplier', 'range_name', 'item_type',
      'item_measure', 'stock_on_hand', 'stock_available', 'reserve_note',
      'retail_price', 'trade_price', 'currency', 'product_price_list',
      'can_sell', 'status', 'status_reason',
    ],
    search: ['item_code', 'name', 'supplier', 'range_name'],
    numeric: ['stock_on_hand', 'stock_available', 'retail_price', 'trade_price'],
    filters: { supplier: 'text', item_type: 'text', product_price_list: 'text' },
    order: 'name ASC NULLS LAST, item_code ASC',
  },
  prices: {
    table: 'legacy_product_prices',
    columns: [
      'guid', 'code', 'description', 'range_name', 'item_type', 'pack_type',
      'width', 'currency', 'wholesale_rate', 'landed_cost_nz',
      'retail_sell_price_nz', 'trade_sell_price_nz', 'trade_sell_price_under_5m_nz',
      'set_prices_manually', 'status', 'status_reason',
    ],
    search: ['code', 'description', 'range_name'],
    numeric: [
      'wholesale_rate', 'landed_cost_nz', 'retail_sell_price_nz',
      'trade_sell_price_nz', 'trade_sell_price_under_5m_nz',
    ],
    filters: { range_name: 'text', item_type: 'text' },
    order: 'code ASC NULLS LAST',
  },
})

export const LEGACY_ENTITIES = Object.freeze(Object.keys(ENTITIES))

const entityConfig = (entity) => {
  if (!Object.hasOwn(ENTITIES, entity)) {
    throw httpError(404, `Unknown legacy entity "${entity}".`)
  }
  return ENTITIES[entity]
}

// Coerce the numeric columns of a row to Number; leave the rest as-is.
const mapRow = (row, config) => {
  const out = { ...row }
  for (const col of config.numeric) {
    if (col in out) out[col] = num(out[col])
  }
  return out
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`)

// Build WHERE fragments + params from the search term and whitelisted filters.
const buildWhere = (config, { q, filters = {} }) => {
  const clauses = []
  const params = []

  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    const ors = config.search.map((col) => `${col} ILIKE $${i} ESCAPE '\\'`)
    clauses.push(`(${ors.join(' OR ')})`)
  }

  for (const [key, type] of Object.entries(config.filters)) {
    const value = filters[key]
    if (value === undefined || value === null || value === '') continue
    if (type === 'boolean') {
      params.push(value === true || value === 'true')
    } else {
      params.push(value)
    }
    clauses.push(`${key} = $${params.length}`)
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/**
 * Paginated, searchable, filtered list of one legacy entity.
 *
 * @param {import('pg').Pool} pool
 * @param {string} entity  one of LEGACY_ENTITIES
 * @param {{ q?: string, filters?: object, page?: number, limit?: number }} [opts]
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export const listLegacy = async (pool, entity, { q, filters, page, limit } = {}) => {
  const config = entityConfig(entity)
  const safePage = Number.isInteger(page) && page > 0 ? page : 1
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildWhere(config, { q, filters })

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM ${config.table} ${where}`,
    params
  )
  const total = countResult.rows[0].total

  const listResult = await pool.query(
    `SELECT ${config.columns.join(', ')}
       FROM ${config.table}
       ${where}
      ORDER BY ${config.order}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return {
    items: listResult.rows.map((row) => mapRow(row, config)),
    total,
    page: safePage,
    limit: safeLimit,
  }
}

/**
 * One legacy record by its Dynamics GUID, including the full `raw` jsonb (every
 * original column verbatim). Returns null when the guid is unknown.
 *
 * @param {import('pg').Pool} pool
 * @param {string} entity
 * @param {string} guid
 * @returns {Promise<object|null>}
 */
export const getLegacy = async (pool, entity, guid) => {
  const config = entityConfig(entity)
  const { rows } = await pool.query(
    `SELECT ${config.columns.join(', ')}, raw, imported_at, source_file
       FROM ${config.table}
      WHERE guid = $1`,
    [guid]
  )
  return rows[0] ? mapRow(rows[0], config) : null
}
