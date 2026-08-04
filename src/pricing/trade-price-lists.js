// Client-facing TRADE SELL price lists, per house.
//
// ##########################################################################
// # THIS MODULE MUST NEVER TOUCH `price_list_items`.                       #
// ##########################################################################
//
// `price_list_items` is Atelier's BUY-SIDE book: 19.5k supplier line rates in
// the suppliers' own currencies, for 40 maisons, and for most suppliers the rate
// is already discount-inclusive — it IS Atelier's net cost, with no arithmetic
// required. Handing a client one row of it lets them divide it into the trade
// price and recover Atelier's margin to the cent, and those lists are the
// maisons' confidential documents, so the exposure is also a breach of the
// supply agreements. It is served by `/admin/price-list-items` behind
// requireRole('backoffice') and that guard is never to be widened; nor is
// `/admin/legacy/prices`, whose detail route returns the full `raw` jsonb and
// bypasses every column whitelist. `test/price-list-exposure.test.js` asserts
// both, plus that no shape this module emits carries a cost-side key.
//
// What a client may see is the SELL side: `products.trade_price_cents`, the same
// figure the catalogue already shows an approved trade account on every product
// card. Publishing a downloadable list of numbers the shopper can already read
// one at a time adds no new disclosure — it is a convenience, and the CSV is
// cost-free by construction because it is built from one column.
//
// ---------------------------------------------------------------------------
// DISABLED BY DEFAULT, ON PURPOSE. `trade_price_cents` is currently seeded from
// the vendored demo pricing snapshot: 8 of the 12 seeded fabrics carry the
// identical NZ$187.76 and all 36 finished goods carry nothing. A per-house price
// list is a commercial document a designer quotes a job from, and 'indicative'
// does not make a wrong number safe. So the routes exist, are tested, and are
// mounted only when `TRADE_PRICE_LISTS_ENABLED=true`; turning it on is a
// business decision about the numbers, not a deploy.
// ---------------------------------------------------------------------------

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/** Every column this module is allowed to select. Cost-side columns are absent. */
const ITEM_COLUMNS = `p.name AS design,
        col.name AS collection,
        c.name AS colourway,
        c.sku,
        p.composition,
        p.width,
        p.application,
        p.lead_time,
        p.trade_price_cents`

// Products a client may be quoted from: on the website, not archived, in a house
// that is not archived, and actually priced. A null price on a downloadable list
// reads as "free" or as a mistake, so an unpriced design is simply not on it.
const ITEM_CONDITIONS = `p.show_on_website = true
        AND p.archived_at IS NULL
        AND b.archived_at IS NULL
        AND p.trade_price_cents IS NOT NULL`

/**
 * The houses that have at least one priced design, for the portal's index.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ brands: object[] }>}
 */
export const listTradePriceListBrands = async (pool) => {
  const { rows } = await pool.query(
    `SELECT b.slug,
            b.name,
            b.country,
            count(*) AS item_count,
            count(DISTINCT p.id) AS design_count
       FROM products p
       JOIN brands b ON b.id = p.brand_id
       LEFT JOIN colourways c ON c.product_id = p.id AND c.archived_at IS NULL
      WHERE ${ITEM_CONDITIONS}
      GROUP BY b.id, b.slug, b.name, b.country
      ORDER BY b.name`
  )
  return {
    brands: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      country: row.country,
      item_count: Number(row.item_count),
      design_count: Number(row.design_count),
    })),
  }
}

/**
 * One house's trade sell list.
 *
 * @param {import('pg').Pool} pool
 * @param {string} brandSlug
 * @returns {Promise<{ brand: object, items: object[] }>}
 * @throws 404 when the house is unknown or has nothing priced
 */
export const getTradePriceList = async (pool, brandSlug) => {
  const { rows } = await pool.query(
    `SELECT b.slug AS brand_slug,
            b.name AS brand_name,
            ${ITEM_COLUMNS}
       FROM products p
       JOIN brands b ON b.id = p.brand_id
       LEFT JOIN collections col ON col.id = p.collection_id AND col.archived_at IS NULL
       LEFT JOIN colourways c ON c.product_id = p.id AND c.archived_at IS NULL
      WHERE b.slug = $1
        AND ${ITEM_CONDITIONS}
      ORDER BY p.name, c.name NULLS FIRST`,
    [brandSlug]
  )
  if (rows.length === 0) {
    throw httpError(404, 'No trade price list is published for that house.')
  }
  return {
    brand: { slug: rows[0].brand_slug, name: rows[0].brand_name },
    items: rows.map((row) => ({
      design: row.design,
      collection: row.collection,
      colourway: row.colourway,
      sku: row.sku,
      composition: row.composition,
      width: row.width,
      application: row.application,
      lead_time: row.lead_time,
      // Integer NZD cents, exactly as the catalogue serves it.
      trade_price_cents: row.trade_price_cents,
      currency: 'NZD',
    })),
  }
}

/** The CSV header, in order. Asserted verbatim by the exposure test. */
export const CSV_HEADER = Object.freeze([
  'Design',
  'Collection',
  'Colourway',
  'SKU',
  'Composition',
  'Width',
  'Application',
  'Lead time',
  'Trade price (NZD)',
])

// A spreadsheet treats a cell opening with any of these as a FORMULA, so a
// product name a staff member typed as "=cut to order" becomes live code in the
// client's Excel — and =HYPERLINK/=WEBSERVICE can exfiltrate the rest of the
// sheet. Every column below is staff-typed free text via PATCH /admin/products.
// Prefixing with an apostrophe is the standard neutralisation: Excel shows the
// text and evaluates nothing.
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r']

const csvCell = (value) => {
  if (value === null || value === undefined) {
    return ''
  }
  const text = String(value)
  const guarded = FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix)) ? `'${text}` : text
  // RFC 4180: quote when the value carries a quote, comma or newline, and double
  // any embedded quote.
  return /["\n\r,]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

const csvRow = (cells) => cells.map(csvCell).join(',')

/**
 * A house's list as CSV (Excel opens it directly — McKenzie & Willis asked for
 * Excel and this is the format that needs no library and no XLSX writer).
 *
 * PDF is deliberately not produced: the design draws a PDF button beside the
 * Excel one, but a branded PDF needs the template A15 still owes, and the API
 * ships no renderer.
 *
 * @param {{ items: object[] }} list  from getTradePriceList
 * @returns {string}
 */
export const toTradePriceListCsv = ({ items }) => {
  const lines = [csvRow(CSV_HEADER)]
  for (const item of items) {
    lines.push(
      csvRow([
        item.design,
        item.collection,
        item.colourway,
        item.sku,
        item.composition,
        item.width,
        item.application,
        item.lead_time,
        (item.trade_price_cents / 100).toFixed(2),
      ])
    )
  }
  // Trailing newline: a file that ends mid-row makes some importers drop it.
  return `${lines.join('\r\n')}\r\n`
}

/**
 * The download filename. Built from the brand SLUG (already `[a-z0-9-]` by
 * construction, since slugs are server-generated), so nothing a staff member
 * typed — least of all a CR or a quote — can reach the Content-Disposition
 * header.
 *
 * @param {string} brandSlug
 * @returns {string}
 */
export const csvFilename = (brandSlug) => `atelier-trade-prices-${brandSlug}.csv`
