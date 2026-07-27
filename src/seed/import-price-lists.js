/**
 * CLI entry for `npm run import:pricing`. Requires migrations applied and
 * DATABASE_URL set; reads the universal file written by
 * scripts/convert-price-lists.py.
 */
import { readFile } from 'node:fs/promises'
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { importPriceLists } from './price-lists.js'

const DATA_URL = new URL('./data/price-lists.json', import.meta.url)

const main = async () => {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    console.error(`atelier-api price-list import failed: ${error.message}`)
    process.exit(1)
  }

  const pool = createPool(config.databaseUrl)
  try {
    const items = JSON.parse(await readFile(DATA_URL, 'utf8'))
    const summary = await importPriceLists(pool, items)
    console.log(`Price-list import complete — items: ${summary.items}, suppliers: ${summary.suppliers}`)
  } catch (error) {
    console.error(`atelier-api price-list import failed: ${error.message}`)
    console.error('Have migrations run? Try: npm run migrate. Regenerate data: npm run convert:pricing')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main()
