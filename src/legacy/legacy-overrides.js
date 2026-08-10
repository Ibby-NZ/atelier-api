// Writes for the D365 override layer: correct a staged record, raise one that
// D365 does not have, suppress one from the back office's view.
//
// NOTHING HERE WRITES TO A legacy_ TABLE, and nothing may be added that does.
// `importLegacyEntity` upserts every mapped column to EXCLUDED on the D365 GUID
// and the import re-runs until cutover, so a correction stored on a staging row
// survives until the next `npm run import:legacy` and then vanishes silently.
// Every statement in this module names `d365_overrides` and reads legacy_ tables
// only to answer "does this record exist".
//
// WHAT SUPPRESSION IS AND IS NOT. `archived_at` hides a record from
// `/admin/legacy/*` and survives every re-import, which a `DELETE FROM
// legacy_accounts` could never do. It does NOT reach any other reader of the
// staging tables: src/trade-accounts/viewer.js, client-legacy.js and
// admin-trade-accounts.js each write their own SQL straight at legacy_ and are
// deliberately outside the merge, so suppressing a duplicate account does not
// resolve a portal name collision and does not remove anything from a client's
// invoice history. The DELETE route returns that sentence rather than letting a
// 200 imply more than happened.

import {
  baseSnapshotSql,
  castProbeSql,
  normaliseOverridePatch,
  normaliseRevertList,
} from './override-schema.js'
import { entityConfig, getLegacy, legacyRecordExists } from './legacy-read.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * What a caller must be told about a suppression, because the status code cannot
 * say it. Same posture as the price-list item delete's REIMPORT_WARNING: the
 * success envelope is widened by one additive key rather than the refusal shape
 * being changed.
 */
export const SUPPRESSION_WARNING =
  'Hidden from the back-office Dynamics browser only. The staged record is untouched, ' +
  'the next import will refresh it, and the client portal reads the staging tables ' +
  'directly and is unaffected.'

const notFound = (entity, guid) =>
  httpError(404, `No ${entity} record ${guid}.`)

/** Postgres codes for "that text is not a value of this type". */
const CAST_ERROR = new Set(['22P02', '22007', '22008', '22003', '22023'])

/**
 * Make Postgres parse every proposed value before it is stored. A regex can only
 * police the shape — '2026-02-31' satisfies the timestamp pattern and raises
 * 22008 at cast time — and a value that lands unparseable would 500 the entity's
 * whole listing for every user afterwards, from a route that is itself the only
 * way to find the offending row. PG14 has no `pg_input_is_valid`, so running the
 * real cast is the only way to know.
 */
const proveCastable = async (client, entity, patch) => {
  const probe = castProbeSql(entity, patch)
  if (!probe) return
  try {
    await client.query(probe, [JSON.stringify(patch)])
  } catch (error) {
    if (CAST_ERROR.has(error?.code)) {
      throw httpError(422, `Value rejected by the database: ${error.message}`)
    }
    throw error
  }
}

const withTxn = async (pool, fn) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * An override row that carries nothing is deleted rather than left behind: it
 * would still join, still count, and it is indistinguishable from no correction
 * at all.
 *
 * A LOCAL row is exempt because deleting it would destroy the record itself, not
 * a correction to one — there is no staging row underneath to fall back to. Its
 * emptiness is refused instead: `createLocalLegacyRecord` will not raise one with
 * no values, and `setLegacyOverrides` rolls back a revert that would empty one.
 * Without both halves a reverted-to-nothing local record becomes a permanent
 * all-NULL row in the list, counted in `meta.total`, that no further revert can
 * remove.
 */
const dropEmptyOverride = (client, entity, guid) =>
  client.query(
    `DELETE FROM d365_overrides
      WHERE entity = $1 AND guid = $2
        AND NOT local AND archived_at IS NULL AND patch = '{}'::jsonb`,
    [entity, guid]
  )

/**
 * Correct a record: set columns, revert others back to what D365 says.
 *
 * The merge is ONE statement. A read-modify-write in JS loses an update whenever
 * two staff correct different fields of the same record within a few seconds —
 * the common case here, not a rare race — and neither person is told anything
 * happened. `(existing || EXCLUDED.patch) - $revert` runs under the row lock the
 * upsert takes, so each write merges onto the other's committed value.
 *
 * A column named in both `set` and `revert` is a 422 rather than a precedence
 * rule nobody can see from the request.
 *
 * @param {{ set?: object, revert?: string[], userId?: number|null }} input
 */
