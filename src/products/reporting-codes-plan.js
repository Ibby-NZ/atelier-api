// The reporting-codes backfill planner (W21 US-002, FR-276).
//
// IT REPORTS, IT NEVER GUESSES AND IT NEVER WRITES — the
// `src/suppliers/backfill-plan.js` posture, which reports the
// `Jannelli Volpi` / `Janelli Volpi` pair rather than collapsing it. Here that
// posture is the story rather than the style, because every join available is
// one the evidence has already measured as partial:
//
//   - THE LIVE CATALOGUE HAS NO RANGE CONCEPT AT ALL. `range_name` exists only
//     on the `legacy_*` staging mirror and `product_range` only on the buy-side
//     `price_list_items`. There is no column to copy from, which is why this is
//     a planner and not an UPDATE.
//   - ONLY 52% OF STOCK ITEMS RESOLVE TO ONE PRICE ROW. D365's own export
//     renders the price-row lookup as its target's DISPLAY NAME — the design
//     name — and design names repeat (VOLTERRA matches 25 price rows): 52.2%
//     resolve to one, 10.5% to several, 23.4% to none, 14.0% carry no value.
//     So the design name is a real key and an ambiguous one, and this module
//     refuses every row where it is ambiguous rather than taking the first.
//   - THE CODE IS NEVER THE KEY. The root guide forbids joining a supplier
//     colour code or a D365 item-code fragment to `price_list_items.code` —
//     they do not match by construction (price code `40951` for SUMI against
//     item `30093-03`). Nothing here reads `code`.
//
// ONE KEY ASSIGNS, AND IT IS THE HOUSE. A Range row IS a house — `Name` is
// Atelier's own spelling of the maison, and it hits
// `legacy_product_prices.range_name` on 48 of 58 rows covering 99.6% of the
// priced corpus. A brand resolves to a range on an exact `lower(btrim(...))`
// name match or an exact slug match, and on nothing else; a product takes its
// own brand's range and no other. That key is defensible because both halves
// are facts rather than resemblances: `products.brand_id` is a foreign key in
// this database, and the range spelling matches exactly or does not match.
//
// A HOUSE THAT RESOLVES TO SEVERAL RANGES IS REPORTED, NOT SPLIT.
// `C & C MILANO` and `C & C Milano Bedding` are two ranges of one house that
// carry different duty and different freight, and which of them a given design
// belongs to is not a fact this corpus holds.
//
// THE DESIGN NAME IS EVIDENCE AND NEVER AN ASSIGNER. `price_list_items.
// description` is the design name and it is the key D365's own export used —
// which is precisely why it is not trusted here: that key resolves 52.2% of
// stock items and is the thing this programme is asking the client to re-export
// away from. Used as a fallback it would assign another house's range to a
// design that merely shares a name, and there is nothing in the corpus to catch
// it, because a house that failed the range match has no range to contradict
// with. So it corroborates a match, it is reported where it disagrees with one,
// and it is reported beside every refusal — never written.
//
// A BRAND CODE HAS NO SOURCE, AND SAYING SO IS THIS MODULE'S SECOND JOB.
// Nothing Atelier has delivered carries one: `suppliers.short_code` and
// `suppliers.d365_token` are NULL on all 40 rows, `supplier_aliases` is empty,
// the parameter export has no code column, and `price_list_items` carries a
// filename prefix rather than a designation. What the corpus DOES hold is the
// token D365 composes into an item code (`F3518-003 23PF` -> `PF`), which sits
// beside `range_name` on the SAME `legacy_stock_items` row — so reading it is
// not a join and does not touch `price_list_items.code`. It is reported as
// EVIDENCE beside the refusal and is never planned, the posture
// `src/pricing/freight-recovery.js` takes with the recovered freight table:
// the letters are what the client answers F18 from, and F18 ("what is `CFJC`?")
// is exactly the question a mode over this corpus would answer by guessing.

