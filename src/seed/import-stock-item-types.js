#!/usr/bin/env node
/**
 * Land a corrected category workbook on the D365 stock ledger.
 *
 *   node src/seed/import-stock-item-types.js [workbook] [--dry-run] [--email <staff>]
 *   npm run import:item-types -- --dry-run
 *
 * `npm run sheet:stock` writes a workbook, the office corrects the **Item Type**
 * column in Excel, and this reads it back. It is the missing half of the round
 * trip src/products/CLAUDE.md ends with ("Nothing reads a filled workbook back
 * yet"), and the first one was
 * `Copy of stock-items-in-stock-latest-Jenette edit.xlsx` — 381 active,
 * in-stock, current-version items with their item type corrected by hand.
 *
 * WHY THE ITEM TYPE AND NOT THE `Category` COLUMN. The workbook carries both,
 * and the office filled in the one D365 already has a column for: `Category`
 * came back empty on all 381 rows. That is the more useful correction anyway —
 * a category is DERIVED from an item type through CATEGORY_BY_ITEM_TYPE
 * (`scripts/lib/price-template.js`), so correcting the type fixes the category
 * on the CRM's stock rows, in both category workbooks and in anything later
 * derived from either, where a category typed into its own column would fix
 * exactly one screen. `legacy-read.js` does that derivation on the merged row,
 * so a correction written here shows up as a corrected category immediately.
 *
 * WHY IT GOES IN `d365_overrides` AND NOT ONTO THE ROW. `importLegacyEntity`
 * upserts every mapped column on the D365 guid and the import re-runs until
 * cutover, so an UPDATE on `legacy_stock_items.item_type` survives until the
 * next `npm run import:legacy` and then vanishes with no error at all. The
 * correction layer exists for exactly this and `item_type` is a declared,
 * overridable column of the `stock` entity — so this is `patch`, not `extras`
 * (see src/legacy/CLAUDE.md on which lane is which).
 *
 * IT WRITES THROUGH `setLegacyOverrides` RATHER THAN ITS OWN SQL, which is what
 * gets it the per-key `base` snapshot (so `stale_fields` reports it later if
 * D365 moves the type underneath), the cast probe, the empty-override cleanup
 * and the one-statement merge that cannot lose a correction a person is making
 * at the same moment.
 *
 * COMPARED AGAINST THE MERGED VALUE, NOT THE STAGED ONE, which is what makes a
 * second run a no-op. The staging row keeps saying `Accessories` for ever — the
 * override is what says `Towels` — so a script diffing the sheet against
 * `legacy_stock_items` alone would rewrite all 29 corrections on every run,
 * re-snapshot `base` against a value that has not moved, and report work it did
 * not do.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { setLegacyOverrides } from '../legacy/legacy-overrides.js'
import { worksheetGrid } from '../../scripts/lib/xlsx.js'
import { categoryForItemType } from '../../scripts/lib/price-template.js'

/** The first correction the office sent back. Any workbook may be named instead. */
export const DEFAULT_WORKBOOK =
  'incoming/product-sheets/Copy of stock-items-in-stock-latest-Jenette edit.xlsx'

/** The `stock` entity's name in the READ vocabulary — never `stock_items`. */
const ENTITY = 'stock'

/** The one column this reads, and the one it keys on. */
const GUID_HEADER = 'GUID'
const ITEM_TYPE_HEADER = 'Item Type'

/**
 * Row objects from a category workbook's first worksheet.
 *
 * THE FIRST SHEET IS THE `All …` TAB and it carries every row; the house tabs
 * after it are a VIEW of the same rows (`scripts/export-category-sheets.js`), so
 * reading the whole workbook would count each corrected row twice and reading
 * the first sheet loses nothing. A `--one-sheet` export has only that tab.
 *
 * Columns are matched BY NAME, not by position, and only the two that are read
 * are required. Staff sort, hide and delete columns in Excel, and a file that
 * still says which row is which and what it should be called is a file this can
 * honour; a positional contract would refuse it for a column nothing here reads.
 *
 * @param {Buffer} buffer
 * @returns {{ rows: {row: number, guid: string, itemType: string}[], skipped: number }}
 */
