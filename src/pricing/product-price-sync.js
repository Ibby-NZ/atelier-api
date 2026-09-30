// The range price, written onto the catalogue product it prices.
//
// A product price (src/pricing/product-prices.js) is priced live through its
// house; a catalogue PRODUCT carries its own trade price, wholesale rate and
// category, which is what the storefront, order lines, price bands and
// purchase orders read. 25 Sep 2026, the office after the one-product test:
// "I can see the ELLA STRIPE product price, but that isn't being reflected onto
// the product itself in Catalogue → Products." This module is that reflection.
//
// WHICH PRODUCT. A product built from a row (`products.product_price_id`,
// src/catalogue/product-price-catalogue.js) takes THAT row, and only it. Any
// other is matched by name: the Dynamics description under the house the range
// prices through — the pricer's own `houseFor`, so the match cannot fork from
// the price. Description or code, trimmed, case-insensitive.
//
// WHAT IS WRITTEN, per product:
//   trade_price_cents  the range calculation's trade sell (NZ$ — the store's
//                      selling currency, which every product price is in)
//   retail_price_cents the retail sell: the trade sell × (1 + the house's
//                      retail markup), where the house has one (28 Sep 2026);
//                      where the range cannot reach a trade sell, the trade
//                      price the product already carries × (1 + that markup)
//                      (1 Oct 2026 — a markup was set and retail stayed blank)
//   wholesale_rate     the export's wholesale rate, in the SUPPLIER's currency
//                      — only where the product's own `currency` is that one;
//                      a product in another currency is reported, never
//                      converted
//   category           from the export's Type (Fabrics → fabric), where the
//                      product has none and the word is in the vocabulary
//   freight_class      the row's Dynamics freight letter (A–E), where the
//                      product has none (1 Oct 2026)
//   duty_class         the row's duty class (A–C, inferred from its two
//                      Dynamics prices), where the product has none
//
// Each product is priced at ITS OWN class letters — its freight class (else
// the row's letter) and its discount class — so a letter the office chose on
// the product is the one its price is made at.
//
// WHEN. Every product-prices upload, and every pricing save that moves a range
// figure (src/routes/admin-pricing.js — the house page, /pricing, an exchange
// rate, the ranges import) over the products it prices. A house given a retail
// markup or freight after the upload gets its products' prices at once, not at
// the next upload (30 Sep 2026: products sat without a retail price under a
// house that had a markup).
//
// FILL-ONLY UNLESS ASKED — the cutover merge's rule for prices. An import
// fills what is BLANK and reports every price the product already carries
// that disagrees (`kept`); a person replaces one deliberately, from the
// product's page, which is `overwrite`. A figure the office typed is never
// overwritten by an upload.
//
// AUDITED BY THE CAPTURE TRIGGER. Every write runs under `withChangeContext`:
// an import as source `import` with the uploaded file's name, a person's
// replace as `manual` with a reason naming the range price — so the product's
// Price history says where each move came from.
//
// A design two export rows name at DIFFERENT prices is `ambiguous` and left
// alone (829 range+code pairs repeat in the 25 Sep export); an unpriced row
// (no house, a figure missing) writes nothing.

import { withChangeContext } from './price-history.js'
import { createProductPricer, nameKey } from './product-prices.js'
import { categorySlugs } from '../catalogue/categories.js'
import { categoryForItemType } from '../../scripts/lib/price-template.js'

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode })

export const MAX_REPORTED = 50
/** The cutover merge's own change-source file (src/legacy/merge.js). */
const MERGE_SOURCE = 'merge:legacy'

const cents = (dollars) => (dollars == null ? null : Math.round(dollars * 100))
const round4 = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000

// What one field would do: fill a blank, replace (only with `overwrite`),
// keep a different value, or nothing because they already agree.
const decide = (current, next, overwrite) => {
  if (next == null) return null
  if (current == null) return 'fill'
  if (current === next) return 'same'
  return overwrite ? 'replace' : 'kept'
}

