/**
 * CLI entry for `npm run seed`. Requires migrations applied and DATABASE_URL set.
 */
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { runSeed } from './seed.js'

const main = async () => {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    console.error(`atelier-api seed failed: ${error.message}`)
    process.exit(1)
  }

  const pool = createPool(config.databaseUrl)
  try {
    const summary = await runSeed(pool)
    console.log(
      `Seed complete — brands: ${summary.brands}, collections: ${summary.collections}, ` +
        `products: ${summary.products}, colourways: ${summary.colourways}, ` +
        `shipping rates: ${summary.shippingRates}`
    )
  } catch (error) {
    console.error(`atelier-api seed failed: ${error.message}`)
    console.error('Have migrations run? Try: npm run migrate')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main()
