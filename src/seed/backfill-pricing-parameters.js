/**
 * CLI entry for `npm run backfill:pricing-parameters`. Requires migrations
 * applied, DATABASE_URL set, the Dynamics tracking-option export imported and
 * `npm run backfill:suppliers` run first (a house's discount lands on its terms
 * only once the house is linked to the supplier that invoices it).
 *
 * Safe to re-run: fills only what is NULL, never overwrites a saved parameter,
 * never touches a house that already has terms. The tail is a worklist.
 */
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { backfillPricingParameters } from '../pricing/parameters-backfill.js'

const REPORT_LINES = [
  ['rangesWithoutBrand', 'Dynamics ranges with no live house (nothing to hang the parameters on)', (r) => `${r.range}${r.supplier ? ` (${r.supplier})` : ''}`],
  ['brandsWithSeveralRanges', 'houses named by more than one range (first kept)', (r) => `${r.brand}: kept ${r.kept}, skipped ${r.skipped}`],
  ['brandsWithoutSupplier', 'houses with no supplier link — discount not written (run backfill:suppliers, or link in the CRM)', (r) => `${r.brand} (range ${r.range})`],
  ['termsAlreadyOnFile', 'houses whose terms already exist (left alone)', (r) => `${r.brand} (range ${r.range})`],
]

const printReports = (reports) => {
  for (const [key, title, format] of REPORT_LINES) {
    const rows = reports[key] ?? []
    if (rows.length === 0) continue
    console.log(`\n${title} (${rows.length}):`)
    for (const row of rows) console.log(`  - ${format(row)}`)
  }
}

const main = async () => {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    console.error(`atelier-api pricing-parameter backfill failed: ${error.message}`)
    process.exit(1)
  }

  const pool = createPool(config.databaseUrl)
  try {
    const summary = await backfillPricingParameters(pool)
    console.log(
      `Pricing-parameter backfill complete — ${summary.ranges} Dynamics ranges read; ` +
        `house parameter sets: ${summary.parameters_inserted} created, ${summary.parameters_filled} filled; ` +
        `house discounts written to terms: ${summary.terms_inserted}`
    )
    printReports(summary.reports)
  } catch (error) {
    console.error(`atelier-api pricing-parameter backfill failed: ${error.message}`)
    console.error('Have migrations run? Try: npm run migrate. Import the Dynamics export and run backfill:suppliers first.')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main()
