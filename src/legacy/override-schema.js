// The pure half of the D365 override layer: what may be corrected, what type it
// must be, and the SQL fragments that merge a correction onto the staging row.
// No pool, no query — so its rules are unit-testable on their own, the posture
// src/reports/filters.js and src/samples/sample-order-states.js already take.
//
// EVERY CAST TYPE IS DERIVED FROM LEGACY_TABLES, NEVER RETYPED. That map is what
// the import itself binds its `unnest($n::<type>[])` casts through, so it is the
// one declaration of what a staging column holds. A second hand-written list
// here would drift silently, and the symptom would be a 22P02 on a screen rather
// than anything a reader could trace back. `assertEntities()` runs at module
// load and throws if a read column has no declared type — the assertEntity /
// assertStorable posture: a malformed declaration stops the server booting
// instead of surfacing thousands of rows into a request.

import { ENTITIES, entityConfig, LEGACY_ENTITIES } from './read-entities.js'
import { LEGACY_TABLES } from '../seed/legacy-import.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// The safe-cast function per type (migrations/1787025600000_d365-overrides.js).
// `text` needs none — every jsonb `->>` result is already text.
const CAST_FUNCTION = Object.freeze({
  numeric: 'd365_override_numeric',
  boolean: 'd365_override_boolean',
  timestamp: 'd365_override_timestamp',
})

// The types actually present across the four read surfaces. `uuid` appears only
// on `guid`, which is the key and is never overridable; `date` and `jsonb` exist
// in LEGACY_TABLES but no read config selects such a column. A new read column
// of an unhandled type fails assertEntities() at boot rather than producing an
// expression with no cast.
const OVERRIDABLE_TYPES = Object.freeze(['text', 'numeric', 'boolean', 'timestamp'])

// The key column. Overriding it would re-point the record at another row.
const KEY_COLUMN = 'guid'

/** Column -> declared cast type for one read entity, resolved through LEGACY_TABLES. */
const columnTypes = (entity) => {
  const config = ENTITIES[entity]
  const declared = LEGACY_TABLES[config.importEntity]?.columns ?? {}
  return Object.fromEntries(config.columns.map((column) => [column, declared[column]]))
}

const TYPES = Object.freeze(
  Object.fromEntries(LEGACY_ENTITIES.map((entity) => [entity, Object.freeze(columnTypes(entity))]))
)

/** Every column a correction may touch: the read projection minus the key. */
const OVERRIDABLE = Object.freeze(
  Object.fromEntries(
    LEGACY_ENTITIES.map((entity) => [
      entity,
      Object.freeze(ENTITIES[entity].columns.filter((column) => column !== KEY_COLUMN)),
    ])
  )
)

export const overridableColumns = (entity) => OVERRIDABLE[entity] ?? []

export const columnType = (entity, column) => TYPES[entity]?.[column]

/**
 * Columns whose correction is a commercial act rather than a clerical one. The
 * route gates these on `can_view_finance` — `backoffice` covers the showroom as
 * well as the accounts desk, which is exactly why that second explicit,
 * revocable permission exists (see users.can_view_finance,
 * migrations/1786680000000_reporting-finance-access.js). A login that may not
 * SEE a cost figure in a report must not be able to SET one here.
 */
export const commercialColumns = (entity) => ENTITIES[entity]?.commercial ?? []

