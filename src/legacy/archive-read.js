// The Dynamics archive: one config-driven read over EVERY `legacy_*` staging
// table, for the CRM's Archive page. Where /admin/legacy/:entity is a curated
// window on four entities (a hand-picked projection, a fixed filter set), this
// is the whole corpus — all twelve entities, every column, any column filterable.
//
// The entity vocabulary here is the IMPORT one (`sales_orders`, `stock_items`),
// i.e. the LEGACY_TABLES keys, because that is the only vocabulary that names
// all twelve tables. The four entities that also have a read config get their
// corrections applied (patch merge + suppression) through READ_KEY, resolved
// explicitly off `ENTITIES[*].importEntity` — never by string transform, since
// three of the four names differ.
//
// Safety posture is the same as legacy-read.js: every column name in any SQL
// fragment comes from LEGACY_TABLES, never from the request, and every VALUE
// goes through a bound parameter. Filter values are additionally shape-checked
// in JS per column type so a bad one is a 400 naming the column rather than a
// 22P02 from Postgres.
//
// Locally raised records (d365_overrides.local) are NOT listed here: this is
// what Dynamics said, corrected. They stay on /admin/legacy/:entity.

import { LEGACY_TABLES } from '../seed/legacy-import.js'
import { ENTITIES } from './read-entities.js'
import { CAST_FUNCTION, overridableColumns } from './override-schema.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
export const FACET_LIMIT = 200

// Columns never projected in a list: `raw` is the whole source row (detail only)
// and the checksum means nothing to a reader.
const DETAIL_ONLY = new Set(['raw', 'row_checksum'])

export const ARCHIVE_ENTITIES = Object.freeze(Object.keys(LEGACY_TABLES))

// import key -> read key, for the four entities with corrections.
const READ_KEY = Object.freeze(
  Object.fromEntries(Object.entries(ENTITIES).map(([key, config]) => [config.importEntity, key]))
)

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const VALUE_SHAPE = Object.freeze({
  numeric: /^-?(?:\d+(?:\.\d+)?|\.\d+)$/,
  boolean: /^(?:true|false)$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  timestamp: /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/,
  uuid: GUID_PATTERN,
})

