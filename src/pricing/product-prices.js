// The re-imported Dynamics product prices, each priced through its house.
//
// A product price row (`product_prices`, migration 1791926400000) carries what
// the PRODUCT knows — wholesale rate, currency, range, type, whether duty
// applies — and nothing it does not. Every other figure is its RANGE's, and a
// range is a house: `range_name` is matched to `brands.name` case-insensitively
// and trimmed, the rule the freight ledger already uses. So the
// price is derived on every read, never stored, and a change to a house's
// clearance or markup reprices every product in the range at once.
//
// THE FORMULA IS THE CLIENT'S, AND IT IS THE ONE ENGINE'S. The office described
// it on 25 Sep 2026 (ELLA STRIPE, MADEAUX):
//
//     wholesale 47.60 ÷ exchange rate 0.38            = 125.26  price ex duty
//     + duty from the range (none on this product)    = 125.26  price incl duty
//     + freight 50                                    = 175.26
//     × (1 + clearance 10%)                           = 192.79  landed
//     × (1 + trade markup 87%)                        = 360.52  trade sell
//
// plus the range's supplier discount off the wholesale rate before the
// exchange (0 on MADEAUX; 50% on ALTAGAMMA — the export's own prices prove it
// on 20,651 of 20,977 rows). That is `computeWaterfall` step for step, so this
// module computes nothing itself: it assembles the inputs and hands them over.
//
// TWO INPUTS THE RANGE FORMULA DOES NOT HAVE. The engine also takes an FX
// margin and a per-unit handling charge, which the platform's own Pricing
// screen can set and the Dynamics formula never had. Left missing they would
// null out every landed cost, so here — and only here — an UNSET one is "not a
// step of this formula" (0, source `none`, and it says so), while a value
// finance HAS set on the house or the supplier is applied as set. That is the
// one deliberate departure from the engine's never-substitute-zero rule, and it
// is the client's formula rather than a default: the office stated the steps.
//
// THE EXCHANGE RATE IS THE ROW'S OWN CURRENCY'S, from `fx_rates` — not the
// supplier's invoicing currency the house resolver uses, because the product
// row says what it is quoted in (MADEAUX is Pound Sterling). NZ$ rows are 1.
//
// FREIGHT IS THE HOUSE'S, AT THE ROW'S LETTER. Dynamics priced freight by the
// row's letter (A/B/C/D per range — Fabricut's A is $30, its B $3, its C $5).
// The client answered F1 in September 2026 that freight is per house, and the
// house page has since gained a rate per freight letter (freight classes), so a
// row takes its house's rate for its letter where the house has one and the
// house's every-class rate otherwise. Until 30 Sep 2026 the letter was never
// passed, so a class rate set on the house page never reached this page, and
// every B/C/D row of a range whose letters cost differently in Dynamics showed
// a difference.
//
// DUTY. A row whose two Dynamics prices differ was charged duty (the class A
// band); one whose two prices agree was not, as in the ELLA STRIPE example.
//
// A ROW DYNAMICS PRICED BY HAND IS ITS OWN PRICE. "Set prices manually"
// (Alpaka, Garrett Leather, Loro Piana, Brochier, C & C Milano, Atelier Stock —
// 54 rows in the 28 Sep 2026 export, both duty prices blank) is priced in
// Dynamics from a duty %, a markup and a freight typed on the product, with
// freight after the markup and no clearance, and the result is often rounded
// by hand (725 against 724.17) — inputs no export carries. The range formula
// cannot reach it (Alpaka's house has no freight or discount of its own), so
// until 1 Oct 2026 such a row had no trade price and therefore no retail price
// however the house's retail markup was set. Its trade price is now Dynamics'
// own (which carries Dynamics' 5% duty), and the house's retail markup goes on
// it like on any other trade price.

import { computeWaterfall } from './waterfall.js'
import { listFxRates, resolveWaterfallInputs } from './pricing-parameters.js'
import { categoryForItemType } from '../../scripts/lib/price-template.js'
import { slugify } from '../seed/slugify.js'

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode })

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

/** Two cents: the export stores its figures rounded while the engine computes unrounded. */
export const AGREEMENT_TOLERANCE = 0.02

/** The currency the platform prices in; a row quoted in it needs no exchange. */
export const HOME_CURRENCY = 'NZD'

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100

const HAND_PRICED = 'Dynamics priced this product by hand ("Set prices manually")'

