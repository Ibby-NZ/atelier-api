// The supplier backfill: reads the two sources, applies the plan, reports what
// it could not resolve. One transaction, all or nothing.
//
// RE-RUNNING CHANGES NOTHING. Every statement here is guarded so a second run
// touches zero rows: the supplier upsert only fires its DO UPDATE when a NULL
// column would actually be filled, the alias insert is ON CONFLICT DO NOTHING,
// the two link updates carry an `IS DISTINCT FROM` / `IS NULL` predicate, and
// terms are inserted only where the brand has none. That is not just tidiness —
// the office edits suppliers in the CRM, so a backfill that overwrote what it
// found would silently undo a correction every time someone re-ran it.
//
// WHAT IT MAY OVERWRITE, AND WHAT IT MAY NOT.
//   · `price_list_items.supplier_id` is derived, has no screen, and its only
//     truth is the free text beside it — so the backfill re-points it whenever
//     the resolved supplier differs. Adding an alias in the CRM and re-running
//     is how 2,516 orphan rate rows get attached.
//   · `suppliers` columns and `brands.supplier_id` are staff-curated, so they
//     are filled ONLY where NULL. Same COALESCE posture as `brands.website_url`
//     in the seed, and for the same reason.
//
// This file lives in the suppliers domain rather than under src/seed/ because
// it names `supplier_brand_terms` and `supplier_discount_tiers`, which
// `test/suppliers-terms.test.js` allows only here. src/seed/backfill-suppliers.js
// is the CLI wrapper.

import { suppliers as SNAPSHOT } from '../seed/data/suppliers.js'
import {
  SUPPLIER_ALIAS_SOURCES,
  SUPPLIER_FILL_COLUMNS,
  planSupplierBackfill,
} from './backfill-plan.js'

// Column names are code literals, values always $n placeholders — the house
// rule buildUpdate exists for, applied to a generated statement.
const FILLED = SUPPLIER_FILL_COLUMNS.map((c) => `COALESCE(suppliers.${c}, EXCLUDED.${c})`)
const CURRENT = SUPPLIER_FILL_COLUMNS.map((c) => `suppliers.${c}`)

// `xmax = 0` distinguishes a row this statement inserted from one it updated.
// The DO UPDATE fires only when COALESCE would change something, so an
// unchanged conflicting row returns nothing at all and is counted as neither.
const UPSERT_SUPPLIERS = `
  INSERT INTO suppliers (name, slug, ${SUPPLIER_FILL_COLUMNS.join(', ')})
  SELECT * FROM unnest(${['text', 'text', ...SUPPLIER_FILL_COLUMNS.map(() => 'text')]
    .map((type, i) => `$${i + 1}::${type}[]`)
    .join(', ')})
  ON CONFLICT (name) DO UPDATE SET
    ${SUPPLIER_FILL_COLUMNS.map((c, i) => `${c} = ${FILLED[i]}`).join(',\n    ')},
    updated_at = now()
  WHERE (${CURRENT.join(', ')}) IS DISTINCT FROM (${FILLED.join(', ')})
  RETURNING id, name, (xmax = 0) AS inserted`

const readSources = async (client) => {
  const [priceList, existingSuppliers, existingAliases, brands] = await Promise.all([
    client.query(`
      SELECT supplier AS name,
             count(*)::int AS items,
             array_agg(DISTINCT currency) AS currencies
        FROM price_list_items
       GROUP BY supplier
       ORDER BY supplier`),
    client.query(`SELECT name, slug FROM suppliers`),
    client.query(`
      SELECT supplier_aliases.alias, suppliers.name AS supplier_name
        FROM supplier_aliases
        JOIN suppliers ON suppliers.id = supplier_aliases.supplier_id`),
    client.query(`SELECT id, name, supplier_id FROM brands`),
  ])
  return {
    priceListSuppliers: priceList.rows,
    existingSuppliers: existingSuppliers.rows,
    existingAliases: existingAliases.rows,
    brands: brands.rows,
  }
}

const upsertSuppliers = async (client, rows) => {
  if (rows.length === 0) return { created: 0, enriched: 0, idsByName: new Map() }
  const columns = ['name', 'slug', ...SUPPLIER_FILL_COLUMNS]
  const { rows: touched } = await client.query(
    UPSERT_SUPPLIERS,
    columns.map((column) => rows.map((row) => row[column] ?? null))
  )

  // The statement returns only the rows it inserted or enriched, so ids for
  // every planned supplier are read back separately.
  const { rows: all } = await client.query(
    `SELECT id, name FROM suppliers WHERE name = ANY($1::text[])`,
    [rows.map((row) => row.name)]
  )
  return {
    created: touched.filter((row) => row.inserted).length,
    enriched: touched.filter((row) => !row.inserted).length,
    idsByName: new Map(all.map((row) => [row.name, row.id])),
  }
}

