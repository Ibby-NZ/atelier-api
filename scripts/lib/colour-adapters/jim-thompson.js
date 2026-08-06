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

export const JIM_THOMPSON = Object.freeze({
  prefix: 'Jim Thompson Export Price List_USD_2026',
  supplier: 'Jim Thompson',
  sheets: Object.freeze([codeList('CODE LIST')]),
})

// The longest prefix wins, so this seasonal drop is not shadowed by the annual
// one it shares a name with.
export const JIM_THOMPSON_SS26 = Object.freeze({
  prefix: "Jim Thompson Export Price List_USD_2026 - SS'26",
  supplier: 'Jim Thompson',
  sheets: Object.freeze([codeList('CODE LIST 2026')]),
})