// pg returns numeric as a string, and Number(null) is 0 — see waterfall.js.
const numeric = (value) => (value == null ? null : Number(value))

/** How a range name meets a house name: trimmed, case-insensitive. */
export const nameKey = (value) => String(value ?? '').trim().toLowerCase()

const sluggable = (name) => {
  try {
    return slugify(name) || null
  } catch {
    return null
  }
}

const input = (value, source, detail = null) =>
  Object.freeze({ value, source, ...(detail ? { detail } : {}) })

// The formula's two absent steps: applied when finance has set one, otherwise
// not a step at all — see the header.
const notInFormula = (resolved, what) =>
  resolved.source === 'missing'
    ? input(0, 'none', { reason: `The range formula has no ${what}. Set one on the Pricing screen to add it.` })
    : resolved

// The house's surcharge, house over supplier, as the resolver reads every
// parameter. Not a waterfall input — it is charged per line under the minimum.
const surchargeOf = ({ house, supplier }) => {
  for (const [row, source] of [[house, 'house'], [supplier, 'supplier']]) {
    if (row?.surcharge_per_unit != null) {
      return Object.freeze({ min_qty: row.surcharge_min_qty, per_unit: row.surcharge_per_unit, source })
    }
  }
  return null
}

/**
 * A pricer for one request (or one import): it loads the houses and the
 * exchange rates once and resolves each house's inputs once per category, so a
 * page of fifty rows or a file of twenty thousand costs a handful of queries
 * per house rather than per row.
 *
 * @param {{ query: Function }} db
 * @param {{ fxRates?: Map<string, { rate: number, set_on?: string|null, planned?: boolean }> }} [options]
 *   `fxRates` replaces the table's rates — the import's dry run prices with the
 *   rates it is about to fill.
 */
