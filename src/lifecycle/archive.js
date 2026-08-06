// The shared soft-archive write.
//
// Eight modules each carried their own copy of the same UPDATE. What was
// genuinely duplicated is small — the `now()`/`NULL` fragment, the WHERE on the
// id column, the RETURNING projection and "no row means the id is unknown" — so
// that is all this owns. Every caller keeps its own thin wrapper, because each
// returns a different frozen shape: some throw a 404, some return null, some
// re-fetch through a joined read model. Collapsing those into one return
// convention would be a rewrite of eight call sites, not a de-duplication.
//
// `archived` is a trusted boolean ARGUMENT, never user input, which is why
// switching the SQL fragment on it is safe — the same reasoning the individual
// helpers carried before. Everything else that varies (`extraSets`, `alias`,
// `from`, `filter`, `returning`) is likewise a frozen code literal supplied at
// the call site, in the same posture as the column whitelists `buildUpdate`
// takes: names are code, values are placeholders.

import { requireEntity } from './registry.js'

/**
 * Stamp or clear `archived_at` on a registry entity's row.
 *
 * @param {{ query: Function }} db  a pool or an open client (the order state
 *   machine passes its transaction's client so the write joins that transaction)
 * @param {string} entityName  a registry key; always a code literal
 * @param {number} id
 * @param {boolean} archived  true -> now(), false -> NULL
 * @param {{
 *   returning?: string,   // projection; defaults to the id column
 *   extraSets?: string[], // further SET fragments, e.g. 'updated_at = now()'
 *   alias?: string,       // table alias, when `from` needs one
 *   from?: string,        // extra FROM clause, to decorate the projection
 *   filter?: string,      // the join condition that FROM needs
 * }} [options]
 * @returns {Promise<object|null>} the projected row, or null when no row matched
 */
export const setArchived = async (db, entityName, id, archived, options = {}) => {
  const entity = requireEntity(entityName)
  if (!entity.archivable) {
    // A wiring mistake, not a request outcome: the table has no archived_at
    // column, so there is nothing this could write.
    throw new Error(`Lifecycle entity "${entityName}" is not archivable.`)
  }
  const { returning, extraSets = [], alias = '', from = '', filter = '' } = options
  const ref = alias || entity.table
  const sets = [`archived_at = ${archived ? 'now()' : 'NULL'}`, ...extraSets]

  const { rows } = await db.query(
    `UPDATE ${entity.table}${alias ? ` ${alias}` : ''}
        SET ${sets.join(', ')}
      ${from}
      WHERE ${ref}.${entity.idColumn} = $1 ${filter}
      RETURNING ${returning ?? `${ref}.${entity.idColumn}`}`,
    [id]
  )
  return rows[0] ?? null
}
