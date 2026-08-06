/**
 * CLI entry for `npm run import:colour`. Requires migrations applied and
 * DATABASE_URL set; reads the normalised file written by
 * scripts/convert-colour-files.js.
 *
 * The default path is under incoming/ (gitignored) rather than src/seed/data/
 * for the same reason the D365 exports are: these are the client's own supplier
 * files, not repo data. Pass a path argument to point somewhere else.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { importColourways } from './colourways-import.js'

const DEFAULT_FILE = fileURLToPath(
  new URL('../../incoming/colour-files/normalized/colourways.json', import.meta.url)
)
// Caps what is PRINTED, never what is counted — the same rule the converter's
// error and clash lists follow.
const MAX_REPORTED = 50

const reportList = (label, entries, line) => {
  if (entries.length === 0) return
  console.error(`${label} (${entries.length}):`)
  for (const entry of entries.slice(0, MAX_REPORTED)) console.error(`  ${line(entry)}`)
  if (entries.length > MAX_REPORTED) console.error(`  ... and ${entries.length - MAX_REPORTED} more`)
}

const report = (summary) => {
  console.log(
    `Colourway import complete — ${summary.rows} row(s) in, ${summary.colourways} colourway(s) `
    + `across ${summary.products} product(s) and ${summary.brands} house(s)`
  )
  console.log(
    `  ${summary.skipped} row(s) not imported, ${summary.duplicates} repeat(s) collapsed, `
    + `${summary.inventoryCreated} stock row(s) created`
  )
  // Every house the files name and the catalogue does not hold. Reported, never
  // created: naming a house is the office's decision and a house created
  // silently is the one outcome nobody can undo.
  reportList(
    'Houses with no catalogue row — their colourways were NOT imported',
    summary.unknownBrands,
    (entry) => `${entry.brand}: ${entry.rows} row(s), first at ${entry.first}`
  )
  reportList(
    'Rows declined',
    summary.skips,
    (entry) => `${entry.reason}: ${entry.rows} row(s), first at ${entry.first}`
  )
  // One SKU is one colourway, so only the first of these reached the catalogue.
  // Both names are printed because nothing has ratified which one it carries.
  reportList(
    'Colour codes carrying two different names — the first was kept',
    summary.conflicts,
    (entry) => `${entry.sku}: "${entry.kept.name}" (${entry.kept.source}) kept, `
      + `"${entry.dropped.name}" (${entry.dropped.source}) dropped`
  )
}

const main = async () => {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    console.error(`atelier-api colourway import failed: ${error.message}`)
    process.exit(1)
  }

  const file = process.argv[2] || DEFAULT_FILE
  const pool = createPool(config.databaseUrl)
  try {
    const rows = JSON.parse(await readFile(file, 'utf8'))
    report(await importColourways(pool, rows))
  } catch (error) {
    console.error(`atelier-api colourway import failed: ${error.message}`)
    console.error('Have migrations run? Try: npm run migrate. Regenerate data: npm run convert:colour')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main()