/**
 * What writing the range prices onto the catalogue would do. Reads only.
 *
 * @param {{ query: Function }} db
 * @param {{ overwrite?: boolean, productPriceId?: number|null, productPriceIds?: number[]|null,
 *           productId?: number|null, brandIds?: number[]|null }} [scope]
 *   `productPriceId` and/or `productId` narrow it to one price row and/or one
 *   product; `productPriceIds` to a set of rows (the markups an upload moved);
 *   `brandIds` to the products of those houses (a house's pricing was saved);
 *   absent, every row of the latest export against every product.
 */
export const planProductSync = async (
  db,
  { overwrite = false, productPriceId = null, productPriceIds = null, productId = null, brandIds = null } = {}
) => {
  const { rows: priceRows } = await db.query(
    `SELECT id, guid::text AS guid, code, description, range_name, item_type, currency,
            wholesale_rate, duty_class, freight_letter, trade_markup_percent,
            dynamics_price_ex_duty, dynamics_price_incl_duty, dynamics_trade_sell
       FROM product_prices
      WHERE ($2::int[] IS NOT NULL AND id = ANY($2::int[]))
         OR ($2::int[] IS NULL AND (($1::int IS NULL AND last_import_id = (SELECT max(id) FROM product_price_imports))
                                  OR id = $1::int))`,
    [productPriceId, productPriceIds]
  )
  const pricer = createProductPricer(db)

  // house id + name -> the price rows naming it
  const rowsByKey = new Map()
  for (const row of priceRows) {
    const house = await pricer.houseFor(row.range_name)
    if (!house) continue
    for (const name of new Set([nameKey(row.description), nameKey(row.code)])) {
      if (!name) continue
      const key = `${house.id}\u0000${name.replace(/\s+/g, ' ')}`
      rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row])
    }
  }

  const rowById = new Map(priceRows.map((row) => [row.id, row]))
  const { rows: products } = await db.query(
    `SELECT p.id, p.name, p.slug, p.brand_id, b.name AS house, p.currency, p.category,
            p.trade_price_cents, p.retail_price_cents, p.wholesale_rate, p.product_price_id,
            p.discount_class, p.freight_class, p.duty_class
       FROM products p JOIN brands b ON b.id = p.brand_id
      WHERE p.archived_at IS NULL AND ($1::int IS NULL OR p.id = $1::int)
        AND ($2::int[] IS NULL OR p.brand_id = ANY($2::int[]))
      ORDER BY p.id`,
    [productId, brandIds]
  )
  const vocabulary = new Set(await categorySlugs(db))
  // A price the cutover merge last set (Dynamics' stored figure, copied onto a
  // blank) is nobody's decision, so it counts as blank here and the range's
  // price replaces it; a price a person or an upload set is kept as before.
  const { rows: mergeSet } = await db.query(
    `SELECT h.product_id,
            (h.retail_moved AND h.source = 'import' AND h.source_file = $1) AS retail,
            (h.trade_moved AND h.source = 'import' AND h.source_file = $1) AS trade
       FROM (
         SELECT DISTINCT ON (product_id) product_id, source, source_file,
                new_retail_price_cents IS DISTINCT FROM old_retail_price_cents AS retail_moved,
                new_trade_price_cents IS DISTINCT FROM old_trade_price_cents AS trade_moved
           FROM product_price_history
          WHERE product_id = ANY($2::int[])
          ORDER BY product_id, changed_at DESC, id DESC
       ) h`,
    [MERGE_SOURCE, products.map((product) => product.id)]
  )
  const setByMerge = new Map(mergeSet.map((row) => [row.product_id, row]))

  const changes = []
  const report = { matched: 0, ambiguous: [], unpriced: [], currency_mismatch: [], kept: [] }
  for (const product of products) {
    const linked = product.product_price_id == null ? null : rowById.get(product.product_price_id)
    const matches = product.product_price_id != null
      ? (linked ? [linked] : null)
      : rowsByKey.get(`${product.brand_id}\u0000${nameKey(product.name).replace(/\s+/g, ' ')}`)
    if (!matches) continue
    report.matched += 1
    const priced = []
    const classes = {
      freightClass: product.freight_class ?? null,
      discountClass: product.discount_class ?? null,
      dutyClass: product.duty_class ?? null,
    }
    for (const row of matches) priced.push({ row, pricing: await pricer.price(row, classes) })
    const sells = new Set(priced.map(({ pricing }) => pricing.trade_sell))
    if (sells.size > 1) {
      report.ambiguous.push({ product_id: product.id, product: product.name, rows: priced.map(({ row }) => row.code) })
      continue
    }
    const [{ row, pricing }] = priced
    // An unpriced row (its house lacks a figure) still carries the export's
    // wholesale rate and type, and those land; only the trade sell waits.
    if (pricing.trade_sell == null) {
      report.unpriced.push({ product_id: product.id, product: product.name, why: pricing.reason ?? `${pricing.missing.join(', ')} not set` })
    }

    const merged = setByMerge.get(product.id)
    const trade = { from: product.trade_price_cents, to: cents(pricing.trade_sell) }
    trade.action = decide(merged?.trade ? null : trade.from, trade.to, overwrite)
    const markup = pricing.inputs?.retail_markup_percent?.value
    const carried = product.trade_price_cents > 0 ? product.trade_price_cents : null
    const retailCents = pricing.retail_sell != null
      ? cents(pricing.retail_sell)
      : markup != null && carried != null ? Math.round(carried * (1 + Number(markup) / 100)) : null
    const retail = { from: product.retail_price_cents, to: retailCents }
    retail.action = decide(merged?.retail ? null : retail.from, retail.to, overwrite)

    let wholesale = null
    if (product.currency === row.currency) {
      wholesale = {
        from: product.wholesale_rate == null ? null : round4(product.wholesale_rate),
        to: round4(row.wholesale_rate),
        currency: row.currency,
      }
      wholesale.action = decide(wholesale.from, wholesale.to, overwrite)
    } else {
      report.currency_mismatch.push({ product_id: product.id, product: product.name, product_currency: product.currency, price_currency: row.currency })
    }

    const category = categoryForItemType(row.item_type)
    const categoryFill = product.category == null && category && vocabulary.has(category) ? category : null
    const letter = typeof row.freight_letter === 'string' ? row.freight_letter.trim().toUpperCase() : ''
    const freightClassFill = product.freight_class == null && /^[A-E]$/.test(letter) ? letter : null
    const duty = typeof row.duty_class === 'string' ? row.duty_class.trim().toUpperCase() : ''
    const dutyClassFill = product.duty_class == null && /^[A-C]$/.test(duty) ? duty : null

    const moves = (field) => ['fill', 'replace'].includes(field?.action)
    const writes = moves(trade) || moves(retail) || moves(wholesale) || categoryFill || freightClassFill || dutyClassFill
    if (trade.action === 'kept' || retail.action === 'kept' || wholesale?.action === 'kept') {
      report.kept.push({
        product_id: product.id,
        product: product.name,
        trade_price_cents: trade.action === 'kept' ? trade : undefined,
        retail_price_cents: retail.action === 'kept' ? retail : undefined,
        wholesale_rate: wholesale?.action === 'kept' ? wholesale : undefined,
      })
    }
    if (!writes) continue
    changes.push(
      Object.freeze({
        product_id: product.id,
        product: product.name,
        house: product.house,
        product_price_id: row.id,
        trade,
        retail,
        wholesale,
        category: categoryFill,
        freight_class: freightClassFill,
        duty_class: dutyClassFill,
      })
    )
  }

  const count = (field, action) => changes.filter((change) => change[field]?.action === action).length
  return Object.freeze({
    overwrite,
    products_matched: report.matched,
    products_changing: changes.length,
    trade_filled: count('trade', 'fill'),
    trade_replaced: count('trade', 'replace'),
    retail_filled: count('retail', 'fill'),
    retail_replaced: count('retail', 'replace'),
    wholesale_filled: count('wholesale', 'fill'),
    wholesale_replaced: count('wholesale', 'replace'),
    category_filled: changes.filter((change) => change.category).length,
    freight_class_filled: changes.filter((change) => change.freight_class).length,
    duty_class_filled: changes.filter((change) => change.duty_class).length,
    kept_count: report.kept.length,
    kept: Object.freeze(report.kept.slice(0, MAX_REPORTED)),
    ambiguous_count: report.ambiguous.length,
    ambiguous: Object.freeze(report.ambiguous.slice(0, MAX_REPORTED)),
    unpriced_count: report.unpriced.length,
    unpriced: Object.freeze(report.unpriced.slice(0, MAX_REPORTED)),
    currency_mismatch: Object.freeze(report.currency_mismatch.slice(0, MAX_REPORTED)),
    changes: Object.freeze(changes.slice(0, MAX_REPORTED)),
    // For apply; not serialised by a route.
    writes: Object.freeze(changes),
  })
}

