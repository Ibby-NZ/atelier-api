// Hard delete, with an explanation when it is refused.
//
// `deleteOrExplain` **returns** its refusal; it never throws it. Fastify's error
// serializer emits `{ statusCode, error, message }` and drops every custom
// property, so a thrown error cannot carry `blockers` — the whole point of the
// 409. Handlers stay thin by piping the result through `replyDelete`.
//
// Transaction order (one transaction, READ COMMITTED):
//
//   BEGIN
//     SELECT <id> FROM <table> WHERE <id> = $1 FOR UPDATE   (A)  0 rows -> 404
//     entity.guard?.(client, id, ctx)                       (B)  refusal -> its status
//     one probe query covering every relation               (C)  any count > 0 -> 409
//     DELETE FROM <table> WHERE <id> = $1                   (D)
//   COMMIT
//   catch 23503 -> constraintBlockers(error) -> the same 409 shape
//
// **Why probe-then-delete is not a TOCTOU race.** The parent row is locked
// `FOR UPDATE` before the probes run. Postgres takes `FOR KEY SHARE` on a
// referenced row whenever a transaction inserts a row pointing at it, and
// `FOR KEY SHARE` conflicts with exactly one mode — `FOR UPDATE`. It must **not**
// be `FOR NO KEY UPDATE`, which does not conflict and would leave the window wide
// open. Probes and the DELETE share the transaction, so the DELETE sees exactly
// what the probes saw. No SERIALIZABLE: it would add 40001 retries that nothing
// in this codebase handles.
//
// The one window the parent lock does not cover is a **grandchild** — an order
// line inserted against an existing colourway of the brand being deleted.
// Postgres closes it anyway: the inserter takes `FOR KEY SHARE` on the colourway
// and the cascade's delete of that colourway takes a conflicting lock, so the two
// serialise; if the insert wins, the RESTRICT FK turns the cascade into a 23503
// and the catch produces the same 409 shape. That is the backstop's real job —
// along with staying an honest 409 rather than a 500 if someone adds a RESTRICT
// FK and forgets the registry entry.

import { requireEntity } from './registry.js'

// Each probe runs LIMIT 101 and anything past PROBE_CAP is reported as
// "100, capped". Answering "is there any?" must not mean counting 19,000 rows.
const PROBE_CAP = 100
const PROBE_LIMIT = PROBE_CAP + 1

// The refusal statuses this module produces, and the `error` text Fastify would
// have used for each. Kept explicit so the envelope matches every other error in
// the API rather than inventing a second dialect.
const STATUS_TEXT = Object.freeze({
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
})

// Only a RESTRICT foreign key can raise 23503 here; today that is exactly one
// edge. An unknown constraint degrades the *detail*, never the status — the same
// posture as rethrowConflict's handling of an unrecognised 23505.
const CONSTRAINT_BLOCKERS = Object.freeze({
  order_lines_colourway_id_fkey: Object.freeze({
    relation: 'order_lines',
    label: 'order lines',
  }),
})

const UNKNOWN_CONSTRAINT_BLOCKER = Object.freeze({
  relation: 'related_records',
  label: 'related records',
})

/**
 * Map a pg 23503 (foreign key violation) onto the blocker list a probe would
 * have produced. Returns null for any other error, so the caller can rethrow.
 *
 * The count is `1, capped` rather than a number: the database tells us at least
 * one row exists and nothing about how many, and "1+" is the honest reading.
 *
 * @param {{ code?: string, constraint?: string }} error
 * @returns {Array<object>|null}
 */
export const constraintBlockers = (error) => {
  if (error?.code !== '23503') return null
  const hit = CONSTRAINT_BLOCKERS[error.constraint] ?? UNKNOWN_CONSTRAINT_BLOCKER
  return Object.freeze([
    Object.freeze({ ...hit, count: 1, capped: true }),
  ])
}

/**
 * The row lock. Exported so a test can assert the mode: `FOR NO KEY UPDATE`
 * would not conflict with the `FOR KEY SHARE` an inserting transaction takes,
 * and the probes would stop meaning anything.
 *
 * @param {object} entity
 * @returns {string}
 */
export const lockSql = (entity) =>
  `SELECT ${entity.idColumn} FROM ${entity.table} WHERE ${entity.idColumn} = $1 FOR UPDATE`

