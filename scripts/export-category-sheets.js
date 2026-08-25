#!/usr/bin/env node
// The category workbooks for the two D365 catalogues.
//
// `GET /admin/product-sheet/export.csv` covers `products` — the seeded
// catalogue, one house at a time. The two catalogues the office actually works
// from live in the D365 staging mirror, and neither has ever carried a category:
//
//   prices  legacy_product_prices, 19,327 designs — the catalogue SPINE. The
//           CRM reads it at Dynamics → Price list.
//   stock   legacy_stock_items, 7,611 items — the stock LEDGER, the transacted
//           subset (an item exists here once it has been bought or sold). This
//           is what the CRM's Stock → Reserves tab shows; it reads
//           `GET /admin/legacy/stock`, whatever the tab is labelled.
//
// They are different grains and must stay two files: a design in the price list
// is one row per colourway family, a stock item is one row per item code with a
// quantity against it. Nothing joins them — `legacy_stock_items.product_price_list`
// is the price row's DESCRIPTION, not its code, and resolves to exactly one price
// row for only 52% of items (src/legacy/CLAUDE.md). Do not add a lookup here.
//
// ONE WORKBOOK PER CATALOGUE, not one file per house: `All …` carries every row
// and each house gets its own tab of the same rows, so the office can work one
// supplier at a time without keeping fifty files in step. The house tabs are a
// VIEW, not a partition — a row appears twice, once on its house's tab and once
// on the All tab. Whichever it is typed into, a re-import reads the GUID.
//
// The Category column is EMPTY, for the reason src/products/product-sheet.js
// records: blank has to mean "nobody got to this row" or no re-import can tell
// a skipped row from a confirmed one. `Suggested Category` beside it is derived
// from the D365 item type through CATEGORY_BY_ITEM_TYPE — the same map the
// supplier price-list template reads, so the two pipelines cannot drift on what
// "W/P" means. It is a suggestion in its own column and NOT the answer: the item
// types D365 actually carries include Leather, Towels, Cushions, Bedding, Bed
// Linen, Candles, Furniture, Rug/Carpet, Throws/Blankets, Samples and Displays
// and "No Group Selected", none of which the four-value vocabulary has a word
// for. Those come through blank and need a person.
//
// The Category cells carry an Excel dropdown of the four legal values. That is
// the note src/products/CLAUDE.md says a CSV has nowhere to put ("a CSV has
// nowhere to put a note Excel will not hand back as a data row") — in a workbook
// it goes on the cell, so an unknown category stops being a row error reported
// after the fact and becomes a value the office cannot type.
//
// Options: `--one-sheet` keeps the All tab alone; on `stock`, `--active`,
// `--in-stock` and `--latest` narrow the rows (Atelier: "we don't really need
// the inactive ones", "only the most recent reiteration"). What a filter leaves
// out is printed every run — a count on its own
// reads as "that is the whole ledger", which is the one thing it is not.
//
//   node scripts/export-category-sheets.js [prices|stock] [normalized-dir] [out-file]
//                                          [--one-sheet] [--active] [--in-stock] [--latest]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildWorkbook, columnLetter } from './lib/xlsx-write.js'
import { CATEGORIES, CATEGORY_BY_ITEM_TYPE } from './lib/price-template.js'

const DEFAULT_IN_DIR = 'incoming/data-exports/normalized'

/** D365 leaves a stock item unassigned; the tab still has to be called something. */
const NO_HOUSE = '(No house)'

const suggestCategory = (itemType) =>
  CATEGORY_BY_ITEM_TYPE.get(String(itemType ?? '').trim().toLowerCase()) ?? ''

// A quantity is passed as a NUMBER so the sheet can sort and total it; a code is
// passed as a STRING so "81634" stays a code. `null` for a figure D365 has not
// set, which is not the same statement as 0 and must not be written as one.
const quantity = (value) => (value == null ? null : Number(value))

const held = (record) =>
  Number(record.stock_on_hand ?? 0) > 0 || Number(record.stock_available ?? 0) > 0