import { slugify } from '../seed/slugify.js'

/** The comparison key every match here uses: `lower(btrim(name))`. */
export const nameKey = (value) => String(value ?? '').trim().toLowerCase()

const sluggable = (value) => {
  try {
    const slug = slugify(value)
    return slug === '' ? null : slug
  } catch {
    return null
  }
}

// The D365 item-code grammar, from the analysis: `{code}[ {YY}{TOKEN}]`. Two
// digits for the year the combination was first ordered, then the letters.
// Anchored at the end and requiring the space, so a code that merely happens to
// end in letters (`CUSH*SPEC55X55`, `AIREWCWH`) contributes nothing.
const ITEM_CODE_TOKEN = /\s\d{2}([A-Z]+)$/

/** The token an item code ends with, or null. Never a guess at a shorter one. */
export const itemCodeToken = (itemCode) => {
  const match = ITEM_CODE_TOKEN.exec(String(itemCode ?? '').trim().toUpperCase())
  return match ? match[1] : null
}

const sortedKeys = (map) => [...map.keys()].sort((left, right) => left.localeCompare(right))

const distinct = (values) => [...new Set(values)].sort((left, right) => left.localeCompare(right))

/**
 * Plan the reporting-code backfill from the corpora already on disk. Pure: same
 * inputs, same plan, no database and no I/O.
 *
 * @param {object} input
 * @param {{id: number, name: string, brand_id: number, product_range: string|null}[]} input.products
 * @param {{id: number, name: string, slug: string, supplier_id: number|null,
 *          brand_code: string|null}[]} input.brands
 * @param {{product_range: string|null, description: string|null}[]} input.priceListItems
 * @param {{range_name: string|null, item_code: string|null}[]} [input.stockItems]
 *        `legacy_stock_items`. Brand-code EVIDENCE only — never planned.
 * @returns {object} frozen plan
 */