/**
 * Write the planned changes in one transaction, under the price-history
 * context. Re-plans inside the transaction so what is written is what the
 * database holds now.
 *
 * @param {import('pg').Pool} pool
 * @param {{ overwrite?: boolean, productPriceId?: number|null, productId?: number|null,
 *           brandIds?: number[]|null, userId?: number|null, sourceFile?: string|null,
 *           reason?: string|null }} options
 */
export const applyProductSync = async (
  pool,
  { overwrite = false, productPriceId = null, productPriceIds = null, productId = null, brandIds = null,
    userId = null, sourceFile = null, reason = null } = {}
) => {
  // A person's replace is `manual`; an upload's — even one that replaces, as a
  // markup file does for the rows it moved — is an `import` of that file.
  const context = overwrite && !sourceFile
    ? { source: 'manual', reason: reason ?? 'Set to the price from its range', userId }
    : { source: 'import', sourceFile: sourceFile ?? 'product prices', userId }
  return withChangeContext(pool, context, async (client) => {
    const plan = await planProductSync(client, { overwrite, productPriceId, productPriceIds, productId, brandIds })
    const writes = plan.writes
    if (writes.length > 0) {
      const set = (change, field) => (['fill', 'replace'].includes(change[field]?.action) ? change[field].to : null)
      await client.query(
        `UPDATE products p
            SET trade_price_cents = COALESCE(s.trade, p.trade_price_cents),
                retail_price_cents = COALESCE(s.retail, p.retail_price_cents),
                wholesale_rate = COALESCE(s.wholesale, p.wholesale_rate),
                category = COALESCE(p.category, s.category),
                freight_class = COALESCE(p.freight_class, s.freight_class),
                duty_class = COALESCE(p.duty_class, s.duty_class)
           FROM unnest($1::int[], $2::int[], $3::numeric[], $4::text[], $5::int[], $6::text[], $7::text[])
             AS s(id, trade, wholesale, category, retail, freight_class, duty_class)
          WHERE p.id = s.id`,
        [
          writes.map((change) => change.product_id),
          writes.map((change) => set(change, 'trade')),
          writes.map((change) => set(change, 'wholesale')),
          writes.map((change) => change.category),
          writes.map((change) => set(change, 'retail')),
          writes.map((change) => change.freight_class ?? null),
          writes.map((change) => change.duty_class ?? null),
        ]
      )
    }
    // The write list is for this function, not for the wire.
    const report = { ...plan }
    delete report.writes
    return Object.freeze(report)
  })
}

/**
 * One product price onto one product, replacing what the product carries — the
 * product page's "Set as the trade price". 404 when the two do not name each
 * other (another house, another design).
 */
export const applyPriceToProduct = async (pool, { productPriceId, productId, userId = null }) => {
  const plan = await planProductSync(pool, { overwrite: true, productPriceId, productId })
  if (plan.products_matched === 0) {
    throw httpError(404, 'That product price does not name this product.')
  }
  const { rows } = await pool.query(`SELECT code, range_name FROM product_prices WHERE id = $1`, [productPriceId])
  const label = rows[0] ? `${rows[0].code}, ${rows[0].range_name}` : `product price ${productPriceId}`
  return applyProductSync(pool, {
    overwrite: true,
    productPriceId,
    productId,
    userId,
    reason: `Set to the price from its range (${label})`,
  })
}