export const touchesCommercial = (entity, columns) => {
  const commercial = new Set(commercialColumns(entity))
  return columns.some((column) => commercial.has(column))
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

// Strict, because Number() is far looser than a numeric literal ('' is 0,
// '0x10' is 16) — the same trap scripts/lib's parseNumber is regex-gated against.
const NUMERIC_TEXT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/

// A NAIVE local timestamp: no trailing Z, no offset. The legacy_* time columns
// are deliberately zone-less (the D365 export writes Excel serials rendered in
// the exporting user's local time), and Postgres DISCARDS an offset on a
// ::timestamp cast rather than applying it — verified: both
// '2026-01-02T03:04:05.000Z'::timestamp and '2026-01-02T03:04:05+13:00'::timestamp
// are 2026-01-02 03:04:05. So accepting the shape a browser's toISOString()
// produces would silently move every corrected date by the NZ offset, and
// re-sort a list ordered on it. Reject it at the boundary instead.
const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?$/

/**
 * Validate one proposed value against its column's declared type and return the
 * JSON value to store. `null` is always legal and means "override this field to
 * empty" — which the read expresses by testing key PRESENCE, never value
 * nullness, because jsonb `->>` collapses an absent key and a JSON null into the
 * same SQL NULL.
 *
 * A numeric is stored as its canonical TEXT, not as a JSON number: the columns
 * are numeric(18,4) and numeric(18,6), whose full range does not survive a
 * double. Postgres parses the text exactly.
 */
const overrideValue = (entity, column, value) => {
  const type = columnType(entity, column)
  if (value === null) return null

  if (type === 'text') {
    if (typeof value !== 'string') {
      throw httpError(422, `"${column}" must be a string or null.`)
    }
    // Reject the word so it can never stand in for a real null: a caller that
    // means "clear this field" has to say so unambiguously.
    if (value === 'null') {
      throw httpError(422, `"${column}" cannot be the text "null" — send null to clear the field.`)
    }
    return value
  }

  if (type === 'numeric') {
    const text = typeof value === 'number' ? String(value) : value
    if (typeof text !== 'string' || !NUMERIC_TEXT.test(text)) {
      throw httpError(422, `"${column}" must be a number or null.`)
    }
    return text
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    throw httpError(422, `"${column}" must be true, false or null.`)
  }

  if (type === 'timestamp') {
    if (typeof value !== 'string' || !NAIVE_TIMESTAMP.test(value)) {
      throw httpError(
        422,
        `"${column}" must be a local timestamp as YYYY-MM-DD or YYYY-MM-DD HH:MM:SS, with no timezone, or null.`
      )
    }
    return value
  }

  // Unreachable while assertEntities() holds; loud rather than silent if it stops.
  throw httpError(422, `"${column}" cannot be overridden.`)
}

/**
 * Validate a whole proposed patch. Unknown or unwritable columns are rejected by
 * NAME so the caller learns which one — the column whitelist is the real
 * defence, never the route schema, because Fastify's Ajv runs
 * `removeAdditional: true` and STRIPS an unknown key rather than refusing it.
 *
 * @returns {object} the JSON object to store in `patch`
 */
export const normaliseOverridePatch = (entity, values) => {
  const overridable = new Set(overridableColumns(entity))
  const patch = {}
  for (const [column, value] of Object.entries(values)) {
    if (column === KEY_COLUMN) {
      throw httpError(422, 'The record guid cannot be overridden.')
    }
    if (!overridable.has(column)) {
      throw httpError(422, `"${column}" is not an overridable ${entity} column.`)
    }
    patch[column] = overrideValue(entity, column, value)
  }
  return patch
}

/** Reject a revert list naming anything not overridable, and de-duplicate it. */
export const normaliseRevertList = (entity, columns) => {
  const overridable = new Set(overridableColumns(entity))
  for (const column of columns) {
    if (!overridable.has(column)) {
      throw httpError(422, `"${column}" is not an overridable ${entity} column.`)
    }
  }
  return [...new Set(columns)]
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

const literal = (value) => `'${String(value).replace(/'/g, "''")}'`

/**
 * The merged projection for one entity, as two positionally aligned lists.
 *
 * Both branches are generated in ONE loop over one array, because a UNION ALL
 * lines its branches up by POSITION and takes its output names from the first —
 * two lists agreeing on names but not on order would file a local record's city
 * under `province` and raise nothing. src/reports/revenue-lines.js learned the
 * same lesson with assertScopeSource; here the single loop makes the drift
 * unconstructable rather than merely detected.
 *
 * The override is applied on key PRESENCE (`jsonb_exists`), not on value
 * nullness. `COALESCE(patch->>'col', t.col)` would be the obvious form and is
 * wrong: `'{"a":null}'::jsonb->>'a'` IS NULL, identically to an absent key, so a
 * deliberate clear would silently return the D365 value and the CRM would report
 * success. `jsonb_exists(o.patch, 'col')` is what distinguishes them.
 * (`o.patch ? 'col'` is the same operator; the function form is used so no
 * layer between here and Postgres can mistake the `?` for a placeholder.)
 */
export const mergedProjection = (entity) => {
  const config = entityConfig(entity)
  const staged = []
  const local = []

  for (const column of config.columns) {
    if (column === KEY_COLUMN) {
      staged.push(`t.${column} AS ${column}`)
      local.push(`o.${column} AS ${column}`)
      continue
    }
    const type = columnType(entity, column)
    const raw = `o.patch->>${literal(column)}`
    const present = `jsonb_exists(o.patch, ${literal(column)})`
    const fn = CAST_FUNCTION[type]

    if (fn) {
      staged.push(`CASE WHEN ${present} THEN ${fn}(${raw}, t.${column}) ELSE t.${column} END AS ${column}`)
      local.push(`${fn}(${raw}, NULL::${type}) AS ${column}`)
    } else {
      staged.push(`CASE WHEN ${present} THEN ${raw} ELSE t.${column} END AS ${column}`)
      local.push(`${raw} AS ${column}`)
    }
  }

  // Three synthetic columns, in the same position in both branches. `is_local`
  // is derived from which branch emitted the row rather than read back from the
  // column, so it can never contradict the tables.
  const overriddenFields =
    "CASE WHEN o.patch IS NULL THEN '{}'::text[] ELSE ARRAY(SELECT jsonb_object_keys(o.patch)) END AS overridden_fields"
  staged.push('false AS is_local', 'o.archived_at AS archived_at', overriddenFields)
  local.push('true AS is_local', 'o.archived_at AS archived_at', overriddenFields)

  return { staged, local }
}

/**
 * `jsonb_build_object(...)` over every overridable column of the staging row —
 * the `base` snapshot. Built with `to_jsonb(<column>)` on this side and compared
 * with `to_jsonb(<column>)` on the other, so the comparison is exact rather than
 * a text rendering that would disagree with itself on numeric scale
 * (`0.5` against `0.5000`).
 */
export const baseSnapshotSql = (entity, alias, columns = overridableColumns(entity)) => {
  const overridable = new Set(overridableColumns(entity))
  const pairs = columns
    .map((column) => {
      // Defensive: these reach SQL as identifiers, so they may only ever come
      // from the whitelist. normaliseOverridePatch has already refused anything
      // else, and this is the second lock on the same door.
      if (!overridable.has(column)) {
        throw new Error(`Refusing to snapshot non-overridable column "${entity}.${column}".`)
      }
      return `${literal(column)}, to_jsonb(${alias}.${column})`
    })
    .join(', ')
  return `jsonb_build_object(${pairs})`
}

/**
 * A SELECT that makes POSTGRES ITSELF parse each proposed value, run inside the
 * write transaction before the upsert.
 *
 * A regex can only police the SHAPE: '2026-02-31' satisfies the timestamp
 * pattern and then raises 22008 at cast time — the same class CLAUDE.md already
 * records for the samples timestamp bodies. Here the failure would not surface
 * on the write at all; it would land in the table and 500 the entity's whole
 * listing for every user afterwards. Postgres 14 has no `pg_input_is_valid`, so
 * running the real cast is the only way to know before storing.
 *
 * @returns {string|null} null when every proposed key is `text` (nothing to prove)
 */
export const castProbeSql = (entity, patch) => {
  const probes = Object.entries(patch)
    .filter(([, value]) => value !== null)
    .map(([column]) => [column, columnType(entity, column)])
    .filter(([, type]) => CAST_FUNCTION[type])
    .map(([column, type]) => `($1::jsonb->>${literal(column)})::${type}`)
  return probes.length ? `SELECT ${probes.join(', ')}` : null
}

// ---------------------------------------------------------------------------
// Module-load assertions
// ---------------------------------------------------------------------------

/**
 * Fails the boot rather than a request. Three classes of declaration error, each
 * of which is invisible afterwards:
 *  - a read column with no type in LEGACY_TABLES, or a type this layer has no
 *    cast for — the merged expression would have no cast and the column would
 *    come back as text, or the import map has moved underneath the read config;
 *  - a search/filter/order column that is not PROJECTED — those clauses run over
 *    the merged CTE, which can only reference the columns it emits, so the first
 *    filter added on an unprojected column is a `column does not exist` 500. It
 *    holds for all four configs today by luck, not by design;
 *  - a `commercial` column that is not overridable — the finance gate would be
 *    naming a column no write can reach, which reads as protection and is not.
 */
export const assertEntities = () => {
  for (const entity of LEGACY_ENTITIES) {
    const config = ENTITIES[entity]
    if (!LEGACY_TABLES[config.importEntity]) {
      throw new Error(`Read entity "${entity}" names unknown import entity "${config.importEntity}".`)
    }
    if (LEGACY_TABLES[config.importEntity].table !== config.table) {
      throw new Error(`Read entity "${entity}" and import entity "${config.importEntity}" name different tables.`)
    }
    const projected = new Set(config.columns)
    for (const column of config.columns) {
      const type = columnType(entity, column)
      if (!type) {
        throw new Error(`Read column "${entity}.${column}" has no type in LEGACY_TABLES.`)
      }
      if (column !== KEY_COLUMN && !OVERRIDABLE_TYPES.includes(type)) {
        throw new Error(`Read column "${entity}.${column}" has unsupported override type "${type}".`)
      }
    }
    for (const column of [...config.search, ...Object.keys(config.filters)]) {
      if (!projected.has(column)) {
        throw new Error(`Read entity "${entity}" searches or filters unprojected column "${column}".`)
      }
    }
    for (const term of config.order.split(',')) {
      const column = term.trim().split(/\s+/)[0]
      if (!projected.has(column)) {
        throw new Error(`Read entity "${entity}" orders on unprojected column "${column}".`)
      }
    }
    for (const column of config.commercial) {
      if (!projected.has(column) || column === KEY_COLUMN) {
        throw new Error(`Read entity "${entity}" marks non-overridable column "${column}" commercial.`)
      }
    }
    const { staged, local } = mergedProjection(entity)
    if (staged.length !== local.length) {
      throw new Error(`Read entity "${entity}" produced misaligned UNION branches.`)
    }
  }
}

assertEntities()
