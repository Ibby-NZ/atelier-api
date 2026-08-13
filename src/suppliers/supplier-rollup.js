// The supplier -> brand roll-up, stated by the client rather than inferred
// (W21 US-003, FR-281/FR-282).
//
// WHAT CHANGED. `backfill:suppliers` has linked 15 of 41 houses to a supplier
// and has no way to link the other 26: its two sources are the price-list
// filename prefixes (which name HOUSES, not invoicing entities) and a
// nine-house vendored snapshot. `legacy_tracking_options.supplier` is the
// missing input — **28 invoicing entities over 55 houses, from the client's own
// system** — and it supersedes the 62-token empirical roll-up that item codes
// gave (`src/products/reporting-codes-plan.js` still reports those tokens, as
// evidence for a different question).
//
// AND WHAT DID NOT. `Supplier` on that table is a LOOKUP RENDERED AS A DISPLAY
// NAME, exactly the trap `product_price_list` records: it matches a live
// supplier on **8 of 28** — 6 on the name, 2 on the slug, 0 on an alias because
// `supplier_aliases` is empty — and `short_code`/`d365_token` are NULL on all
// 40 supplier rows, so neither is a key either. Most of the other 20 are
// visibly the legal-entity form of a house we already hold (`Fabricut Inc` /
// Fabricut, `Pierre Frey Paris` / Pierre Frey, `Liberty London` / Liberty).
//
// THOSE ARE CORRECTIONS TO MAKE IN THE CRM, ONE ALIAS AT A TIME, NOT A FUZZY
// RULE TO WRITE. This module matches on an exact `lower(btrim(...))` name, an
// exact slug, or an alias saying so, and reports everything else — the
// `src/suppliers/backfill-plan.js` doctrine, which reports the
// `Jannelli Volpi` / `Janelli Volpi` pair rather than collapsing it. A guessed
// merge here is not cosmetic: a supplier carries the discount chain, the
// Incoterm and the freight terms, so attaching a house to the wrong invoicing
// entity is a wrong landed cost on every metre it buys.
//
// A LINK IS PLANNED ONLY WHERE BOTH ENDS RESOLVE AND THE HOUSE IS UNLINKED.
// `brands.supplier_id` is staff-curated, so an existing link is left alone and
// reported — a house's supplier is a commercial decision, not ours — the same
// fill-only-what-is-NULL rule the supplier backfill already keeps.
//
// IT REPORTS, IT NEVER WRITES. The plan is `brandLinks`, which
// `npm run backfill:suppliers` applies; nothing here opens a transaction.

import { slugify } from '../seed/slugify.js'
import { listRangeParameters, MAX_LIMIT } from '../pricing/tracking-parameters.js'
import { nameKey } from './backfill-plan.js'

const sluggable = (value) => {
  try {
    const slug = slugify(value)
    return slug === '' ? null : slug
  } catch {
    // A punctuation- or whitespace-only display name cannot produce one.
    return null
  }
}

/**
 * Resolve one display name against the live records. Exact only: the name, then
 * the slug, then an alias. Returns the route as well as the row, because "which
 * of the three matched" is the difference between a key and a coincidence — 2
 * of the 8 live matches are slug-only.
 */
const resolveSupplier = (display, { byName, bySlug, byAlias }) => {
  const key = nameKey(display)
  if (key === '') return null
  const named = byName.get(key)
  if (named) return { row: named, via: 'name' }
  const slug = sluggable(display)
  const slugged = slug ? bySlug.get(slug) : undefined
  if (slugged) return { row: slugged, via: 'slug' }
  const aliased = byAlias.get(key)
  if (aliased) return { row: aliased, via: 'alias' }
  return null
}

/**
 * Plan the supplier roll-up from the staged parameters. Pure: no database, no
 * I/O, and it returns a plan rather than performing one.
 *
 * @param {object} input
 * @param {{name: string, supplier: string|null}[]} input.parameters
 *        Range parameter sets (src/pricing/tracking-parameters.js)
 * @param {{id: number, name: string, slug: string}[]} input.suppliers
 * @param {{alias: string, supplier_id: number}[]} [input.aliases] `supplier_aliases`
 * @param {{id: number, name: string, slug: string, supplier_id: number|null}[]} input.brands
 * @returns {object} frozen plan
 */