/**
 * A D365 stock code's pricing year, or null when it carries none.
 *
 * The code is `{supplier's colour code} {YY}{SUPPLIER_TOKEN}` — `F3518-003 23PF`
 * is colour code F3518-003, priced in 2023, Pierre Frey — and re-pricing a design
 * mints a NEW code rather than editing the old one, which is what makes an item
 * code a version and the base a product. 74.6% of the ledger carries one.
 *
 * TWO TRAPS, both live in the corpus and both silently DELETE STOCK if missed:
 *
 *   The token must be LETTERS. `CUSH**MDC 55X55` is a 55×55 cushion inner with
 *   40 on hand, not a 2055 anything; `CLASSY ORGANIC Bath towel 76X142` is a
 *   towel. A `\d{2}\w+` suffix reads both as years and supersedes real stock.
 *   Every one of the 84 supplier tokens is 1–4 letters; every digit-bearing
 *   trailing token in the corpus is a size.
 *
 *   The year must be in WINDOW. The corpus runs 11–26 and the upper bound is
 *   "now", not a constant, or the first January of a new year starts discarding
 *   that year's re-pricings as if they were the future.
 */
const CODE_VERSION = /^(.*?)\s+(\d{2})([A-Z]{1,4})$/
const EARLIEST_YEAR = 11 // 2011, the oldest in the corpus
export const codeVersion = (itemCode, thisYear = new Date().getFullYear() % 100) => {
  const match = CODE_VERSION.exec(String(itemCode ?? '').trim())
  if (!match) return null
  const year = Number(match[2])
  if (year < EARLIEST_YEAR || year > thisYear) return null
  return { base: match[1], year, token: match[3] }
}

/** A filter that decides row by row. */
const rowFilter = (slug, describe, keep) => ({
  slug,
  describe,
  keep,
  select: (records) => records.filter(keep),
})

/**
 * Row filters, opted into per run. Atelier asked for these: the ledger is the
 * whole trading history, so more than half of it is items nobody has stocked for
 * years, and categorising those is work nothing reads.
 *
 * They narrow WHICH ROWS are exported and change nothing else — the columns, the
 * dropdown and the GUID key are the same, so a filtered sheet reads back exactly
 * like a full one. What is left out is always REPORTED, never silent.
 */
export const FILTERS = Object.freeze({
  '--active': rowFilter('active', 'status Active', (record) => record.status === 'Active'),
  '--in-stock': rowFilter(
    'in-stock',
    'some quantity on hand or available',
    // On hand OR available: an item can be committed to an order (available 0,
    // on hand 5) and is still stock somebody must categorise.
    held
  ),
  '--latest': {
    slug: 'latest',
    describe: 'newest pricing year per colour code',
    /**
     * The newest version of each product, by the year in its code.
     *
     * Grouped on the BASE alone and deliberately NOT on base + supplier token.
     * The token tracks the house, and a house's token moves under the same
     * product: `F4685-05` is Albeck 05 Beige as 22CF, 24JC and 26CF (Colefax &
     * Fowler and Jane Churchill are one supplier), `F3032-001` is EMPREINTE
     * Havane as 20PF, 23F and 25PF. Grouping by token keeps all of those, which
     * is precisely the older versions this filter exists to drop. All 17 groups
     * where the token AND the name move are the same design under a spelling
     * change ("AYUTHYA COLOUR 01 PAGODA RED" → "AYUTHYA 01 Pagoda Red").
     *
     * A row whose code carries no year is KEPT: 1,932 of them, and nothing about
     * such a code says it is versioned at all.
     *
     * A superseded row that STILL HOLDS STOCK is also kept. Zero rows need that
     * today, but the whole point of the sheet is that somebody categorises what
     * is on the shelf, and a filter that hides real stock behind an old code is
     * the one failure here that costs money rather than time.
     */
    select: (records) => {
      const newest = new Map()
      for (const record of records) {
        const version = codeVersion(record.item_code)
        if (!version) continue
        newest.set(version.base, Math.max(newest.get(version.base) ?? 0, version.year))
      }
      return records.filter((record) => {
        const version = codeVersion(record.item_code)
        return !version || version.year === newest.get(version.base) || held(record)
      })
    },
  },
})

/**
 * The two catalogues. Each names its source, its columns and how a row maps —
 * everything else (tabs, dropdown, balance check) is shared, because the two
 * sheets are the same instrument pointed at different rows.
 */
