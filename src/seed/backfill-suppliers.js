/**
 * CLI entry for `npm run backfill:suppliers`. Requires migrations applied and
 * DATABASE_URL set; run it AFTER `npm run import:pricing`, which is where the
 * 40 distinct free-text supplier names come from — on an empty rate ledger the
 * backfill can only see the 9 houses in the vendored office snapshot.
 *
 * Safe to re-run: every write is guarded so a second pass touches no rows.
 * What it cannot resolve it prints rather than guesses, so the tail of this
 * output is a worklist, not a warning to scroll past.
 */
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { backfillSuppliers } from '../suppliers/backfill.js'

// One line per unresolved thing, so the report reads as work rather than noise.
const REPORT_LINES = [
  ['unmatchedPriceListSuppliers', 'price-list names with no usable slug', (r) => `${r.supplier} (${r.items} items) — ${r.reason}`],
  ['slugConflicts', 'name conflicts (slug already taken)', (r) => `${r.supplier} → ${r.slug ?? 'unsluggable'}${r.held_by ? ` held by ${r.held_by}` : ''}`],
  ['currencyConflicts', 'currency disagreements (price list wins)', (r) => `${r.supplier}: rates say ${r.price_list}, snapshot says ${r.snapshot}`],
  ['ambiguousCurrencies', 'suppliers quoting several currencies', (r) => `${r.supplier}: ${r.currencies.join(', ')}`],
  ['unmatchedSnapshotSuppliers', 'snapshot houses with no rates under that spelling', (r) => r],
  ['unmatchedAliasTargets', 'aliases whose supplier is in neither source', (r) => `${r.alias} → ${r.supplier}`],
  ['unmatchedBrands', 'snapshot brands that are not catalogued', (r) => `${r.supplier} → ${r.brand}`],
  ['brandsLinkedElsewhere', 'houses already linked (left alone)', (r) => `${r.brand} (${r.supplier})`],
  ['tierSetsWithoutFallback', 'tier sets with no catch-all', (r) => `${r.supplier} → ${r.brand}`],
  ['invalidTerms', 'terms the schema would refuse', (r) => `${r.supplier} → ${r.brand}: ${r.reason}`],
  ['priceListSuppliersWithoutSnapshot', 'price-list names with no office record', (r) => r],
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
    console.error(`atelier-api supplier backfill failed: ${error.message}`)
    process.exit(1)
  }

  const pool = createPool(config.databaseUrl)
  try {
    const summary = await backfillSuppliers(pool)
    console.log(
      `Supplier backfill complete — suppliers: ${summary.suppliers.created} created, ` +
        `${summary.suppliers.enriched} enriched (${summary.suppliers.planned} planned); ` +
        `aliases: ${summary.aliases}; price-list items linked: ${summary.priceListItems}; ` +
        `houses linked: ${summary.brands}; brand terms: ${summary.terms} (${summary.tiers} tiers)`
    )
    printReports(summary.reports)
  } catch (error) {
    console.error(`atelier-api supplier backfill failed: ${error.message}`)
    console.error('Have migrations run? Try: npm run migrate. Load the rates first: npm run import:pricing')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main()
