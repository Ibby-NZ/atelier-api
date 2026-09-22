/**
 * CLI entry for `npm run migrate` / `migrate:down`. node-pg-migrate's own CLI
 * passes DATABASE_URL to pg without SSL; managed hosts (Vultr) reject that.
 */
import runner from 'node-pg-migrate'
import { loadConfig } from './config.js'
import { pgConnectionConfig } from './db.js'

const direction = process.argv[2] === 'down' ? 'down' : 'up'
const config = loadConfig()

const applied = await runner({
  databaseUrl: pgConnectionConfig(config.databaseUrl),
  dir: 'migrations',
  direction,
  migrationsTable: 'pgmigrations',
})

if (applied.length === 0) {
  console.log('No migrations to run')
} else {
  console.log(`Migrations complete: ${applied.join(', ')}`)
}