export const planReportingCodes = ({
  products = [],
  brands = [],
  priceListItems = [],
  stockItems = [],
}) => {
  const reports = {
    ambiguousHouses: [],
    designNameDisagrees: [],
    unmatchedProducts: [],
    productsAlreadySet: [],
    rangesWithoutHouse: [],
    brandsWithoutCode: [],
    tokensClaimedBySeveralHouses: [],
    brandCodesAlreadySet: [],
  }

  // --- the range vocabulary, straight off the buy-side ledger ---------------
  // Its canonical spelling is the first one seen, so one corpus always produces
  // one plan; the key and the slug are what anything is matched on.
  const rangeByKey = new Map()
  const rangeBySlug = new Map()
  // design-name key -> Set of range keys
  const rangesByDesign = new Map()

  for (const item of priceListItems) {
    const range = typeof item?.product_range === 'string' ? item.product_range.trim() : ''
    if (range === '') continue
    const key = nameKey(range)
    if (!rangeByKey.has(key)) {
      rangeByKey.set(key, range)
      const slug = sluggable(range)
      // First spelling wins a slug too. A second range slugging to the same
      // value is not merged — it is a different range that reads alike.
      if (slug && !rangeBySlug.has(slug)) rangeBySlug.set(slug, key)
    }

    const design = nameKey(item?.description)
    if (design === '') continue
    if (!rangesByDesign.has(design)) rangesByDesign.set(design, new Set())
    rangesByDesign.get(design).add(key)
  }

  // --- by house: brand -> range keys, exact name or exact slug, nothing else -
  const brandById = new Map(brands.map((brand) => [brand.id, brand]))
  const houseRangeKeys = new Map()
  const claimedRangeKeys = new Set()

  for (const brand of brands) {
    const keys = new Set()
    const byName = rangeByKey.has(nameKey(brand.name)) ? nameKey(brand.name) : null
    if (byName) keys.add(byName)
    const bySlug = brand.slug ? rangeBySlug.get(brand.slug) : undefined
    if (bySlug) keys.add(bySlug)

    if (keys.size === 0) continue
    for (const key of keys) claimedRangeKeys.add(key)
    if (keys.size > 1) {
      // Two ranges under one house is a real state (a house split by product
      // line), and which line a design sits in is not in this corpus.
      reports.ambiguousHouses.push(
        Object.freeze({
          brand: brand.name,
          ranges: distinct([...keys].map((key) => rangeByKey.get(key))),
          reason: 'the house resolves to more than one range; a design cannot be assigned one',
        })
      )
      continue
    }
    houseRangeKeys.set(brand.id, [...keys][0])
  }

  // --- per product ----------------------------------------------------------
  const productRanges = []

  for (const product of products) {
    const brand = brandById.get(product.brand_id) ?? null
    const where = Object.freeze({
      product_id: product.id,
      product: product.name,
      brand: brand?.name ?? null,
    })

    if (product.product_range != null) {
      // Filled by staff or by an earlier run. A backfill that overwrote what it
      // found would undo an office correction every time it ran — the same
      // fill-only-what-is-NULL rule `backfill:suppliers` keeps.
      reports.productsAlreadySet.push(
        Object.freeze({ ...where, product_range: product.product_range })
      )
      continue
    }

    const byHouse = brand ? (houseRangeKeys.get(brand.id) ?? null) : null

    // What the design name would say, for corroboration and for the reports.
    // A name behind more than one range says nothing, which is the 10.5% of
    // stock items D365's own key cannot resolve either.
    const designRanges = rangesByDesign.get(nameKey(product.name))
    const byDesign = designRanges?.size === 1 ? [...designRanges][0] : null

    if (!byHouse) {
      reports.unmatchedProducts.push(
        Object.freeze({
          ...where,
          reason: brand
            ? 'the house matches no range in the price-list corpus by name or by slug'
            : 'the product has no house',
          // Reported, never applied — see the header on the design name.
          design_name_evidence: Object.freeze(
            designRanges ? distinct([...designRanges].map((key) => rangeByKey.get(key))) : []
          ),
        })
      )
      continue
    }

    if (byDesign && byDesign !== byHouse) {
      // A note rather than a refusal: design names repeat across houses by
      // construction (VOLTERRA matches 25 price rows), so this says the ledger
      // holds another house's design of the same name — not that the house is
      // wrong about its own range.
      reports.designNameDisagrees.push(
        Object.freeze({
          ...where,
          assigned: rangeByKey.get(byHouse),
          design_name_names: rangeByKey.get(byDesign),
          reason: 'the design name appears under a different range; the house was applied',
        })
      )
    }

    productRanges.push(
      Object.freeze({
        product_id: product.id,
        product: product.name,
        brand: brand?.name ?? null,
        product_range: rangeByKey.get(byHouse),
        via: 'house',
        // true agrees, false names another range, null had nothing to say.
        corroborated: byDesign === null ? null : byDesign === byHouse,
      })
    )
  }

  // Ranges the ledger carries that no live house resolves to. A plan that only
  // listed what it matched would read as "these are all the ranges", which is
  // how a missing house gets missed.
  for (const key of sortedKeys(rangeByKey)) {
    if (!claimedRangeKeys.has(key)) reports.rangesWithoutHouse.push(rangeByKey.get(key))
  }

  // --- brand codes: no source, plus the evidence that would answer F18 -------
  // token -> range keys, from `legacy_stock_items` rows carrying both. This is
  // one row's two columns, never a join.
  const tokensByRange = new Map()
  for (const item of stockItems) {
    const token = itemCodeToken(item?.item_code)
    if (!token) continue
    const key = nameKey(item?.range_name)
    if (key === '') continue
    if (!tokensByRange.has(key)) tokensByRange.set(key, new Map())
    const counts = tokensByRange.get(key)
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }

  const brandsByToken = new Map()
  for (const brand of brands) {
    if (brand.brand_code != null) {
      reports.brandCodesAlreadySet.push(
        Object.freeze({ brand: brand.name, brand_code: brand.brand_code })
      )
      continue
    }

    const key = houseRangeKeys.get(brand.id) ?? null
    const counts = key ? tokensByRange.get(key) : null
    const evidence = counts
      ? [...counts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([token, items]) => Object.freeze({ token, items }))
      : []

    for (const { token } of evidence) {
      if (!brandsByToken.has(token)) brandsByToken.set(token, [])
      brandsByToken.get(token).push(brand.name)
    }

    reports.brandsWithoutCode.push(
      Object.freeze({
        brand: brand.name,
        supplier_id: brand.supplier_id ?? null,
        range: key ? rangeByKey.get(key) : null,
        // Sorted by row count, and deliberately NOT reduced to the top one: the
        // corpus carries typos beside real codes (JIM THOMPSON's 637 items run
        // JT 630, J 5, JJT 1, T 1) and a mode over that is a guess wearing a
        // number. A person reads the breakdown.
        evidence: Object.freeze(evidence),
        reason:
          'no corpus Atelier has delivered carries a brand code; the item-code tokens beside this ' +
          'house are evidence for F18 and are never a plan',
      })
    )
  }

  for (const token of [...brandsByToken.keys()].sort()) {
    const claimants = distinct(brandsByToken.get(token))
    if (claimants.length > 1) {
      // The `CFJC` case, and the reason the unique index is per supplier: `CF`
      // is on 866 stock items across four ranges. Two houses cannot share one
      // code under one invoicing entity, and which of them owns it is F18.
      reports.tokensClaimedBySeveralHouses.push(Object.freeze({ token, brands: claimants }))
    }
  }

  return Object.freeze({
    // What a backfill would write. `brandCodes` is empty and stays empty until
    // the client answers F18 — the column is filled from the CRM, one house at
    // a time, exactly as a supplier alias is.
    productRanges,
    brandCodes: Object.freeze([]),
    reports: Object.freeze(
      Object.fromEntries(Object.entries(reports).map(([name, rows]) => [name, Object.freeze(rows)]))
    ),
    summary: Object.freeze({
      products: products.length,
      products_matched: productRanges.length,
      products_corroborated: productRanges.filter((row) => row.corroborated === true).length,
      products_already_set: reports.productsAlreadySet.length,
      products_design_name_disagrees: reports.designNameDisagrees.length,
      products_unmatched: reports.unmatchedProducts.length,
      brands: brands.length,
      brands_without_code: reports.brandsWithoutCode.length,
      brands_with_token_evidence: reports.brandsWithoutCode.filter(
        (row) => row.evidence.length > 0
      ).length,
      tokens_claimed_by_several_houses: reports.tokensClaimedBySeveralHouses.length,
      ranges: rangeByKey.size,
      ranges_without_house: reports.rangesWithoutHouse.length,
      houses_ambiguous: reports.ambiguousHouses.length,
    }),
  })
}

/**
 * The same plan against the live database. Four reads and the pure planner
 * above, so the matching rules are testable without a database and the database
 * version cannot drift from them.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<object>}
 */
export const runReportingCodesPlan = async (pool) => {
  const [products, brands, priceListItems, stockItems] = await Promise.all([
    pool.query(
      `SELECT id, name, brand_id, product_range FROM products
        WHERE archived_at IS NULL ORDER BY id`
    ),
    pool.query(
      `SELECT id, name, slug, supplier_id, brand_code FROM brands
        WHERE archived_at IS NULL ORDER BY id`
    ),
    pool.query(`SELECT product_range, description FROM price_list_items`),
    pool.query(`SELECT range_name, item_code FROM legacy_stock_items`),
  ])

  return planReportingCodes({
    products: products.rows,
    brands: brands.rows,
    priceListItems: priceListItems.rows,
    stockItems: stockItems.rows,
  })
}
