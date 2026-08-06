/**
 * Jim Thompson — two drops, four houses, and the colour names on a sheet of
 * their own.
 *
 * The annual file has nine sheets and the spring drop six, but the priced ones
 * (`FABRIC`, `WALLPAPER`, `THROWS`) name no colour: `CODE LIST` is where the
 * `OFFICIAL COLOUR NAME` lives, and it is complete — it carries all 2,922
 * fabric and all 392 wallpaper article codes, 3,320 in total. So the colourway
 * sheet is the code list and the priced sheets are US-005's problem. The two
 * throw codes it does not carry (`FLTR0001003`, `FLTR0002003`) are the only
 * stock in this workbook that no sheet gives a colour name to.
 *
 * The two drops name the same sheet differently (`CODE LIST` and `CODE LIST
 * 2026`) AND ORDER ITS COLUMNS DIFFERENTLY — the code precedes the name in one
 * and follows it in the other — which is why a column map is by label. The
 * spring drop is a strict subset: all 221 of its codes are in the annual with
 * the same colour name, so the overlap is a duplicate to reconcile downstream,
 * not two readings of one colourway.
 *
 * `BRAND` carries four houses. Two are the catalogue's (`Jim Thompson`,
 * `No.9 Thompson`); `BILL BENSLEY X JIM THOMPSON` is a collaboration and
 * `FOX LINTON` is a house of its own — the price list files 481 of these codes
 * under supplier "Fox Linton" — and neither is in the catalogue, so both pass
 * through raw for the import to report.
 */

import { skip } from './rates.js'

const HOUSES = Object.freeze({
  'jim thompson': 'Jim Thompson',
  'no.9 thompson': 'No.9 Thompson',
})

/**
 * `JT013998001` -> the design's code and the colour's three-digit suffix.
 *
 * The price list keys on the eight-character design code (`JT010139` "NEW
 * KHMER"), and every one of the 3,320 article codes splits. 2,839 of the
 * derived design codes are in the Jim Thompson price list and the remaining 481
 * are exactly the Fox Linton rows, which that list does not cover.
 */
const ARTICLE_CODE = /^(.*?)(\d{3})$/

const thompsonRecord = (values) => {
  const parts = ARTICLE_CODE.exec(values.colourCode)
  if (parts === null) throw new Error(`article code "${values.colourCode}" carries no colour suffix`)
  return {
    brand: HOUSES[values.brand.toLowerCase()] ?? values.brand,
    design: values.design,
    designCode: parts[1],
    colourCode: values.colourCode,
    colourName: values.colourName,
  }
}

const codeList = (name) => Object.freeze({
  name,
  brand: 'Jim Thompson',
  columns: Object.freeze({
    brand: 'Brand',
    design: 'Article Name',
    colourCode: 'Article Code',
    colourName: 'Official Colour Name',
  }),
  row: thompsonRecord,
})

/**
 * The rates are on THREE OTHER SHEETS — this is the one file in the corpus
 * whose colour names and whose prices never meet.
 *
 * `CODE LIST` names every colourway and prices none; `FABRIC`, `WALLPAPER` and
 * `THROWS` price every article code and name no colour. So the rate sheets are
 * those three, read for rates alone, and the code is still the DESIGN's — the
 * eight characters the article code splits into, which is what the office's 652
 * Jim Thompson rows are keyed on.
 *
 * The selling unit is prose rather than a token ("PRICE PER ROLL", "PRICE PER
 * METRE: 3 METRES MINIMUM", "ROLL (6.8M.) SET OF 2 PANELS"), and it decides
 * which of the sheet's two price columns is the one to read: a roll row is
 * priced by the selling unit, a metre row by the metre. A row that names
 * neither — the four fabrics sold as a set of two panels — is declined, because
 * the template has no pack for a set and pricing it per panel would halve it.
 */
const SUPPLIERS = Object.freeze({
  'jim thompson': 'Jim Thompson',
  // The price list files this house as its own supplier: 60 rows, and 481 of
  // this workbook's article codes are its.
  'fox linton': 'Fox Linton',
})

