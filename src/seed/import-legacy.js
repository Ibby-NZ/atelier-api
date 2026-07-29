/**
 * CLI entry for `npm run import:legacy`. Requires migrations applied and
 * DATABASE_URL set; reads the normalised files written by
 * scripts/convert-d365-exports.py.
 *
 * The normalised files live under incoming/ (gitignored) rather than
 * src/seed/data/ because the account and sales-order exports are client PII.
 * Pass a directory argument to point somewhere else.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { LEGACY_TABLES, importLegacyEntity } from './legacy-import.js'

const DEFAULT_DIR = fileURLToPath(new URL('../../incoming/data-exports/normalized/', import.meta.url))

// Product prices and stock items are the catalogue spine; accounts and orders
// reference them conceptually, so import in a stable, dependency-ish order.
const ORDER = ['product_prices', 'stock_items', 'accounts', 'sales_orders']

const main = async () => {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    console.error(`atelier-api legacy import failed: ${error.message}`)
    process.exit(1)
  }

  const dir = process.argv[2] || DEFAULT_DIR
  const pool = createPool(config.databaseUrl)
  try {
    const files = new Set(await readdir(dir))
    const entities = ORDER.filter((entity) => files.has(`${entity}.json`))
    const missing = Object.keys(LEGACY_TABLES).filter((entity) => !entities.includes(entity))
    if (entities.length === 0) {
      throw new Error(`no normalised exports in ${dir} — run: npm run convert:legacy`)
    }

    for (const entity of entities) {
      const records = JSON.parse(await readFile(join(dir, `${entity}.json`), 'utf8'))
      const summary = await importLegacyEntity(pool, entity, records)
      console.log(`  ${summary.table}: ${summary.records} records`)
    }
    if (missing.length > 0) {
      console.log(`Not exported yet: ${missing.join(', ')}`)
    }
    console.log('Legacy D365 staging import complete.')
  } catch (error) {
    console.error(`atelier-api legacy import failed: ${error.message}`)
    console.error('Have migrations run? Try: npm run migrate. Regenerate data: npm run convert:legacy')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main()
