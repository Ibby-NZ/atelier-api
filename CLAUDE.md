# atelier-api

Fastify + Postgres API. Plain JavaScript, ESM, no TypeScript.

## Conventions

- `src/config.js` — `loadConfig(env)` validates env vars, throws with clear message; server exits 1 on failure. Add new env vars here + `.env.example`.
- `src/db.js` — `createPool(databaseUrl)` returns pg Pool. Inject the pool into `buildApp({ pool })`; never import a global pool (keeps tests isolated).
- `src/app.js` — `buildApp()` builds the Fastify instance without listening. Tests use `app.inject()` (no port binding needed).
- `src/server.js` — only entry point that listens/exits.
- Config objects frozen (`Object.freeze`); immutable updates house style.

## Migrations

- `migrate:create` emits a CommonJS template (`exports.up`) — rewrite to ESM (`export const up/down`) because this package is `"type": "module"`.
- Tests run migrations themselves via the programmatic runner: `import runner from 'node-pg-migrate'` with `{ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} }`. Runner returns the array of applied migrations — empty array proves a re-run is a no-op.
- Schema: one `inventory` row per colourway (`colourway_id` unique). Check constraints: `products.product_type IN ('fabric','finished_good')`, `inventory.unit IN ('metres','units')`. Upsert targets for the seed: `brands.slug`, `products.slug`, `colourways.sku`, `collections (brand_id, slug)` — all unique.

## Commands

- `npm run migrate` — node-pg-migrate up (reads `DATABASE_URL` from `.env` via dotenv auto-load)
- `npm run migrate:create <name>` — new migration in `migrations/`, plain JS
- `npm run lint` — ESLint 9 flat config (`eslint.config.js`)
- `npm test` — vitest; tests hit real local Postgres (`atelier_dev`), need `.env` present

## Environment

- Requires `atelier-api/.env` with `DATABASE_URL=postgresql://localhost:5432/atelier_dev` (gitignored; see `.env.example`).
- Postgres 14 via Homebrew, database `atelier_dev` already exists.
- Tests fail without a running Postgres — that is expected, not a mock gap.