export const createProductPricer = (db, { fxRates = null, shared = null } = {}) => {
  let houses = shared?.houses ?? null
  let rates = fxRates
  // A house's resolution does not depend on the exchange rate (that is the
  // row's currency's), so a pricer made by `withRates` reuses this one's.
  const resolutions = shared?.resolutions ?? new Map()

  // THE RANGES IMPORT'S OWN MATCHING RULE, exactly (`brandFor` in
  // parameters-backfill.js): the name first, trimmed and case-insensitive, the
  // NEWEST live house winning a tie; then the range's slug against the houses'
  // slugs ("RAMM, SON & CROCKER" finds a house named "Ramm Son & Crocker"). A
  // product must price through the house its range's figures landed on — a
  // second rule here would split them the day two houses share a name.
  const loadHouses = async () => {
    if (houses) return houses
    const { rows } = await db.query(
      `SELECT id, name, slug FROM brands WHERE archived_at IS NULL ORDER BY id`
    )
    const house = (row) => Object.freeze({ id: row.id, name: row.name, slug: row.slug })
    houses = {
      byName: new Map(rows.map((row) => [nameKey(row.name), house(row)])),
      bySlug: new Map(rows.map((row) => [row.slug, house(row)])),
    }
    return houses
  }

  const loadRates = async () => {
    if (rates) return rates
    rates = new Map((await listFxRates(db)).map((row) => [row.currency, row]))
    return rates
  }

  /** The live house a range name belongs to, or null. */
  const houseFor = async (rangeName) => {
    const key = nameKey(rangeName)
    if (key === '') return null
    const { byName, bySlug } = await loadHouses()
    return byName.get(key) ?? bySlug.get(sluggable(rangeName)) ?? null
  }

  // A house is resolved once per category and class letters. Duty resolves at
  // the row's (or product's) duty class; with none, the row is replaced below
  // by the formula's own "no duty".
  const resolve = async (house, category, freightClass, discountClass, dutyClass) => {
    const key = [house.id, category ?? '', freightClass ?? '', discountClass ?? '', dutyClass ?? ''].join('\u0000')
    if (!resolutions.has(key)) {
      resolutions.set(
        key,
        resolveWaterfallInputs(db, { brandId: house.id, category, dutyClass: dutyClass ?? 'A', freightClass, discountClass }).catch((error) => {
          if (!error.statusCode || error.statusCode >= 500) throw error
          return { error: error.message }
        })
      )
    }
    return resolutions.get(key)
  }

  const fxInput = async (currency) => {
    if (currency === HOME_CURRENCY) return input(1, 'none', { reason: 'Priced in NZ$ — no exchange.' })
    const rate = (await loadRates()).get(currency)
    if (!rate) return input(null, 'missing', { reason: `No exchange rate is set for ${currency}.`, currency })
    return input(rate.rate, 'fx', { currency, set_on: rate.set_on ?? null, ...(rate.planned ? { planned: true } : {}) })
  }

  /**
   * Price one row. Always answers — a row whose range has no house, or whose
   * house is missing an input, comes back with `status` saying which and every
   * step it could not reach as null.
   *
   * @param {object} row a product_prices row (or an import row of the same shape)
   * @param {{ freightClass?: string|null, discountClass?: string|null, dutyClass?: string|null }} [classes]
   *   the letters a catalogue product (or variation) chose, over the row's own
   *   Dynamics freight letter and duty class and the house's default discount class
   */
  const price = async (row, classes = {}) => {
    const dynamics = Object.freeze({
      price_ex_duty: numeric(row.dynamics_price_ex_duty),
      price_incl_duty: numeric(row.dynamics_price_incl_duty),
      trade_sell: numeric(row.dynamics_trade_sell),
      freight_letter: row.freight_letter ?? null,
    })
    const house = await houseFor(row.range_name)
    if (!house) {
      return Object.freeze({
        status: 'no_house',
        reason: `No house is named "${row.range_name}". Raise it (or rename one to match) and every product in the range prices at once.`,
        house: null,
        category: categoryForItemType(row.item_type),
        inputs: null,
        steps: null,
        landed: null,
        trade_sell: null,
        retail_sell: null,
        missing: Object.freeze([]),
        surcharge: null,
        dynamics,
        difference: null,
        agrees: null,
      })
    }

    const category = categoryForItemType(row.item_type)
    const rowLetter = typeof row.freight_letter === 'string' ? row.freight_letter.trim().toUpperCase() : ''
    const letter = classes.freightClass ?? (/^[A-Z]$/.test(rowLetter) ? rowLetter : null)
    const rowDuty = typeof row.duty_class === 'string' ? row.duty_class.trim().toUpperCase() : ''
    const dutyLetter = classes.dutyClass ?? (/^[A-C]$/.test(rowDuty) ? rowDuty : null)
    const resolved = await resolve(house, category, letter, classes.discountClass ?? null, dutyLetter)
    if (resolved.error) {
      return Object.freeze({
        status: 'incomplete',
        reason: resolved.error,
        house,
        category,
        inputs: null,
        steps: null,
        landed: null,
        trade_sell: null,
        retail_sell: null,
        missing: Object.freeze([]),
        surcharge: null,
        dynamics,
        difference: null,
        agrees: null,
      })
    }

    const hasDuty = dutyLetter != null
    const inputs = Object.freeze({
      discount_percent: resolved.inputs.discount_percent,
      fx_rate: await fxInput(row.currency),
      fx_margin_percent: notInFormula(resolved.inputs.fx_margin_percent, 'FX margin'),
      duty_percent: hasDuty
        ? resolved.inputs.duty_percent
        : input(0, 'none', { reason: 'Dynamics charged no duty on this product.' }),
      freight: resolved.inputs.freight,
      clearance_percent: resolved.inputs.clearance_percent,
      handling: notInFormula(resolved.inputs.handling, 'handling charge'),
      // A product price that carries its own markup to trade (Dynamics' "Markup
      // to Trade %", 39 of 21,054 on 28 Sep 2026) takes it over its range's.
      trade_markup_percent:
        row.trade_markup_percent != null
          ? input(numeric(row.trade_markup_percent), 'product', {
              replaced: { value: resolved.inputs.trade_markup_percent.value, source: resolved.inputs.trade_markup_percent.source },
            })
          : resolved.inputs.trade_markup_percent,
      retail_markup_percent: resolved.inputs.retail_markup_percent,
      retail_markup: resolved.inputs.retail_markup,
    })

    if (row.dynamics_price_ex_duty == null && row.dynamics_price_incl_duty == null) {
      const trade = dynamics.trade_sell
      const percent = inputs.retail_markup_percent.value
      return Object.freeze({
        status: trade == null ? 'incomplete' : 'priced',
        reason: trade == null ? `${HAND_PRICED} and carries no trade price for it.` : `${HAND_PRICED}; its price is Dynamics' own.`,
        hand_priced: true,
        house,
        category,
        inputs,
        steps: null,
        landed: null,
        trade_sell: trade,
        retail_sell: trade == null || percent == null ? null : round2(trade * (1 + Number(percent) / 100)),
        missing: Object.freeze([]),
        surcharge: surchargeOf(resolved.parameters),
        dynamics,
        difference: trade == null ? null : 0,
        agrees: trade == null ? null : true,
      })
    }

    const waterfall = computeWaterfall({
      wholesale_rate: numeric(row.wholesale_rate),
      currency: row.currency,
      discount_percent: inputs.discount_percent.value,
      fx_rate: inputs.fx_rate.value,
      fx_margin_percent: inputs.fx_margin_percent.value,
      duty_percent: inputs.duty_percent.value,
      freight: inputs.freight.value,
      freight_basis: inputs.freight.detail?.basis ?? 'dollar',
      clearance_percent: inputs.clearance_percent.value,
      clearance_basis: inputs.clearance_percent.detail?.basis ?? 'percent',
      handling: inputs.handling.value,
      trade_markup_percent: inputs.trade_markup_percent.value,
      retail_markup_percent: inputs.retail_markup_percent.value,
      retail_markup: inputs.retail_markup.value,
    })

    // The retail markup is not part of the trade formula; its absence leaves
    // retail blank and nothing else.
    const missing = Object.freeze(waterfall.missing.filter((name) => name !== 'retail_markup'))
    const difference =
      waterfall.trade_sell == null || dynamics.trade_sell == null
        ? null
        : round2(waterfall.trade_sell - dynamics.trade_sell)

    return Object.freeze({
      status: waterfall.trade_sell == null ? 'incomplete' : 'priced',
      reason: null,
      house,
      category,
      inputs,
      steps: waterfall.steps,
      landed: waterfall.landed,
      trade_sell: waterfall.trade_sell,
      retail_sell: waterfall.retail_sell,
      missing,
      surcharge: surchargeOf(resolved.parameters),
      dynamics,
      difference,
      agrees: difference == null ? null : Math.abs(difference) <= AGREEMENT_TOLERANCE,
    })
  }

  /** The same pricer at other exchange rates — the import's dry run prices with the rates it will fill. */
  const withRates = async (nextRates) =>
    createProductPricer(db, { fxRates: nextRates, shared: { houses: await loadHouses(), resolutions } })

  return Object.freeze({ price, houseFor, loadHouses, loadRates, withRates })
}