export const setLegacyOverrides = async (pool, entity, guid, { set, revert, userId = null } = {}) => {
  const config = entityConfig(entity)
  const patch = normaliseOverridePatch(entity, set ?? {})
  const reverted = normaliseRevertList(entity, revert ?? [])

  if (!Object.keys(patch).length && !reverted.length) {
    throw httpError(422, 'Provide at least one column to set or revert.')
  }
  const clash = reverted.filter((column) => Object.hasOwn(patch, column))
  if (clash.length) {
    throw httpError(422, `Cannot set and revert the same column: ${clash.join(', ')}.`)
  }

  await withTxn(pool, async (client) => {
    const { exists } = await legacyRecordExists(client, entity, guid)
    if (!exists) throw notFound(entity, guid)

    await proveCastable(client, entity, patch)

    // `base` is snapshotted for the keys THIS request writes and merged over
    // what is already stored — never assigned wholesale. A whole-record snapshot
    // reassigned on every write would silently retract the staleness signal for
    // every OTHER corrected column: correct a credit limit in March, D365 moves
    // it in June (stale_fields fires), fix an unrelated typo in July and the
    // refreshed snapshot now agrees with D365, so the divergence stops being
    // reported while the read still serves March's figure. Reverted keys are
    // subtracted, because a snapshot of a correction that no longer exists means
    // nothing. Note this is the same key-wise discipline `patch` already gets on
    // the line above; assigning one wholesale beside the other was the bug.
    const written = Object.keys(patch)
    const { rows } = await client.query(
      `INSERT INTO d365_overrides
              (entity, guid, patch, base, local, created_by_user_id, updated_by_user_id)
       SELECT $1, $2, $3::jsonb - $4::text[],
              COALESCE((SELECT ${baseSnapshotSql(entity, 't', written)} FROM ${config.table} t WHERE t.guid = $2), '{}'::jsonb),
              false, $5, $5
       ON CONFLICT (entity, guid) DO UPDATE
          SET patch = (d365_overrides.patch || EXCLUDED.patch) - $4::text[],
              base = (d365_overrides.base - $4::text[]) || EXCLUDED.base,
              updated_by_user_id = EXCLUDED.updated_by_user_id,
              updated_at = now()
       RETURNING local, patch`,
      [entity, guid, JSON.stringify(patch), reverted, userId]
    )

    // Refused AFTER the write and inside the transaction, so the rollback undoes
    // it: the resulting patch is what the merge produced, and pre-reading it
    // would be a check against a value another transaction is about to change.
    const row = rows[0]
    if (row.local && !Object.keys(row.patch).length) {
      throw httpError(
        422,
        'Reverting every field would leave this locally raised record empty. Delete it instead.'
      )
    }

    await dropEmptyOverride(client, entity, guid)
  })

  return getLegacy(pool, entity, guid)
}

/**
 * Raise a record D365 does not have.
 *
 * The guid is minted here (`gen_random_uuid()`, core since PG13 — no pgcrypto),
 * and the record is emitted by the merged read's local branch, which is guarded
 * by a NOT EXISTS against the staging table. So if a real D365 record ever lands
 * under this guid the local branch stops emitting and the staged branch takes
 * over with the patch applied — one guid can never produce two rows.
 *
 * KNOWN GAP, stated rather than papered over: nothing reconciles a locally
 * raised customer with the same customer later arriving from D365 under its own
 * guid. Both appear, and merging them is a manual act (revert the local record's
 * fields, suppress it, correct the staged one). A trade account cannot be linked
 * to a local guid at all — `POST /admin/trade-accounts` resolves the account out
 * of `legacy_accounts` first, so it 422s, which is the right answer.
 */
export const createLocalLegacyRecord = async (pool, entity, { values, userId = null } = {}) => {
  const patch = normaliseOverridePatch(entity, values ?? {})
  // Counting KEYS is not enough: `{ name: null }` is one key and produces a
  // record with every column null — the same phantom a revert-to-nothing would
  // leave, arriving through the front door.
  if (!Object.values(patch).some((value) => value !== null)) {
    throw httpError(422, 'Provide at least one column value that is not null.')
  }

  const guid = await withTxn(pool, async (client) => {
    await proveCastable(client, entity, patch)
    const { rows } = await client.query(
      `INSERT INTO d365_overrides
              (entity, guid, patch, base, local, created_by_user_id, updated_by_user_id)
       VALUES ($1, gen_random_uuid(), $2::jsonb, '{}'::jsonb, true, $3, $3)
       RETURNING guid`,
      [entity, JSON.stringify(patch), userId]
    )
    return rows[0].guid
  })

  return getLegacy(pool, entity, guid)
}

/**
 * Hide a record from the back office's Dynamics browser, or bring it back.
 *
 * Both directions are UPSERTS, not UPDATEs. The common case is a record nobody
 * has ever corrected, so there is no `d365_overrides` row to update and an
 * UPDATE would report rowCount 0 — which a handler reads as either a 404 on a
 * record the user is looking at, or a 200 with the record still fully visible.
 * The 404 is decided by whether the RECORD exists (staged or local), never by
 * the rowCount of a write against the overrides table.
 */
export const setLegacySuppressed = async (pool, entity, guid, { archived, userId = null } = {}) => {
  await withTxn(pool, async (client) => {
    const { exists } = await legacyRecordExists(client, entity, guid)
    if (!exists) throw notFound(entity, guid)

    await client.query(
      `INSERT INTO d365_overrides
              (entity, guid, archived_at, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, CASE WHEN $3 THEN now() END, $4, $4)
       ON CONFLICT (entity, guid) DO UPDATE
          SET archived_at = CASE WHEN $3 THEN COALESCE(d365_overrides.archived_at, now()) END,
              updated_by_user_id = EXCLUDED.updated_by_user_id,
              updated_at = now()`,
      [entity, guid, archived === true, userId]
    )

    await dropEmptyOverride(client, entity, guid)
  })

  return getLegacy(pool, entity, guid)
}
