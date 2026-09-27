/**
 * Fine — one sheet, one row per colourway, and the design and colour number run
 * together in one cell.
 *
 * `Artikel` is "Celia 060": the design, then the supplier's colour number. The
 * Dynamics product prices name the DESIGN ("Celia", range FINE), so the number
 * is split off and the rest is the design. Over the whole file (Sep 2026 drop,
 * 4,170 rows) 4,121 rows are plainly "<design> <number>"; of the other 49:
 *
 * - 45 carry a footnote mark after the number ("Bad Aussee 010 °", "Duca
 *   040*"). The sheet has no legend for either mark, so it is dropped, not
 *   interpreted;
 * - 2 put a qualifier AFTER the number ("Comfy 030 FR"). The price list files
 *   that design as "Comfy FR", the spelling every other FR design in the sheet
 *   already has ("Blando FR 010"), so the number is taken out of the middle;
 * - 2 are not colourways: "Gleamy Fleur 040 - STORNO 3.8. FIX" (the supplier's
 *   own cancellation note) and "Darklin PFP" (a zero-priced line with no colour
 *   number). Both are declined with their reason; anything else that will not
 *   split still throws.
 *
 * `Farbe` is the supplier's colour column, a colour FAMILY in German ("Grau |
 * Anthrazit"), shared by several colourways of one design. It is the only colour
 * cell the file has, so it is carried as the colour name as written.
 *
 * No rate sheet is declared: Fine's prices reach the platform through the
 * Dynamics product prices (461 FINE rows), and the pricing template has no Fine
 * supplier row to measure a spelling against.
 */
import { skip } from './records.js'

/** A trailing footnote mark the sheet never explains. */
const MARK = /\s*[°*]+\s*$/

/** The colour number: a token of digits and nothing else. */
const NUMBER = /^\d+$/

const fineRecord = (values) => {
  const article = values.article.replace(MARK, '').trim()
  if (/\bSTORNO\b/i.test(article)) return skip('cancelled by the supplier (STORNO)')
  const words = article.split(/\s+/)
  const numbers = words.filter((word) => NUMBER.test(word))
  if (numbers.length === 0 && Number(values.price) === 0) {
    return skip('zero-priced line with no colour number')
  }
  if (numbers.length !== 1) {
    throw new Error(`cannot split "${values.article}" into a design and one colour number`)
  }
  return {
    design: words.filter((word) => !NUMBER.test(word)).join(' '),
    colourCode: numbers[0],
    colourName: values.colour,
  }
}

export const FINE = Object.freeze({
  prefix: 'FINE Artikelliste',
  supplier: 'Fine',
  sheets: Object.freeze([
    Object.freeze({
      name: 'Tabelle1',
      brand: 'Fine',
      columns: Object.freeze({
        article: 'Artikel\nArticle',
        colour: 'Farbe\nColor',
        price: 'EK-Preis €\nTrade price €',
      }),
      row: fineRecord,
    }),
  ]),
})