// --- reads -------------------------------------------------------------------

const COLUMNS = `pp.id, pp.guid::text AS guid, pp.code, pp.description, pp.range_name,
  pp.item_type, pp.currency, pp.wholesale_rate,
  to_char(pp.date_effective, 'YYYY-MM-DD') AS date_effective,
  pp.horizontal_repeat, pp.vertical_repeat, pp.freight_letter, pp.duty_class,
  pp.dynamics_price_ex_duty, pp.dynamics_price_incl_duty, pp.dynamics_trade_sell, pp.trade_markup_percent,
  to_char(pp.dynamics_modified_on, 'YYYY-MM-DD HH24:MI:SS') AS dynamics_modified_on,
  pp.first_import_id, pp.last_import_id, pp.created_at, pp.updated_at`

const toRow = (row, latestImportId) =>
  Object.freeze({
    id: row.id,
    guid: row.guid,
    code: row.code,
    description: row.description,
    range_name: row.range_name,
    item_type: row.item_type,
    currency: row.currency,
    wholesale_rate: numeric(row.wholesale_rate),
    date_effective: row.date_effective,
    horizontal_repeat: row.horizontal_repeat,
    vertical_repeat: row.vertical_repeat,
    freight_letter: row.freight_letter,
    duty_class: row.duty_class,
    dynamics_price_ex_duty: numeric(row.dynamics_price_ex_duty),
    dynamics_price_incl_duty: numeric(row.dynamics_price_incl_duty),
    dynamics_trade_sell: numeric(row.dynamics_trade_sell),
    trade_markup_percent: numeric(row.trade_markup_percent),
    dynamics_modified_on: row.dynamics_modified_on,
    // A row a later export no longer carried is no longer Active in Dynamics.
    in_latest_export: latestImportId != null && row.last_import_id === latestImportId,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })

// The list carries what a row needs; the full step list is the detail's.
const summarise = (pricing) =>
  Object.freeze({
    status: pricing.status,
    reason: pricing.reason,
    house: pricing.house,
    price_ex_duty: pricing.steps?.find((step) => step.step === 'price_ex_duty')?.amount ?? null,
    freight: pricing.inputs?.freight.value ?? null,
    landed: pricing.landed,
    trade_sell: pricing.trade_sell,
    missing: pricing.missing,
    difference: pricing.difference,
    agrees: pricing.agrees,
  })

// The export stamp in the shape the upload reports it (`exportedAt`).
const IMPORT_COLUMNS = `i.id, i.filename, to_char(i.exported_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS exported_at,
  i.rows_read, i.rows_new, i.rows_changed, i.rows_unchanged, i.created_at,
  i.imported_by_user_id, u.name AS imported_by_name, u.email AS imported_by_email`

const toImport = (row) =>
  row
    ? Object.freeze({
        id: row.id,
        filename: row.filename,
        exported_at: row.exported_at,
        rows_read: row.rows_read,
        rows_new: row.rows_new,
        rows_changed: row.rows_changed,
        rows_unchanged: row.rows_unchanged,
        created_at: row.created_at,
        imported_by: row.imported_by_user_id
          ? Object.freeze({ id: row.imported_by_user_id, name: row.imported_by_name, email: row.imported_by_email })
          : null,
      })
    : null

/** The newest import, or null before the first. */
export const latestProductPriceImport = async (db) => {
  const { rows } = await db.query(
    `SELECT ${IMPORT_COLUMNS} FROM product_price_imports i
       LEFT JOIN users u ON u.id = i.imported_by_user_id
      ORDER BY i.id DESC LIMIT 1`
  )
  return toImport(rows[0])
}