const insertAliases = async (client, aliases, idsByName) => {
  const rows = aliases.filter((row) => idsByName.has(row.supplier_name))
  if (rows.length === 0) return 0
  const { rowCount } = await client.query(
    `INSERT INTO supplier_aliases (supplier_id, alias)
     SELECT * FROM unnest($1::int[], $2::text[])
     ON CONFLICT DO NOTHING`,
    [rows.map((row) => idsByName.get(row.supplier_name)), rows.map((row) => row.alias)]
  )
  return rowCount
}

const linkPriceListItems = async (client, matches, idsByName) => {
  const rows = matches.filter((row) => idsByName.has(row.supplier_name))
  if (rows.length === 0) return 0
  // Matched on the normalised key, the same `lower(btrim(...))` the planner and
  // the alias index use, so a stray space in a source filename still resolves.
  const { rowCount } = await client.query(
    `UPDATE price_list_items
        SET supplier_id = resolved.supplier_id, updated_at = now()
       FROM unnest($1::text[], $2::int[]) AS resolved(key, supplier_id)
      WHERE lower(btrim(price_list_items.supplier)) = resolved.key
        AND price_list_items.supplier_id IS DISTINCT FROM resolved.supplier_id`,
    [rows.map((row) => row.key), rows.map((row) => idsByName.get(row.supplier_name))]
  )
  return rowCount
}

const linkBrands = async (client, brandLinks, idsByName) => {
  const rows = brandLinks.filter((row) => idsByName.has(row.supplier_name))
  if (rows.length === 0) return 0
  // Only where NULL: which house a supplier invoices is a commercial fact the
  // office may already have corrected in the CRM.
  const { rowCount } = await client.query(
    `UPDATE brands
        SET supplier_id = resolved.supplier_id
       FROM unnest($1::int[], $2::int[]) AS resolved(brand_id, supplier_id)
      WHERE brands.id = resolved.brand_id
        AND brands.supplier_id IS NULL`,
    [rows.map((row) => row.brand_id), rows.map((row) => idsByName.get(row.supplier_name))]
  )
  return rowCount
}

// Terms are inserted one row at a time: `discount_chain` is an array per row,
// which cannot be carried through a single unnest, and there are a couple of
// dozen of them. A brand that already has terms is left alone, so its tiers are
// written only alongside a freshly inserted parent.
const insertTerms = async (client, brandTerms, idsByName) => {
  let terms = 0
  let tiers = 0
  for (const row of brandTerms) {
    const supplierId = idsByName.get(row.supplier_name)
    if (!supplierId) continue
    const { rows: inserted } = await client.query(
      `INSERT INTO supplier_brand_terms
         (supplier_id, brand_id, discount, discount_chain, markup, indicative, note)
       VALUES ($1, $2, $3, $4::numeric(6,4)[], $5, $6, $7)
       ON CONFLICT (brand_id) DO NOTHING
       RETURNING id`,
      [
        supplierId,
        row.brand_id,
        row.discount,
        row.discount_chain,
        row.markup,
        row.indicative,
        row.note,
      ]
    )
    if (inserted.length === 0) continue
    terms += 1
    if (row.tiers.length === 0) continue
    const { rowCount } = await client.query(
      `INSERT INTO supplier_discount_tiers
         (supplier_brand_term_id, label, pct, is_fallback)
       SELECT * FROM unnest($1::int[], $2::text[], $3::numeric(6,4)[], $4::boolean[])`,
      [
        row.tiers.map(() => inserted[0].id),
        row.tiers.map((tier) => tier.label),
        row.tiers.map((tier) => tier.pct),
        row.tiers.map((tier) => tier.is_fallback),
      ]
    )
    tiers += rowCount
  }
  return { terms, tiers }
}

/**
 * Backfill suppliers, aliases, the rate-ledger links, the brand links and the
 * per-brand terms from the two sources. Everything commits together or nothing
 * does. Returns a frozen summary; `reports` is what could not be resolved and
 * needs a human, never a guess.
 *
 * @param {import('pg').Pool} pool
 * @param {{ snapshot?: object[], aliasSources?: object[] }} [options]
 * @returns {Promise<object>}
 */
export const backfillSuppliers = async (
  pool,
  { snapshot = SNAPSHOT, aliasSources = SUPPLIER_ALIAS_SOURCES } = {}
) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const sources = await readSources(client)
    const plan = planSupplierBackfill({ ...sources, snapshot, aliasSources })

    const { created, enriched, idsByName } = await upsertSuppliers(client, plan.suppliers)
    const aliases = await insertAliases(client, plan.aliases, idsByName)
    const priceListItems = await linkPriceListItems(client, plan.matches, idsByName)
    const brands = await linkBrands(client, plan.brandLinks, idsByName)
    const { terms, tiers } = await insertTerms(client, plan.brandTerms, idsByName)

    await client.query('COMMIT')
    return Object.freeze({
      suppliers: Object.freeze({ planned: plan.suppliers.length, created, enriched }),
      aliases,
      priceListItems,
      brands,
      terms,
      tiers,
      reports: plan.reports,
    })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Surface the original failure, not the rollback's; pg discards the
      // released connection either way.
    }
    throw error
  } finally {
    client.release()
  }
}
