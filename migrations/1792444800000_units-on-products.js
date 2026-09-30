/**
 * Units live on the product, not on the house's freight (1 Oct 2026).
 *
 * The office: "remove unit from ranges and freights, those values will be
 * separate from any kind of unit (per metre, etc). The units should go to the
 * products instead." A freight rate is now a figure and nothing more; what it
 * is per is the PRODUCT's unit — a Fabricut wallpaper priced per yard and a
 * Fabricut trimming per metre share one house.
 *
 * `products.unit` — metre, yard, roll, piece, hide or panel (the price
 * template's vocabulary, which the freight unit used); NULL is not stated.
 * Filled here, first from the product's OWN Dynamics pack type (the archived
 * product price it was built from: P/M, P/Y, P/Roll, P/P, Hide — on a cutover
 * copy this was right where the house's unit was not for 669 rolls and
 * pieces), then from what its house's freight said (the house's current
 * every-class dollar rate, else its supplier's). Anything else stays NULL for
 * the office to set.
 *
 * `supplier_freight_rates.unit` goes, with the two CHECKs that tied it to the
 * dollar basis and to the vocabulary.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
const UNITS = ['metre', 'yard', 'roll', 'piece', 'hide', 'panel']

export const up = (pgm) => {
  pgm.addColumn('products', {
    unit: { type: 'text', check: `unit IN (${UNITS.map((unit) => `'${unit}'`).join(', ')})` },
  })

  pgm.sql(`
    UPDATE products p
       SET unit = CASE lower(btrim(lp.pack_type))
                    WHEN 'p/m' THEN 'metre' WHEN 'p/y' THEN 'yard' WHEN 'p/roll' THEN 'roll'
                    WHEN 'p/p' THEN 'piece' WHEN 'p/hide' THEN 'hide' WHEN 'hide' THEN 'hide'
                    WHEN 'p/panel' THEN 'panel'
                  END
      FROM product_prices pp
      JOIN legacy_product_prices lp ON lp.guid = pp.guid
     WHERE pp.id = p.product_price_id AND p.unit IS NULL
       AND lower(btrim(lp.pack_type)) IN ('p/m', 'p/y', 'p/roll', 'p/p', 'p/hide', 'hide', 'p/panel')
  `)

  pgm.sql(`
    WITH house_rate AS (
      SELECT DISTINCT ON (lower(range_name)) lower(range_name) AS key, unit
        FROM supplier_freight_rates
       WHERE range_name IS NOT NULL AND category IS NULL AND freight_class IS NULL
         AND basis = 'dollar' AND effective_from <= current_date
       ORDER BY lower(range_name), effective_from DESC, id DESC
    ), supplier_rate AS (
      SELECT DISTINCT ON (supplier_id) supplier_id, unit
        FROM supplier_freight_rates
       WHERE supplier_id IS NOT NULL AND category IS NULL AND freight_class IS NULL
         AND basis = 'dollar' AND effective_from <= current_date
       ORDER BY supplier_id, effective_from DESC, id DESC
    )
    UPDATE products p
       SET unit = COALESCE(h.unit, s.unit)
      FROM brands b
      LEFT JOIN house_rate h ON h.key = lower(b.name)
      LEFT JOIN supplier_rate s ON s.supplier_id = b.supplier_id
     WHERE p.brand_id = b.id AND p.unit IS NULL AND COALESCE(h.unit, s.unit) IS NOT NULL
  `)

  pgm.dropConstraint('supplier_freight_rates', 'supplier_freight_rates_unit_basis_check', { ifExists: true })
  pgm.dropColumn('supplier_freight_rates', 'unit')
}

// The freight rows' units are not restored: the column comes back empty and
// unconstrained, and the products keep theirs until the column is dropped.
export const down = (pgm) => {
  pgm.addColumn('supplier_freight_rates', { unit: { type: 'text' } })
  pgm.dropColumn('products', 'unit')
}