const thompsonRate = (produce) => (values) => {
  // Each priced sheet ends in a footnote under the table ("PTO = Print to
  // Order"), which carries no article code and no price.
  if (values.code === '') return skip('note under the table')
  const parts = ARTICLE_CODE.exec(values.code)
  if (parts === null) throw new Error(`article code "${values.code}" carries no colour suffix`)
  const produced = produce(values)
  if (produced === null) {
    // Every unit that is neither a roll nor a metre is a set of panels, and the
    // reason names that kind rather than repeating the row's own long prose.
    return skip(/\bSET\b/i.test(values.unit)
      ? 'sold as a set of panels, which no template pack type covers'
      : `sold by "${values.unit}", which no template pack type covers`)
  }
  return {
    supplier: SUPPLIERS[values.brand.toLowerCase()],
    brand: HOUSES[values.brand.toLowerCase()] ?? values.brand,
    code: parts[1],
    description: values.design,
    contents: values.contents,
    patternMatch: values.match,
    ...produced,
  }
}

/** A roll row is priced by the selling unit; a metre row by the metre. */
const bySellingUnit = (values) => {
  if (/\bROLLS?\b/i.test(values.unit)) return { packType: 'p/roll', wholesale: values.perUnit }
  if (/\bMETRES?\b/i.test(values.unit)) return { packType: 'p/m', wholesale: values.wholesale }
  return null
}

export const JIM_THOMPSON = Object.freeze({
  prefix: 'Jim Thompson Export Price List_USD_2026',
  supplier: 'Jim Thompson',
  sheets: Object.freeze([codeList('CODE LIST')]),
  rateSheets: Object.freeze([
    Object.freeze({
      name: 'FABRIC',
      brand: 'Jim Thompson',
      currency: 'US Dollar',
      itemType: 'Fabrics',
      // The sheet repeats `H`, `V`, `CM.` and `IN.` under two group headings, so
      // no width or repeat can be declared here without naming a column twice —
      // `PATTERN REPEAT` is the match ("STRAIGHT MATCH"), not a measurement.
      columns: Object.freeze({
        code: 'Article Code',
        design: 'Article Name',
        brand: 'Brand',
        unit: 'Selling Unit',
        wholesale: 'EXPORT USD 2026 (PER METRE)',
        contents: 'Contents',
        match: 'Pattern Repeat',
      }),
      row: thompsonRate((values) => (/\bMETRES?\b/i.test(values.unit)
        ? { packType: 'p/m', wholesale: values.wholesale }
        : null)),
    }),
    Object.freeze({
      name: 'WALLPAPER',
      brand: 'Jim Thompson',
      currency: 'US Dollar',
      itemType: 'Wallcovering',
      columns: Object.freeze({
        code: 'Article Code',
        design: 'Article Name',
        brand: 'Brand',
        unit: 'Selling Unit',
        wholesale: 'EXPORT USD 2026 (BY METRE)',
        perUnit: 'EXPORT USD BY 2026 (SELLING UNIT)',
        contents: 'Ground/Substrate',
        match: 'Pattern Match',
        width: 'Width (cm)',
      }),
      row: thompsonRate(bySellingUnit),
    }),
    Object.freeze({
      name: 'THROWS',
      brand: 'Jim Thompson',
      currency: 'US Dollar',
      // A throw is a finished piece, which of the template's four item types is
      // an accessory. The sheet states no unit because there is only one.
      itemType: 'Accessories',
      columns: Object.freeze({
        code: 'Article Code',
        design: 'Article Name',
        brand: 'Brand',
        wholesale: 'EXPORT USD 2026',
        contents: 'Content',
        width: 'Size',
      }),
      row: thompsonRate((values) => ({ packType: 'p/p', wholesale: values.wholesale })),
    }),
  ]),
})

// The longest prefix wins, so this seasonal drop is not shadowed by the annual
// one it shares a name with.
//
// It declares NO rate sheets. Its `FABRIC` and `WALLPAPER` sheets price a RANGE
// of article codes in one cell ("JT013998001 to 002") rather than a code, and
// every one of its 221 codes is in the annual drop, which prices them
// individually — so reading these would add no rate and would have to invent a
// way to split a range.
export const JIM_THOMPSON_SS26 = Object.freeze({
  prefix: "Jim Thompson Export Price List_USD_2026 - SS'26",
  supplier: 'Jim Thompson',
  sheets: Object.freeze([codeList('CODE LIST 2026')]),
})
