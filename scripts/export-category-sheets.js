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
//   node scripts/export-category-sheets.js [prices|stock] [normalized-dir] [out-file]

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

const main = () => {
  const argv = process.argv.slice(2)
  const oneSheet = argv.includes('--one-sheet')
  const unknown = argv.filter((arg) => arg.startsWith('--') && arg !== '--one-sheet')
  if (unknown.length > 0) {
    throw new Error(`unknown option ${unknown[0]} — the only one is --one-sheet`)
  }
  const [name = 'prices', inDir = DEFAULT_IN_DIR, outFile] = argv.filter((arg) => !arg.startsWith('--'))
  const dataset = DATASETS[name]
  if (!dataset) {
    throw new Error(`unknown dataset "${name}" — it is one of: ${Object.keys(DATASETS).join(', ')}`)
  }
  const target = outFile ?? dataset.out
  const source = path.join(inDir, dataset.source)
  const records = JSON.parse(readFileSync(source, 'utf8'))
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${source} holds no records — run \`npm run convert:legacy\` first.`)
  }

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
