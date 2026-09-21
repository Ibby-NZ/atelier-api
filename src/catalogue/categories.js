// The merchandising vocabulary — one row per category, and the only place the
// list is read from at runtime.
//
// It used to be a CHECK constraint repeated on three columns, which made a new
// word a migration (see migrations/1791379200000_category-table.js). It is now
// `product_categories`, referenced by `products.category`,
// `price_list_items.category` and `supplier_freight_rates.category` with ON
// DELETE RESTRICT — so the database, not this module, is what refuses to delete
// a category something still carries.
//
// `CATEGORIES` in scripts/lib/price-template.js is NOT this list: it is the
// seeded nine, kept because the price-list templates are byte-pinned to it. Any
// runtime question ("is this a category?", "what may staff choose?") reads the
// table through here.

import { slugFrom } from './admin-brands.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Where a category added today is filed: after every seeded one, spaced the same
// way the seed is.
const SORT_STEP = 10

const toCategory = (row) =>
  Object.freeze({
    slug: row.slug,
    label: row.label,
    sort: row.sort,
    product_count: row.product_count ?? 0,
  })

/**
 * The vocabulary, in the order screens should offer it, each with the number of
 * products carrying it. The count is what tells the office in advance whether a
 * Delete will be accepted — the same posture the brand and collection reads
 * take with their child counts.
 *
 * @param {{ query: Function }} db
 * @returns {Promise<object[]>}
 */
export const listCategories = async (db) => {
  const { rows } = await db.query(
    `SELECT c.slug,
            c.label,
            c.sort,
            (SELECT count(*)::int FROM products p WHERE p.category = c.slug) AS product_count
       FROM product_categories c
      ORDER BY c.sort, c.label`
  )
  return rows.map(toCategory)
}

/**
 * Every stored category value, for validating one without a round trip per row.
 *
 * @param {{ query: Function }} db
 * @returns {Promise<Set<string>>}
 */
export const categorySlugs = async (db) => {
  // Ordered, because callers put the set into an error message ("use one of:
  // ...") and an unordered list reads as a different list every time.
  const { rows } = await db.query(
    `SELECT slug FROM product_categories ORDER BY sort, label`
  )
  return new Set(rows.map((row) => row.slug))
}

/**
 * Add a category. The slug is derived from the label and immutable afterwards,
 * the posture every other server-generated slug in the catalogue takes: it is
 * the value stored on three tables, so it cannot be a thing staff retype.
 *
 * A duplicate is a 409 rather than a silent no-op, and it is checked for on the
 * LABEL as well as the slug: "Bed Linen" beside "Bed linen" is two rows a person
 * cannot tell apart in a dropdown.
 *
 * @param {{ query: Function }} db
 * @param {{ label: string }} input
 * @returns {Promise<object>}
 */
export const createCategory = async (db, input) => {
  const label = String(input.label ?? '').trim()
  const slug = slugFrom(label)
  try {
    const { rows } = await db.query(
      `INSERT INTO product_categories (slug, label, sort)
       VALUES ($1, $2, (SELECT coalesce(max(sort), 0) + $3 FROM product_categories))
       RETURNING slug, label, sort`,
      [slug, label, SORT_STEP]
    )
    return toCategory(rows[0])
  } catch (error) {
    if (error?.code === '23505') {
      throw httpError(409, `"${label}" is already a category.`)
    }
    throw error
  }
}