export const DATASETS = Object.freeze({
  prices: {
    source: 'product_prices.json',
    out: 'incoming/product-sheets/product-prices.xlsx',
    allTab: 'All Products',
    noun: 'designs',
    // The key is the D365 GUID, never the code: 18,946 distinct codes over
    // 19,327 designs, and two (range, code) pairs repeat outright.
    header: ['GUID', 'Range', 'Code', 'Description', 'Item Type', 'Suggested Category', 'Category'],
    widths: [38, 24, 22, 38, 16, 18, 14],
    // Every price row is Active and none carries a quantity, so neither filter
    // means anything here. Refusing them beats silently exporting all 19,327.
    filters: [],
    house: (record) => record.range_name || NO_HOUSE,
    sort: (a, b) => String(a.code).localeCompare(String(b.code)),
    row: (record) => [
      record.guid,
      record.range_name,
      record.code,
      record.description,
      record.item_type,
      suggestCategory(record.item_type),
      '',
    ],
  },
  stock: {
    source: 'stock_items.json',
    out: 'incoming/product-sheets/stock-items.xlsx',
    allTab: 'All Stock',
    noun: 'stock items',
    // Item Code IS unique across the 7,611 rows, unlike the price list's code —
    // but the key stays the GUID so both sheets are read back the same way, and
    // so a re-import survives the office correcting a code.
    //
    // On Hand / Available / Status are here to be FILTERED on, not to be edited:
    // 3,455 of the rows are Inactive and only ~370 hold any stock, and a sheet
    // that had silently dropped either would read as "that is all the stock".
    header: [
      'GUID', 'Range', 'Item Code', 'Name', 'Supplier', 'Item Type', 'Measure',
      'On Hand', 'Available', 'Status', 'Suggested Category', 'Category',
    ],
    widths: [38, 22, 22, 40, 26, 16, 10, 10, 11, 10, 18, 14],
    filters: ['--active', '--in-stock', '--latest'],
    house: (record) => record.range_name || NO_HOUSE,
    sort: (a, b) => String(a.item_code).localeCompare(String(b.item_code)),
    row: (record) => [
      record.guid,
      record.range_name,
      record.item_code,
      record.name,
      record.supplier,
      record.item_type,
      record.item_measure,
      quantity(record.stock_on_hand),
      quantity(record.stock_available),
      record.status,
      suggestCategory(record.item_type),
      '',
    ],
  },
})

/** The dropdown on the Category column of a sheet with `count` data rows. A
 *  sheet with no data rows gets none: `L2:L1` is not a range. */
const categoryValidation = (dataset, count) => {
  if (count === 0) return []
  const column = columnLetter(dataset.header.indexOf('Category'))
  return [
    {
      ref: `${column}2:${column}${count + 1}`,
      values: [...CATEGORIES],
      title: 'Not a category',
      message: `Pick one of: ${[...CATEGORIES].join(', ')}. Leave it blank to come back to this row.`,
    },
  ]
}

const sheet = (dataset, name, rows) => ({
  name,
  rows: [[...dataset.header], ...rows],
  widths: [...dataset.widths],
  validations: categoryValidation(dataset, rows.length),
})

/**
 * The workbook's sheets: every row on the All tab, then one tab per house in
 * alphabetical order, each holding that house's rows again.
 *
 * @param {object} dataset  one of DATASETS
 * @param {object[]} records  normalized D365 rows
 * @returns {{name: string, rows: unknown[][]}[]}
 */
export const buildCategorySheets = (dataset, records, { oneSheet = false } = {}) => {
  const sorted = [...records].sort(
    (a, b) => String(dataset.house(a)).localeCompare(String(dataset.house(b))) || dataset.sort(a, b)
  )
  const all = sheet(dataset, dataset.allTab, sorted.map(dataset.row))
  // `--one-sheet` drops the house tabs and keeps the All tab alone. The rows are
  // identical either way — the tabs are a view, so this removes a convenience,
  // never a row, and the balance check below still counts the same total.
  if (oneSheet) return [all]

  const byHouse = new Map()
  for (const record of sorted) {
    const house = dataset.house(record)
    const rows = byHouse.get(house) ?? []
    rows.push(dataset.row(record))
    byHouse.set(house, rows)
  }
  return [all, ...[...byHouse].map(([house, rows]) => sheet(dataset, house, rows))]
}