// Operators per column type. Text gets the string ones, everything orderable
// gets the range ones, boolean and uuid only equality. `empty`/`notempty` are
// universal and take no value.
const OPS = Object.freeze({
  text: ['eq', 'ne', 'contains', 'starts', 'in', 'empty', 'notempty'],
  numeric: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'notempty'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'notempty'],
  timestamp: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'notempty'],
  boolean: ['eq', 'empty', 'notempty'],
  uuid: ['eq', 'ne'],
})
const NO_VALUE = new Set(['empty', 'notempty'])
const COMPARE = Object.freeze({ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' })

export const archiveEntity = (entity) => {
  if (!Object.hasOwn(LEGACY_TABLES, entity)) {
    throw httpError(404, `Unknown archive entity "${entity}".`)
  }
  return entity
}

/** `[{ name, type }]` for one entity, list order, detail-only columns dropped. */
export const archiveColumns = (entity) =>
  Object.entries(LEGACY_TABLES[archiveEntity(entity)].columns)
    .filter(([name]) => !DETAIL_ONLY.has(name))
    .map(([name, type]) => ({ name, type }))

const columnType = (entity, column) =>
  LEGACY_TABLES[entity].columns[column]

const overridable = (entity) => {
  const readKey = READ_KEY[entity]
  return readKey ? new Set(overridableColumns(readKey)) : new Set()
}

/** What the CRM needs to draw every entity's filter bar without a second read per entity. */
export const describeArchive = () =>
  ARCHIVE_ENTITIES.map((entity) => ({
    entity,
    table: LEGACY_TABLES[entity].table,
    // The curated read key, so the CRM can offer the correction panel where one exists.
    read_entity: READ_KEY[entity] ?? null,
    columns: archiveColumns(entity),
    default_sort: defaultSort(entity),
  }))

const defaultSort = (entity) => {
  const columns = LEGACY_TABLES[entity].columns
  if (Object.hasOwn(columns, 'modified_on')) return { column: 'modified_on', dir: 'desc' }
  const first = Object.keys(columns).find((name) => name !== 'guid' && !DETAIL_ONLY.has(name))
  return { column: first, dir: 'asc' }
}

const literal = (value) => `'${String(value).replace(/'/g, "''")}'`

/**
 * The source CTE: the staging table with the office's corrections applied where
 * the entity has a read config. The merge is the same shape legacy-read.js uses
 * (key PRESENCE via jsonb_exists, safe-cast per type), and suppression follows
 * the same `o.archived_at IS NULL` rule in the WHERE — that predicate is the one
 * safe test on the nullable side of a LEFT JOIN. Filters, search and ORDER BY
 * all run over this CTE, so they see the corrected value.
 */
const sourceCte = (entity, { withRaw = false } = {}) => {
  const corrected = overridable(entity)
  const readKey = READ_KEY[entity]
  const projection = []
  for (const [name, type] of Object.entries(LEGACY_TABLES[entity].columns)) {
    if (DETAIL_ONLY.has(name) && !(withRaw && name === 'raw')) continue
    if (!corrected.has(name)) {
      projection.push(`t.${name} AS ${name}`)
      continue
    }
    const raw = `o.patch->>${literal(name)}`
    const present = `jsonb_exists(o.patch, ${literal(name)})`
    const fn = CAST_FUNCTION[type]
    projection.push(
      fn
        ? `CASE WHEN ${present} THEN ${fn}(${raw}, t.${name}) ELSE t.${name} END AS ${name}`
        : `CASE WHEN ${present} THEN ${raw} ELSE t.${name} END AS ${name}`
    )
  }
  if (!readKey) {
    projection.push("'{}'::text[] AS overridden_fields")
    return {
      cte: `WITH src AS (SELECT ${projection.join(', ')} FROM ${LEGACY_TABLES[entity].table} t)`,
      params: [],
    }
  }
  projection.push(
    "CASE WHEN o.patch IS NULL THEN '{}'::text[] ELSE ARRAY(SELECT jsonb_object_keys(o.patch)) END AS overridden_fields"
  )
  return {
    cte: `WITH src AS (
      SELECT ${projection.join(', ')}
        FROM ${LEGACY_TABLES[entity].table} t
        LEFT JOIN d365_overrides o ON o.entity = $1 AND o.guid = t.guid
       WHERE o.archived_at IS NULL)`,
    params: [readKey],
  }
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`)

// The regex only polices SHAPE: `2025-02-30` passes it and raises 22008 in
// Postgres. A JS Date rolls that over to March 2nd, so the check is that the
// parsed components come back unchanged. Time parts are already bounded by the
// pattern; leap seconds are not a D365 concern.
const calendarValid = (type, value) => {
  if (type !== 'date' && type !== 'timestamp') return true
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  const [hh = 0, mm = 0, ss = 0] = value.slice(11).split(':').map(Number)
  const parsed = new Date(Date.UTC(y, m - 1, d))
  const dateOk =
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  return dateOk && hh < 24 && mm < 60 && ss < 60
}

/**
 * Parse one `column:op:value` filter string. The value may itself contain
 * colons (a timestamp does), so only the first two split.
 */
export const parseFilter = (entity, text) => {
  const first = text.indexOf(':')
  const second = first < 0 ? -1 : text.indexOf(':', first + 1)
  const column = first < 0 ? text : text.slice(0, first)
  const op = first < 0 ? '' : second < 0 ? text.slice(first + 1) : text.slice(first + 1, second)
  const value = second < 0 ? '' : text.slice(second + 1)

  const type = columnType(entity, column)
  if (!type || DETAIL_ONLY.has(column)) {
    throw httpError(400, `Unknown column "${column}" for ${entity}.`)
  }
  if (!OPS[type]?.includes(op)) {
    throw httpError(400, `Operator "${op}" is not valid for ${column} (${type}).`)
  }
  if (NO_VALUE.has(op)) return { column, op, type, value: null }
  if (value === '') throw httpError(400, `Filter on ${column} needs a value.`)
  const values = op === 'in' ? value.split(',').map((v) => v.trim()).filter(Boolean) : [value]
  if (values.length === 0) throw httpError(400, `Filter on ${column} needs a value.`)
  const shape = VALUE_SHAPE[type]
  if (shape) {
    for (const v of values) {
      if (!shape.test(v) || !calendarValid(type, v)) {
        throw httpError(400, `"${v}" is not a valid ${type} for ${column}.`)
      }
    }
  }
  return { column, op, type, value: op === 'in' ? values : value }
}

const filterSql = (filter, params) => {
  const { column, op, type, value } = filter
  if (op === 'empty') {
    return type === 'text' ? `(${column} IS NULL OR ${column} = '')` : `${column} IS NULL`
  }
  if (op === 'notempty') {
    return type === 'text' ? `(${column} IS NOT NULL AND ${column} <> '')` : `${column} IS NOT NULL`
  }
  if (op === 'contains' || op === 'starts') {
    params.push(op === 'contains' ? `%${escapeLike(value)}%` : `${escapeLike(value)}%`)
    return `${column} ILIKE $${params.length} ESCAPE '\\'`
  }
  if (op === 'in') {
    params.push(value)
    return `${column} = ANY($${params.length}::text[])`
  }
  params.push(value)
  const cast = type === 'text' ? '' : `::${type}`
  return `${column} ${COMPARE[op]} $${params.length}${cast}`
}

const buildWhere = (entity, { q, filters }, bound) => {
  const clauses = []
  const params = [...bound]
  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const textColumns = archiveColumns(entity).filter((c) => c.type === 'text').map((c) => c.name)
    clauses.push(`(${textColumns.map((col) => `${col} ILIKE $${params.length} ESCAPE '\\'`).join(' OR ')})`)
  }
  for (const filter of filters) clauses.push(filterSql(filter, params))
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

const resolveSort = (entity, sort, dir) => {
  const fallback = defaultSort(entity)
  const column = sort ?? fallback.column
  if (!columnType(entity, column) || DETAIL_ONLY.has(column)) {
    throw httpError(400, `Cannot sort ${entity} by "${column}".`)
  }
  const direction = (dir ?? (sort ? 'asc' : fallback.dir)) === 'desc' ? 'DESC' : 'ASC'
  return { column, dir: direction.toLowerCase(), sql: `${column} ${direction} NULLS LAST, guid ASC` }
}

// pg hands a zone-less timestamp back as a JS Date in the SERVER's zone, and
// JSON then writes it as UTC — a midnight order date in Auckland comes out as
// the previous afternoon. Formatting in SQL keeps the value what D365 wrote.
const outputExpr = (name, type) => {
  if (type === 'timestamp') return `to_char(${name}, 'YYYY-MM-DD"T"HH24:MI:SS') AS ${name}`
  if (type === 'date') return `to_char(${name}, 'YYYY-MM-DD') AS ${name}`
  return name
}

const outputColumns = (entity, { withRaw = false } = {}) => {
  const list = Object.entries(LEGACY_TABLES[entity].columns)
    .filter(([name]) => !DETAIL_ONLY.has(name) || (withRaw && name === 'raw'))
    .map(([name, type]) => outputExpr(name, type))
  return [...list, 'overridden_fields']
}

const num = (v) => (v === null || v === undefined ? null : Number(v))

const mapRow = (entity, row) => {
  const out = { ...row }
  for (const [name, type] of Object.entries(LEGACY_TABLES[entity].columns)) {
    if (type === 'numeric' && name in out) out[name] = num(out[name])
  }
  return out
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} entity   a LEGACY_TABLES key
 * @param {{ q?: string, filters?: string[], sort?: string, dir?: string, page?: number, limit?: number }} opts
 */
export const listArchive = async (pool, entity, { q, filters = [], sort, dir, page, limit } = {}) => {
  archiveEntity(entity)
  const parsed = filters.map((text) => parseFilter(entity, text))
  const order = resolveSort(entity, sort, dir)
  const safePage = Number.isInteger(page) && page > 0 ? page : 1
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const source = sourceCte(entity)
  const { where, params } = buildWhere(entity, { q, filters: parsed }, source.params)

  const count = await pool.query(`${source.cte} SELECT COUNT(*)::int AS total FROM src ${where}`, params)
  const list = await pool.query(
    `${source.cte}
     SELECT ${outputColumns(entity).join(', ')}
       FROM src ${where}
      ORDER BY ${order.sql}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )
  return {
    items: list.rows.map((row) => mapRow(entity, row)),
    total: count.rows[0].total,
    page: safePage,
    limit: safeLimit,
    sort: { column: order.column, dir: order.dir },
  }
}

/** Distinct values of one text/boolean column with counts — what a filter dropdown offers. */
export const facetArchive = async (pool, entity, column) => {
  archiveEntity(entity)
  const type = columnType(entity, column)
  if (!type || DETAIL_ONLY.has(column)) throw httpError(400, `Unknown column "${column}" for ${entity}.`)
  if (type !== 'text' && type !== 'boolean') {
    throw httpError(400, `Facets are for text and boolean columns; ${column} is ${type}.`)
  }
  const source = sourceCte(entity)
  const { rows } = await pool.query(
    `${source.cte}
     SELECT ${column} AS value, COUNT(*)::int AS count
       FROM src
      WHERE ${column} IS NOT NULL${type === 'text' ? ` AND ${column} <> ''` : ''}
      GROUP BY ${column}
      ORDER BY count DESC, value ASC
      LIMIT ${FACET_LIMIT}`,
    source.params
  )
  return rows
}

/** One record with its full source row. */
export const getArchive = async (pool, entity, guid) => {
  archiveEntity(entity)
  if (!GUID_PATTERN.test(guid)) throw httpError(400, 'Not a record id.')
  const source = sourceCte(entity, { withRaw: true })
  const { rows } = await pool.query(
    `${source.cte}
     SELECT ${outputColumns(entity, { withRaw: true }).join(', ')}
       FROM src WHERE guid = $${source.params.length + 1}`,
    [...source.params, guid]
  )
  if (rows.length === 0) throw httpError(404, 'No such record in the archive.')
  return mapRow(entity, rows[0])
}

/** Row counts per entity, for the Archive landing page. One query per table; twelve small counts. */
export const countArchive = async (pool) => {
  const counts = await Promise.all(
    ARCHIVE_ENTITIES.map(async (entity) => {
      const source = sourceCte(entity)
      const { rows } = await pool.query(`${source.cte} SELECT COUNT(*)::int AS total FROM src`, source.params)
      return [entity, rows[0].total]
    })
  )
  return Object.fromEntries(counts)
}
