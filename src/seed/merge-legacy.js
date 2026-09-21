/**
 * CLI entry for `npm run merge:legacy [-- --create-houses]`: promote the D365
 * staging tables into the live ones (see src/legacy/merge.js for what moves
 * and what deliberately does not). Requires migrations applied, DATABASE_URL
 * set, and `npm run import:legacy` already run against this database.
 */
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { mergeLegacy } from '../legacy/merge.js'

const MAX_REPORTED = 30

const list = (label, entries, line) => {
  if (entries.length === 0) return
  console.error(`${label} (${entries.length}):`)
  for (const entry of entries.slice(0, MAX_REPORTED)) console.error(`  ${line(entry)}`)
  if (entries.length > MAX_REPORTED) console.error(`  ... and ${entries.length - MAX_REPORTED} more`)
}

const main = async () => {
  const createHouses = process.argv.includes('--create-houses')
  const config = loadConfig()
  const pool = createPool(config.databaseUrl)
  try {
    const s = await mergeLegacy(pool, { createHouses })
    console.log(`Accounts   — ${s.accounts.created} trade account(s) created (${s.accounts.unnamed} unnamed skipped)`)
    console.log(
      `Contacts   — ${s.contacts.created} created; ${s.contacts.filed} filed under an account, `
      + `${s.contacts.unfiled} unfiled (company not a client), ${s.contacts.no_company} with no company`
    )
    console.log(`Reserves   — ${s.reserves.lines} line(s) in ${s.reserves.dockets} docket(s)`)
    list('  declined', s.reserves.declined, (d) => `${d.guid}: ${d.reason}`)
    if (s.housesRaised.length) console.log(`Houses     — raised ${s.housesRaised.length}: ${s.housesRaised.join(', ')}`)
    console.log(
      `Catalogue  — ${s.catalogue.items} stock item(s) → ${s.catalogue.colourways} colourway(s) across `
      + `${s.catalogue.products} product(s); ${s.catalogue.inventoryCreated} stock row(s) created, ${s.catalogue.conflicts} conflict(s), ${s.catalogue.noHouse} item(s) name no range`
    )
    list('  houses not in the catalogue (items skipped)', s.catalogue.unknownBrands, (b) => `${b.brand}: ${b.rows}`)
    list('  skipped', s.catalogue.skips, (k) => `${k.reason}: ${k.rows}`)
    console.log(`Stock      — ${s.stock.matched} item(s) matched a colourway; ${s.stock.stocked} quantity(ies) set, ${s.stock.priced} product price(s) filled`)
    console.log('Legacy merge complete.')
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