export const parseItemTypeSheet = (buffer) => {
  if (!Buffer.isBuffer(buffer)) throw new Error('Expected the workbook as a Buffer.')
  const grid = [...worksheetGrid(buffer)]
  const header = grid.length ? grid[0][1].map((cell) => String(cell ?? '').trim()) : []
  const guidAt = header.indexOf(GUID_HEADER)
  const typeAt = header.indexOf(ITEM_TYPE_HEADER)
  if (guidAt === -1 || typeAt === -1) {
    throw new Error(
      `That is not a category workbook — its first sheet has no "${GUID_HEADER}" and "${ITEM_TYPE_HEADER}" columns. Found: ${header.join(', ') || '(nothing)'}`
    )
  }

  const rows = []
  let skipped = 0
  for (const [number, cells] of grid.slice(1)) {
    const guid = String(cells[guidAt] ?? '').trim()
    const itemType = String(cells[typeAt] ?? '').trim()
    // A blank guid is Excel's trailing rubbish; a blank item type is a row the
    // office did not get to, which is the whole reason the column can be empty.
    // Neither is an error and neither is a correction.
    if (!guid || !itemType) {
      if (guid || itemType) skipped += 1
      continue
    }
    rows.push({ row: number, guid, itemType })
  }
  return { rows, skipped }
}

/**
 * What the ledger says each guid's item type is RIGHT NOW — the staged value
 * with any live correction already applied, which is what the CRM displays and
 * therefore what a new correction has to differ from.
 *
 * `archived_at IS NULL` on the JOIN, never in the WHERE: a suppressed override
 * must not turn this into an inner join and silently drop the staging row (the
 * trap src/legacy/CLAUDE.md records against the merged read).
 */
const currentItemTypes = async (pool, guids) => {
  const { rows } = await pool.query(
    `SELECT s.guid,
            s.item_type AS staged,
            jsonb_exists(o.patch, 'item_type') AS corrected,
            o.patch->>'item_type' AS patched
       FROM legacy_stock_items s
       LEFT JOIN d365_overrides o
         ON o.entity = $2 AND o.guid = s.guid AND o.archived_at IS NULL
      WHERE s.guid = ANY($1::uuid[])`,
    [guids, ENTITY]
  )
  // BOTH values, not just the effective one: the revert branch of planItemTypes
  // needs to know what D365 itself says, or a sheet that agrees with D365 on a
  // corrected row reads as yet another correction and the override never lifts.
  return new Map(
    rows.map((row) => [
      row.guid,
      {
        effective: row.corrected ? row.patched : row.staged,
        staged: row.staged,
        corrected: row.corrected,
      },
    ])
  )
}

/**
 * Decide, per row, what has to be written. Pure — every database read is done,
 * every write is still ahead, so the dry run and the real run take the same
 * decision from the same inputs.
 *
 * Four outcomes, and the third is the one worth naming: a sheet that agrees
 * with D365 on a row somebody previously corrected REVERTS that correction.
 * Anything else would make the workbook a one-way ratchet — the office could
 * introduce a correction through it but never withdraw one, and the file would
 * silently say something different from the screen.
 */
export const planItemTypes = (rows, current) => {
  const plan = { set: [], revert: [], unchanged: [], missing: [] }
  for (const row of rows) {
    const state = current.get(row.guid)
    if (!state) {
      plan.missing.push(row)
    } else if (state.effective === row.itemType) {
      plan.unchanged.push(row)
    } else if (state.corrected && row.itemType === state.staged) {
      plan.revert.push(row)
    } else {
      plan.set.push(row)
    }
  }
  return plan
}

