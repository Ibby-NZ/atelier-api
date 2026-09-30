/**
 * CLI entry for `npm run backfill:pricing-parameters [-- --dry-run] [-- --overwrite]`.
 * Requires migrations applied, DATABASE_URL set, the Dynamics tracking-option
 * export imported and `npm run backfill:suppliers` run first (a house's
 * discount lands on its terms only once the house is linked to the supplier
 * that invoices it).
 *
 * Safe to re-run: by default it fills only what is blank and never overwrites
 * a saved value — every disagreement is listed as "kept". `--overwrite` lets
 * the export replace them (freight as a new dated rate); `--dry-run` prints the
 * plan and writes nothing. The same fill runs from the CRM's Houses screen as
 * an upload of the export (POST /admin/pricing/houses/import/*). The tail is a
 * worklist.
 */
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { backfillPricingParameters } from '../pricing/parameters-backfill.js'

const REPORT_LINES = [
  ['rangesWithoutBrand', 'Dynamics ranges with no live house (nothing to hang the parameters on)', (r) => `${r.range}${r.supplier ? ` (${r.supplier})` : ''}`],
  ['brandsWithSeveralRanges', 'houses named by more than one range (first kept)', (r) => `${r.brand}: kept ${r.kept}, skipped ${r.skipped}`],
  ['brandsWithoutSupplier', 'houses with no supplier link — discount not written (run backfill:suppliers, or link in the CRM)', (r) => `${r.brand} (range ${r.range})`],
  ['termsAlreadyOnFile', 'houses on a discount chain or tiers (left alone)', (r) => `${r.brand} (range ${r.range})`],
  ['freightDatedToday', 'freight not replaced — the house already has a rate dated today', (r) => `${r.brand}: $${r.current} kept, export says $${r.rate}`],
  ['inactiveRanges', 'inactive ranges (skipped)', (r) => `${r.range} (${r.status})`],
]

const printReports = (reports) => {
  for (const [key, title, format] of REPORT_LINES) {
    const rows = reports[key] ?? []
    if (rows.length === 0) continue
    console.log(`\n${title} (${rows.length}):`)
    for (const row of rows) console.log(`  - ${format(row)}`)
  }
}

const printKept = (changes) => {
  const kept = changes.filter((line) => line.kind === 'kept')
  if (kept.length === 0) return
  console.log(`\nsaved values the export disagrees with — kept (re-run with --overwrite to replace) (${kept.length}):`)
  for (const line of kept) console.log(`  - ${line.brand}: ${line.field} ${line.from ?? 'blank'} -> ${line.to}`)
}

const main = async () => {
  const args = new Set(process.argv.slice(2))
  const overwrite = args.has('--overwrite')
  const dryRun = args.has('--dry-run')

  let config
  try {
    config = loadConfig()
  } catch (error) {
    console.error(`atelier-api pricing-parameter backfill failed: ${error.message}`)
    process.exit(1)
  }

  const pool = createPool(config.databaseUrl)
  try {
    const summary = await backfillPricingParameters(pool, { overwrite, dryRun })
    console.log(
      `Pricing-parameter backfill ${dryRun ? 'dry run — nothing written' : 'complete'}${overwrite ? ' (overwrite)' : ''} — ` +
        `${summary.ranges} Dynamics ranges read, ${summary.houses_matched} houses matched; ` +
        `values to fill: ${summary.values_filled}, to replace: ${summary.values_replaced}, kept: ${summary.values_kept}`
    )
    if (!dryRun) {
      console.log(
        `  parameter sets: ${summary.parameters_inserted} created, ${summary.parameters_filled} filled, ` +
          `${summary.parameters_replaced} replaced; discounts: ${summary.terms_inserted} written, ` +
          `${summary.terms_updated} replaced; freight rates appended: ${summary.freight_inserted}`
      )
    }
    printKept(summary.changes)
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