export const planSupplierRollup = ({
  parameters = [],
  suppliers = [],
  aliases = [],
  brands = [],
}) => {
  const reports = {
    unmatchedSuppliers: [],
    rangesWithoutSupplier: [],
    rangesWithoutBrand: [],
    brandsLinkedElsewhere: [],
    brandsClaimedBySeveralSuppliers: [],
  }

  const supplierById = new Map(suppliers.map((row) => [row.id, row]))
  const byName = new Map(suppliers.map((row) => [nameKey(row.name), row]))
  const bySlug = new Map(suppliers.map((row) => [row.slug, row]))
  const byAlias = new Map()
  for (const alias of aliases) {
    const row = supplierById.get(alias.supplier_id)
    if (row) byAlias.set(nameKey(alias.alias), row)
  }

  const brandByName = new Map(brands.map((row) => [nameKey(row.name), row]))
  const brandBySlug = new Map(brands.map((row) => [row.slug, row]))

  // A range resolves to a house on the same two exact routes. 33 of 58 do; the
  // 25 that do not are the naming decisions `src/seed/CLAUDE.md` already lists
  // (`LIBERTY`/Liberty London, `NO 9`/No.9 Thompson), not absences.
  const brandFor = (range) => {
    const key = nameKey(range)
    if (key === '') return null
    const named = brandByName.get(key)
    if (named) return { row: named, via: 'name' }
    const slug = sluggable(range)
    const slugged = slug ? brandBySlug.get(slug) : undefined
    return slugged ? { row: slugged, via: 'slug' } : null
  }

  // display key -> { supplier, ranges: [], match }
  const entities = new Map()

  for (const parameter of parameters) {
    const range = typeof parameter?.name === 'string' ? parameter.name.trim() : ''
    if (range === '') continue

    const display = typeof parameter?.supplier === 'string' ? parameter.supplier.trim() : ''
    if (display === '') {
      // 3 of the 55 leave it blank: Atelier's own lines and the dead
      // `Miscellaneous` row. A house Atelier is its own supplier of is not an
      // unmatched invoicing entity, so it is its own report.
      reports.rangesWithoutSupplier.push(range)
      continue
    }

    const key = nameKey(display)
    if (!entities.has(key)) {
      entities.set(key, {
        supplier: display,
        ranges: [],
        match: resolveSupplier(display, { byName, bySlug, byAlias }),
      })
    }
    entities.get(key).ranges.push(range)
  }

  const rollup = []
  const brandLinks = []
  // brand id -> supplier display names claiming it
  const claimants = new Map()

  for (const key of [...entities.keys()].sort()) {
    const entity = entities.get(key)
    const houses = []

    for (const range of entity.ranges) {
      const brand = brandFor(range)
      if (!brand) {
        reports.rangesWithoutBrand.push(
          Object.freeze({
            range,
            supplier: entity.supplier,
            reason: 'no live house matches this range by name or by slug',
          })
        )
        continue
      }
      houses.push(Object.freeze({ brand_id: brand.row.id, brand: brand.row.name, via: brand.via }))

      if (!claimants.has(brand.row.id)) claimants.set(brand.row.id, new Set())
      claimants.get(brand.row.id).add(entity.supplier)

      if (!entity.match) continue
      if (brand.row.supplier_id != null) {
        if (brand.row.supplier_id !== entity.match.row.id) {
          reports.brandsLinkedElsewhere.push(
            Object.freeze({
              brand: brand.row.name,
              linked_to: supplierById.get(brand.row.supplier_id)?.name ?? null,
              parameters_say: entity.match.row.name,
              reason: 'a house’s supplier is a commercial decision; the existing link stands',
            })
          )
        }
        continue
      }
      brandLinks.push(
        Object.freeze({
          brand_id: brand.row.id,
          brand: brand.row.name,
          supplier_id: entity.match.row.id,
          supplier: entity.match.row.name,
          via: `range “${range}” under supplier “${entity.supplier}” (${entity.match.via})`,
        })
      )
    }

    if (!entity.match) {
      reports.unmatchedSuppliers.push(
        Object.freeze({
          supplier: entity.supplier,
          ranges: Object.freeze([...entity.ranges].sort((a, b) => a.localeCompare(b))),
          houses: Object.freeze(houses.map((house) => house.brand)),
          reason:
            'no live supplier matches this invoicing entity by name, by slug or by alias — add ' +
            'the alias in the CRM, one at a time, and re-run',
        })
      )
    }

    rollup.push(
      Object.freeze({
        supplier: entity.supplier,
        supplier_id: entity.match?.row.id ?? null,
        matched_via: entity.match?.via ?? null,
        ranges: Object.freeze([...entity.ranges].sort((a, b) => a.localeCompare(b))),
        brands: Object.freeze(houses),
      })
    )
  }

  for (const [brandId, names] of claimants) {
    if (names.size > 1) {
      // Two invoicing entities naming ranges that both resolve to one house.
      // Reported rather than resolved: the house's supplier is a single column
      // and picking one of two would be the guess this module exists to refuse.
      reports.brandsClaimedBySeveralSuppliers.push(
        Object.freeze({
          brand: brands.find((row) => row.id === brandId)?.name ?? null,
          suppliers: Object.freeze([...names].sort()),
        })
      )
    }
  }

  return Object.freeze({
    rollup,
    // The plan `npm run backfill:suppliers` applies. Only houses with no
    // supplier yet, and only under an invoicing entity that resolved.
    brandLinks,
    reports: Object.freeze(
      Object.fromEntries(Object.entries(reports).map(([name, rows]) => [name, Object.freeze(rows)]))
    ),
    summary: Object.freeze({
      ranges: parameters.length,
      suppliers: rollup.length,
      suppliers_matched: rollup.filter((row) => row.supplier_id !== null).length,
      suppliers_unmatched: reports.unmatchedSuppliers.length,
      ranges_without_supplier: reports.rangesWithoutSupplier.length,
      ranges_without_brand: reports.rangesWithoutBrand.length,
      brand_links: brandLinks.length,
      brands_linked_elsewhere: reports.brandsLinkedElsewhere.length,
      brands_claimed_by_several_suppliers: reports.brandsClaimedBySeveralSuppliers.length,
    }),
  })
}

/**
 * The same roll-up against the live database. Range rows only — a `Type` row
 * carries no supplier and no parameter at all.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<object>}
 */
export const runSupplierRollup = async (pool) => {
  const [{ parameters }, suppliers, aliases, brands] = await Promise.all([
    listRangeParameters(pool, { limit: MAX_LIMIT }),
    pool.query(`SELECT id, name, slug FROM suppliers ORDER BY id`),
    pool.query(`SELECT alias, supplier_id FROM supplier_aliases`),
    pool.query(
      `SELECT id, name, slug, supplier_id FROM brands WHERE archived_at IS NULL ORDER BY id`
    ),
  ])

  return planSupplierRollup({
    parameters,
    suppliers: suppliers.rows,
    aliases: aliases.rows,
    brands: brands.rows,
  })
}