/** `stock-items.xlsx` + ['active'] -> `stock-items-active.xlsx`. The name says
 *  what is in the file, because two sheets that look identical and hold
 *  different row sets is exactly how the wrong one gets filled in. */
const suffixed = (file, slugs) => {
  if (slugs.length === 0) return file
  const extension = path.extname(file)
  return `${file.slice(0, -extension.length)}-${slugs.join('-')}${extension}`
}

const main = () => {
  const argv = process.argv.slice(2)
  const options = argv.filter((arg) => arg.startsWith('--'))
  const oneSheet = options.includes('--one-sheet')
  const [name = 'prices', inDir = DEFAULT_IN_DIR, outFile] = argv.filter((arg) => !arg.startsWith('--'))
  const dataset = DATASETS[name]
  if (!dataset) {
    throw new Error(`unknown dataset "${name}" — it is one of: ${Object.keys(DATASETS).join(', ')}`)
  }
  const allowed = ['--one-sheet', ...dataset.filters]
  const unknown = options.filter((option) => !allowed.includes(option))
  if (unknown.length > 0) {
    throw new Error(`${name} does not take ${unknown[0]} — its options are: ${allowed.join(' ')}`)
  }
  const filters = dataset.filters.filter((flag) => options.includes(flag)).map((flag) => FILTERS[flag])

  const source = path.join(inDir, dataset.source)
  const everyRecord = JSON.parse(readFileSync(source, 'utf8'))
  if (!Array.isArray(everyRecord) || everyRecord.length === 0) {
    throw new Error(`${source} holds no records — run \`npm run convert:legacy\` first.`)
  }
  // Applied in order, each over what the previous left: `--latest` decides which
  // version is newest among the rows STILL IN PLAY, so `--active --latest` gives
  // the newest ACTIVE version rather than dropping a live row because a newer
  // one was retired. Same reason the filters are listed in a fixed order.
  const records = filters.reduce((kept, filter) => filter.select(kept), everyRecord)
  if (records.length === 0) {
    throw new Error(`no ${dataset.noun} match ${filters.map((f) => f.describe).join(' and ')}`)
  }
  const target = outFile ?? suffixed(dataset.out, filters.map((filter) => filter.slug))

  const sheets = buildCategorySheets(dataset, records, { oneSheet })
  const [all, ...houses] = sheets

  // Rows in = rows out, on BOTH axes, the same balance the colour converter
  // reports. A tab that quietly dropped a row would read as "that is the whole
  // house", and the All tab is the only place anyone would notice.
  const dataRows = (one) => one.rows.length - 1
  const perHouse = houses.reduce((total, one) => total + dataRows(one), 0)
  if (dataRows(all) !== records.length || (houses.length > 0 && perHouse !== records.length)) {
    throw new Error(`read ${records.length} rows but wrote ${dataRows(all)} / ${perHouse}`)
  }

  mkdirSync(path.dirname(path.resolve(target)), { recursive: true })
  writeFileSync(target, buildWorkbook(sheets))

  const suggestedAt = dataset.header.indexOf('Suggested Category')
  const suggested = all.rows.slice(1).filter((row) => row[suggestedAt] !== '').length
  // What each filter LEFT OUT is stated, every time, counted where it actually
  // ran — a filter reports what IT dropped from what reached it, not what it
  // would have dropped alone, or the numbers do not add up to the total.
  let reaching = everyRecord
  for (const filter of filters) {
    const kept = filter.select(reaching)
    console.log(`  filter ${filter.describe}: ${reaching.length - kept.length} of ${reaching.length} rows left out`)
    reaching = kept
  }
  console.log(`${records.length} ${dataset.noun}, ${houses.length} houses -> ${target}`)
  console.log(
    oneSheet
      ? `  one tab (${dataset.allTab}), Category dropdown down the whole column`
      : `  1 tab of everything + ${houses.length} house tabs, Category dropdown on all of them`
  )
  console.log(`  ${suggested} rows carry a suggested category, ${records.length - suggested} do not`)
}

// `file://${process.argv[1]}` is the WRONG spelling of this test and the reason
// is invisible until it bites: import.meta.url is percent-encoded and argv[1] is
// not, so one space anywhere in the checkout path makes the comparison false —
// the script then exits 0 having written nothing and said nothing. src/seed/
// push-legacy.js already had the right form.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