// One statement covering every probe. Relation names and probe bodies are frozen
// code literals validated at import time (registry.js `assertEntity`), so they
// are safe to interpolate; the parent id is always the $1 placeholder.
const probeSql = (entity) =>
  entity.probes
    .map(
      (probe, index) =>
        `SELECT '${probe.relation}' AS relation, count(*)::int AS hits
           FROM (${probe.sql} LIMIT ${PROBE_LIMIT}) AS probe_${index}`
    )
    .join('\n UNION ALL\n')

const runProbes = async (client, entity, id) => {
  if (entity.probes.length === 0) return []
  const { rows } = await client.query(probeSql(entity), [id])
  const hitsByRelation = new Map(rows.map((row) => [row.relation, Number(row.hits)]))
  return entity.probes
    .map((probe) => {
      const hits = hitsByRelation.get(probe.relation) ?? 0
      if (hits === 0) return null
      const capped = hits > PROBE_CAP
      return Object.freeze({
        relation: probe.relation,
        label: probe.label,
        count: capped ? PROBE_CAP : hits,
        capped,
      })
    })
    .filter(Boolean)
}

// "3 products, 100+ order lines"
const summarise = (blockers) =>
  blockers
    .map((blocker) => `${blocker.count}${blocker.capped ? '+' : ''} ${blocker.label}`)
    .join(', ')

const refusal = (entity, { status, message, blockers = [] }) =>
  Object.freeze({
    deleted: false,
    status,
    error: STATUS_TEXT[status] ?? 'Error',
    message,
    blockers: Object.freeze(blockers),
    archivable: entity.archivable,
  })

const blocked = (entity, blockers) =>
  refusal(entity, {
    status: 409,
    message:
      `Cannot delete this ${entity.label}: ${summarise(blockers)} still reference it.` +
      (entity.archivable
        ? ' Archive it instead to hide it without losing the records.'
        : ''),
    blockers,
  })

const notFound = (entity, id) =>
  refusal(entity, {
    status: 404,
    message: `No ${entity.label} with id ${id}.`,
  })

const runDelete = async (client, entity, entityName, id, ctx) => {
  // (A) Lock the parent. This is what makes the probes below meaningful.
  const { rows } = await client.query(lockSql(entity), [id])
  if (rows.length === 0) return notFound(entity, id)

  // (B) Entity-specific rules that are not "something still points at this".
  if (entity.guard) {
    const stop = await entity.guard(client, id, ctx)
    if (stop) return refusal(entity, stop)
  }

  // (C) Dependency probes — one round trip, archived rows included.
  const blockers = await runProbes(client, entity, id)
  if (blockers.length > 0) return blocked(entity, blockers)

  // (D) Nothing is in the way.
  await client.query(
    `DELETE FROM ${entity.table} WHERE ${entity.idColumn} = $1`,
    [id]
  )
  return Object.freeze({ deleted: true, entity: entityName, id })
}

/**
 * Delete a row, or explain why not. Never throws for a refusal — a 404, a 403
 * from a guard and a 409 from the probes are all return values.
 *
 * @param {import('pg').Pool} pool
 * @param {string} entityName  a registry key; always a code literal, never a path param
 * @param {number} id
 * @param {{ user?: object }} [ctx]  request context guards may need (the actor)
 * @returns {Promise<
 *   { deleted: true, entity: string, id: number }
 *   | { deleted: false, status: number, error: string, message: string,
 *       blockers: Array<{ relation: string, label: string, count: number, capped: boolean }>,
 *       archivable: boolean }
 * >}
 */
export const deleteOrExplain = async (pool, entityName, id, ctx = {}) => {
  const entity = requireEntity(entityName)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await runDelete(client, entity, entityName, id, ctx)
    // A refusal rolls back: the guard and the probes may have read, and (D) is
    // the only statement that writes, so there is nothing to keep either way.
    await client.query(result.deleted ? 'COMMIT' : 'ROLLBACK')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    const blockers = constraintBlockers(error)
    if (blockers) return blocked(entity, blockers)
    throw error
  } finally {
    client.release()
  }
}

/**
 * Send a `deleteOrExplain` result. Success is 200 with a JSON envelope, not 204:
 * every route here returns one, and the CRM's `useMutation` names the result in
 * its toast. A refusal keeps Fastify's `{ statusCode, error, message }` shape and
 * adds the two fields the dialog needs to stay open and offer an alternative.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {object} result
 */
export const replyDelete = (reply, result) => {
  if (result.deleted) {
    return reply
      .code(200)
      .send({ deleted: { entity: result.entity, id: result.id } })
  }
  return reply.code(result.status).send({
    statusCode: result.status,
    error: result.error,
    message: result.message,
    blockers: result.blockers,
    archivable: result.archivable,
  })
}