/** Who imported which export, newest first. */
export const listProductPriceImports = async (db, { limit = 20 } = {}) => {
  const { rows } = await db.query(
    `SELECT ${IMPORT_COLUMNS} FROM product_price_imports i
       LEFT JOIN users u ON u.id = i.imported_by_user_id
      ORDER BY i.id DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)]
  )
  return Object.freeze(rows.map(toImport))
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (match) => `\\${match}`)

/**
 * One page of product prices, each with its price.
 *
 * @param {{ query: Function }} db
 * @param {{ q?: string, range?: string, brand_id?: number, design?: string,
 *           product_id?: number, currency?: string, include_previous?: boolean,
 *           limit?: number, page?: number }} [filters]
 *   `product_id` finds the rows behind one catalogue product by the sync's
 *   rule (product-price-sync.js): the row it was built from
 *   (`products.product_price_id`), else its house + its name as the Dynamics
 *   description or code (`brand_id` + `design`). Until 1 Oct 2026 the product
 *   page asked by name alone, and a product built from a row is named
 *   "SETA FIAMMATA 4741 (1)" — which names no row.
 */
export const listProductPrices = async (db, rawFilters = {}) => {
  const latest = await latestProductPriceImport(db)
  let filters = rawFilters
  // A product's rows are priced at the product's own class letters, so the
  // panel on its page shows the price the product is made at.
  let classes = {}
  if (rawFilters.product_id) {
    const { rows } = await db.query(
      `SELECT brand_id, name, product_price_id, discount_class, freight_class, duty_class FROM products WHERE id = $1`,
      [rawFilters.product_id]
    )
    if (rows.length === 0) throw httpError(404, 'That product does not exist.')
    const [product] = rows
    classes = { discountClass: product.discount_class, freightClass: product.freight_class, dutyClass: product.duty_class }
    filters = product.product_price_id != null
      ? { ...rawFilters, id: product.product_price_id, include_previous: true }
      : { ...rawFilters, brand_id: product.brand_id, design: product.name }
  }
  const limit = Math.min(Math.max(Number(filters.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  // 1-based, as every paged admin list here is (the CRM's list kit sends `page`).
  const page = Math.max(Math.floor(Number(filters.page)) || 1, 1)
  const offset = (page - 1) * limit

  const where = []
  const params = []
  const bind = (value) => {
    params.push(value)
    return `$${params.length}`
  }
  // Rows the latest export still carried, unless the caller asks for the rest.
  if (!filters.include_previous && latest) where.push(`pp.last_import_id = ${bind(latest.id)}`)
  if (filters.q) {
    const like = bind(`%${escapeLike(String(filters.q).trim())}%`)
    where.push(`(pp.code ILIKE ${like} OR pp.description ILIKE ${like} OR pp.range_name ILIKE ${like})`)
  }
  if (filters.id) where.push(`pp.id = ${bind(filters.id)}`)
  if (filters.range) where.push(`lower(btrim(pp.range_name)) = ${bind(nameKey(filters.range))}`)
  const pricer = createProductPricer(db)
  if (filters.brand_id) {
    // The ranges that price through this house, by the pricer's own matching
    // rule — a name match in SQL would miss a range found by its slug.
    const { rows: named } = await db.query(
      `SELECT lower(btrim(range_name)) AS key, min(range_name) AS range_name
         FROM product_prices GROUP BY lower(btrim(range_name))`
    )
    const keys = []
    for (const row of named) {
      if ((await pricer.houseFor(row.range_name))?.id === Number(filters.brand_id)) keys.push(row.key)
    }
    where.push(`lower(btrim(pp.range_name)) = ANY(${bind(keys)}::text[])`)
  }
  if (filters.design) {
    const design = bind(nameKey(filters.design).replace(/\s+/g, ' '))
    where.push(`(lower(btrim(pp.description)) = ${design} OR lower(btrim(pp.code)) = ${design})`)
  }
  if (filters.currency) where.push(`pp.currency = ${bind(String(filters.currency).toUpperCase())}`)
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const { rows: countRows } = await db.query(
    `SELECT count(*)::int AS total FROM product_prices pp ${clause}`,
    params
  )
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM product_prices pp ${clause}
      ORDER BY lower(pp.range_name), lower(pp.code), pp.id
      LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
    params
  )

  const items = []
  for (const row of rows) {
    const product = toRow(row, latest?.id ?? null)
    items.push(Object.freeze({ ...product, pricing: summarise(await pricer.price(product, classes)) }))
  }
  return Object.freeze({
    product_prices: Object.freeze(items),
    meta: Object.freeze({ total: countRows[0].total, page, limit, latest_import: latest }),
  })
}

/**
 * The ranges the imported rows name, each with its row count and the house it
 * prices through (null where none carries the name) — the list's filter and
 * the office's to-do list of houses still to raise.
 */
export const listProductPriceRanges = async (db) => {
  const latest = await latestProductPriceImport(db)
  const { rows } = await db.query(
    `SELECT min(btrim(range_name)) AS range_name, count(*)::int AS products
       FROM product_prices
      ${latest ? 'WHERE last_import_id = $1' : ''}
      GROUP BY lower(btrim(range_name))
      ORDER BY lower(btrim(range_name))`,
    latest ? [latest.id] : []
  )
  const pricer = createProductPricer(db)
  const ranges = []
  for (const row of rows) {
    ranges.push(Object.freeze({ ...row, house: await pricer.houseFor(row.range_name) }))
  }
  return Object.freeze(ranges)
}

/**
 * One product price with its full waterfall — every step, every input and the
 * source of each — plus the catalogue products it names.
 */
export const getProductPrice = async (db, id) => {
  const latest = await latestProductPriceImport(db)
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM product_prices pp WHERE pp.id = $1`, [id])
  if (rows.length === 0) throw httpError(404, 'That product price does not exist.')
  const product = toRow(rows[0], latest?.id ?? null)
  const pricing = await createProductPricer(db).price(product)

  // The catalogue products this row prices, by the sync's rule: those built
  // from it (`product_price_id`), and a product built from no row that carries
  // its Dynamics description or code under the house. Archived ones are not
  // priced and are left out. Until 1 Oct 2026 this was the name match alone,
  // which missed the row's own product ("SETA FIAMMATA 4741 (1)") and listed an
  // archived "SETA FIAMMATA" instead.
  const { rows: products } = await db.query(
    `SELECT id, name, slug FROM products
      WHERE archived_at IS NULL
        AND (product_price_id = $1
             OR (product_price_id IS NULL AND brand_id = $2
                 AND lower(btrim(name)) IN (lower(btrim($3)), lower(btrim($4)))))
      ORDER BY id`,
    [product.id, pricing.house?.id ?? null, product.description ?? '', product.code]
  )
  const catalogueProducts = products.map((row) => Object.freeze({ ...row }))

  return Object.freeze({
    ...product,
    pricing,
    catalogue_products: Object.freeze(catalogueProducts),
    latest_import: latest,
  })
}
