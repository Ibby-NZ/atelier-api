// A house invoiced by more than one supplier (migration 1791638400000).
//
// `brands.supplier_id` is the MAIN supplier and everything that derived a
// supplier from a brand before this keeps doing so. `brand_additional_suppliers`
// holds only the others, so the main one is never stated twice: adding it here
// is a 422, and admin-brands.js drops the link when an additional supplier is
// promoted to main.
//
// `supplierForBrand` is the one rule for "which supplier does this document
// address": the caller's choice when it is one of the house's suppliers, the
// main one when the caller names none. Purchase orders and the pricing preview
// both route through it, so the two can never disagree about who may invoice a
// house.

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode })

const SUPPLIER_FIELDS = 's.id, s.name, s.currency, s.agent, s.incoterm, s.po_email, s.default_discount'

/**
 * Add another supplier to a house. Idempotent: adding a supplier twice is
 * the same statement once.
 *
 * @param {import('pg').Pool} db
 * @param {number} brandId
 * @param {number} supplierId
 * @returns {Promise<void>}
 */
export const addBrandSupplier = async (db, brandId, supplierId) => {
  const { rows } = await db.query('SELECT supplier_id FROM brands WHERE id = $1', [brandId])
  if (rows.length === 0) throw httpError(404, `Brand ${brandId} not found.`)
  if (rows[0].supplier_id === supplierId) {
    throw httpError(422, 'That supplier is already the main supplier for this house.')
  }
  try {
    await db.query(
      `INSERT INTO brand_additional_suppliers (brand_id, supplier_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [brandId, supplierId]
    )
  } catch (error) {
    if (error?.code === '23503') throw httpError(422, 'That supplier does not exist.')
    throw error
  }
}

/**
 * Remove an additional supplier from a house. Removing one that is not linked
 * is a 404, so a stale screen hears about it.
 *
 * @param {import('pg').Pool} db
 * @param {number} brandId
 * @param {number} supplierId
 * @returns {Promise<void>}
 */
export const removeBrandSupplier = async (db, brandId, supplierId) => {
  const { rowCount } = await db.query(
    'DELETE FROM brand_additional_suppliers WHERE brand_id = $1 AND supplier_id = $2',
    [brandId, supplierId]
  )
  if (rowCount === 0) {
    throw httpError(404, `Supplier ${supplierId} is not an additional supplier of brand ${brandId}.`)
  }
}

/**
 * The supplier a document for this house is addressed to: `supplierId` when it
 * is the main or an additional supplier, the main one when it is null. Returns
 * null when the house has no supplier to fall back to; a named supplier that
 * does not invoice the house is a 422. The brand must exist (callers load it
 * first).
 *
 * @param {import('pg').Pool} db
 * @param {number} brandId
 * @param {number|null} [supplierId]
 * @returns {Promise<object|null>} the supplier row ({id, name, currency, agent, incoterm, po_email, default_discount})
 */
export const supplierForBrand = async (db, brandId, supplierId = null) => {
  if (supplierId == null) {
    const { rows } = await db.query(
      `SELECT ${SUPPLIER_FIELDS} FROM brands b JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = $1`,
      [brandId]
    )
    return rows[0] ?? null
  }
  const { rows } = await db.query(
    `SELECT ${SUPPLIER_FIELDS} FROM suppliers s
      WHERE s.id = $2
        AND (EXISTS (SELECT 1 FROM brands WHERE id = $1 AND supplier_id = s.id)
             OR EXISTS (SELECT 1 FROM brand_additional_suppliers
                         WHERE brand_id = $1 AND supplier_id = s.id))`,
    [brandId, supplierId]
  )
  if (rows.length === 0) {
    throw httpError(422, `Supplier ${supplierId} does not invoice this house.`)
  }
  return rows[0]
}
