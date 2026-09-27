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
//   wholesale_rate     the export's wholesale rate, in the SUPPLIER's currency
//                      — only where the product's own `currency` is that one;
//                      a product in another currency is reported, never
//                      converted
//   category           from the export's Type (Fabrics → fabric), where the
//                      product has none and the word is in the vocabulary
// Retail is not written: the range formula stops at trade.
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
 * @param {{ overwrite?: boolean, productPriceId?: number|null, productId?: number|null }} [scope]
 *   `productPriceId` and/or `productId` narrow it to one price row and/or one
 *   product; absent, every row of the latest export against every product.
 */
export const planProductSync = async (db, { overwrite = false, productPriceId = null, productId = null } = {}) => {
  const { rows: priceRows } = await db.query(
    `SELECT id, guid::text AS guid, code, description, range_name, item_type, currency,
            wholesale_rate, duty_class, freight_letter,
            dynamics_price_ex_duty, dynamics_price_incl_duty, dynamics_trade_sell
       FROM product_prices
      WHERE ($1::int IS NULL AND last_import_id = (SELECT max(id) FROM product_price_imports))
         OR id = $1::int`,
    [productPriceId]
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
            p.trade_price_cents, p.wholesale_rate, p.product_price_id
       FROM products p JOIN brands b ON b.id = p.brand_id
      WHERE p.archived_at IS NULL AND ($1::int IS NULL OR p.id = $1::int)
      ORDER BY p.id`,
    [productId]
  )
  const vocabulary = new Set(await categorySlugs(db))

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
    for (const row of matches) priced.push({ row, pricing: await pricer.price(row) })
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

    const trade = { from: product.trade_price_cents, to: cents(pricing.trade_sell) }
    trade.action = decide(trade.from, trade.to, overwrite)

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

    const writes = trade.action === 'fill' || trade.action === 'replace' || ['fill', 'replace'].includes(wholesale?.action) || categoryFill
    if (trade.action === 'kept' || wholesale?.action === 'kept') {
      report.kept.push({
        product_id: product.id,
        product: product.name,
        trade_price_cents: trade.action === 'kept' ? trade : undefined,
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
        wholesale,
        category: categoryFill,
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
    wholesale_filled: count('wholesale', 'fill'),
    wholesale_replaced: count('wholesale', 'replace'),
    category_filled: changes.filter((change) => change.category).length,
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
 *           userId?: number|null, sourceFile?: string|null, reason?: string|null }} options
 */
export const applyProductSync = async (pool, { overwrite = false, productPriceId = null, productId = null, userId = null, sourceFile = null, reason = null } = {}) => {
  const context = overwrite
    ? { source: 'manual', reason: reason ?? 'Set to the price from its range', userId }
    : { source: 'import', sourceFile: sourceFile ?? 'product prices', userId }
  return withChangeContext(pool, context, async (client) => {
    const plan = await planProductSync(client, { overwrite, productPriceId, productId })
    const writes = plan.writes
    if (writes.length > 0) {
      const set = (change, field) => (['fill', 'replace'].includes(change[field]?.action) ? change[field].to : null)
      await client.query(
        `UPDATE products p
            SET trade_price_cents = COALESCE(s.trade, p.trade_price_cents),
                wholesale_rate = COALESCE(s.wholesale, p.wholesale_rate),
                category = COALESCE(p.category, s.category)
           FROM unnest($1::int[], $2::int[], $3::numeric[], $4::text[]) AS s(id, trade, wholesale, category)
          WHERE p.id = s.id`,
        [
          writes.map((change) => change.product_id),
          writes.map((change) => set(change, 'trade')),
          writes.map((change) => set(change, 'wholesale')),
          writes.map((change) => change.category),
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
