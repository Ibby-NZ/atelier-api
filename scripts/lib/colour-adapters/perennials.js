/**
 * Perennials — two drops, one house, and two different answers to "which
 * sheets hold the colourways".
 *
 * The fabrics file splits its stock across `Fabrics` and `Trims ` (the trailing
 * space is the sheet's real name — a sheet is addressed by name, so it is
 * declared exactly as written), and the two are disjoint: 867 fabrics, 101
 * trims, nothing in both.
 *
 * The wallcoverings file is the opposite. Its four type sheets — Patterns &
 * Murals, Metallics, Performance, Textures — are all reprinted in `ALL SKUS`
 * with a `Type` column, and the counts add up exactly (41 + 23 + 75 + 81 =
 * 220), so `ALL SKUS` alone is the whole file and declaring the four as well
 * would emit every wallcovering twice.
 *
 * Both files carry conditions-of-sale, care, shipping and showroom sheets,
 * which hold no stock and are simply not declared.
 */

const BRAND = 'Perennials'

export const PERENNIALS_FABRICS = Object.freeze({
  prefix: 'Perennials Fabrics',
  supplier: 'Perennials',
  sheets: Object.freeze([
    Object.freeze({
      name: 'Fabrics',
      brand: BRAND,
      // `Quality` is the design's code and `Quality Description` its name; the
      // price list keys on the quality (1000 "Stripe Du Jour", 115 "Willow
      // Way"), so both are kept.
      columns: Object.freeze({
        designCode: 'Quality',
        design: 'Quality Description',
        colourCode: 'Item Number',
        colourName: 'Colorway',
      }),
    }),
    Object.freeze({
      name: 'Trims ',
      brand: BRAND,
      // The trims sheet names the design in `Quality` and prints no code for
      // it; `Description` here is the construction, not the design.
      columns: Object.freeze({
        design: 'Quality',
        colourCode: 'Item Number',
        colourName: 'Colorway',
      }),
    }),
  ]),
})

export const PERENNIALS_WALLCOVERINGS = Object.freeze({
  prefix: 'Perennials Wallcoverings',
  supplier: 'Perennials',
  sheets: Object.freeze([
    Object.freeze({
      name: 'ALL SKUS',
      brand: BRAND,
      // `Collection` is a season ("2024 Summer"), not a code for the design.
      columns: Object.freeze({
        design: 'Design',
        colourCode: 'Item Number',
        colourName: 'Colorway',
      }),
    }),
  ]),
})