/** How the corrected types fall out as categories, for the run's report. */
const categoryTally = (rows) => {
  const tally = new Map()
  for (const row of rows) {
    const key = categoryForItemType(row.itemType) ?? '(no category for this type)'
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const resolveUserId = async (pool, email) => {
  if (!email) return null
  const { rows } = await pool.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email])
  if (!rows[0]) throw new Error(`No user with the email "${email}".`)
  return rows[0].id
}

/**
 * @param {import('pg').Pool} pool
 * @param {Buffer} buffer  the workbook's bytes
 * @param {{ dryRun?: boolean, userId?: number|null, log?: (line: string) => void }} [options]
 */
export const importStockItemTypes = async (
  pool,
  buffer,
  { dryRun = false, userId = null, log = () => {} } = {}
) => {
  const { rows, skipped } = parseItemTypeSheet(buffer)
  if (rows.length === 0) throw new Error('That workbook carries no rows with both a GUID and an item type.')

  const current = await currentItemTypes(pool, rows.map((row) => row.guid))
  const plan = planItemTypes(rows, current)

  const failed = []
  if (!dryRun) {
    for (const row of plan.set) {
      try {
        await setLegacyOverrides(pool, ENTITY, row.guid, { set: { item_type: row.itemType }, userId })
      } catch (error) {
        failed.push({ row: row.row, guid: row.guid, message: error.message })
      }
    }
    for (const row of plan.revert) {
      try {
        await setLegacyOverrides(pool, ENTITY, row.guid, { revert: ['item_type'], userId })
      } catch (error) {
        failed.push({ row: row.row, guid: row.guid, message: error.message })
      }
    }
  }

  const summary = {
    rows: rows.length,
    skipped,
    corrected: plan.set.length,
    reverted: plan.revert.length,
    unchanged: plan.unchanged.length,
    missing: plan.missing.length,
    failed: failed.length,
  }
  // Rows in = rows accounted for, the balance every pipeline here reports. A
  // count on its own reads as "that was the whole file".
  const accounted = summary.corrected + summary.reverted + summary.unchanged + summary.missing
  if (accounted !== summary.rows) {
    throw new Error(`read ${summary.rows} rows but accounted for ${accounted}`)
  }

  log(`${summary.rows} rows read${skipped ? `, ${skipped} half-filled rows ignored` : ''}`)
  log(`  ${summary.corrected} corrected, ${summary.reverted} reverted to D365, ${summary.unchanged} already right`)
  if (summary.missing) {
    log(`  ${summary.missing} not in the stock ledger — nothing written for them:`)
    for (const row of plan.missing.slice(0, 10)) log(`    row ${row.row}: ${row.guid}`)
    if (plan.missing.length > 10) log(`    … and ${plan.missing.length - 10} more`)
  }
  for (const [category, count] of categoryTally(rows)) log(`  ${String(count).padStart(4)}  ${category}`)
  for (const failure of failed) log(`  row ${failure.row} (${failure.guid}): ${failure.message}`)
  if (dryRun) log('  --dry-run: nothing was written')

  return { summary, plan, failed }
}

const main = async () => {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const emailAt = argv.indexOf('--email')
  const email = emailAt === -1 ? null : argv[emailAt + 1]
  const positional = argv.filter(
    (arg, index) => !arg.startsWith('--') && index !== emailAt + 1
  )
  const file = positional[0] ?? DEFAULT_WORKBOOK

  const pool = createPool(loadConfig().databaseUrl)
  try {
    const userId = await resolveUserId(pool, email)
    const { failed } = await importStockItemTypes(pool, readFileSync(file), { dryRun, userId, log: console.log })
    if (failed.length) process.exitCode = 1
  } finally {
    await pool.end()
  }
}

// `pathToFileURL`, never `file://${process.argv[1]}`: import.meta.url is
// percent-encoded and argv[1] is not, so one space in the checkout path makes
// the comparison false and the script exits 0 having done nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
