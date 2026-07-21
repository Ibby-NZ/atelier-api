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
- `vitest.config.js` sets `fileParallelism: false` — the runner takes a Postgres advisory lock, so parallel test files throw "Another migration is already running". Keep it serialized.
- Schema: one `inventory` row per colourway (`colourway_id` unique). Check constraints: `products.product_type IN ('fabric','finished_good')`, `inventory.unit IN ('metres','units')`. Upsert targets for the seed: `brands.slug`, `products.slug`, `colourways.sku`, `collections (brand_id, slug)` — all unique.
- Commerce schema: `users.role IN ('customer','trade','backoffice','director')` (default `customer`), `orders.kind IN ('checkout','order_request','backorder_request')`, `orders.status IN ('requested','confirmed','paid','shipped','declined')`. `order_lines.colourway_id` is `ON DELETE RESTRICT` (commerce records survive catalogue cleanup); `orders.user_id` is `SET NULL` (guest orders keep `guest_email`). Shipping seed upsert key: `shipping_rates (zone, threshold_qty)` unique.

## Seed

- `npm run seed` (`src/seed/run.js`) — idempotent import of the atelier-app catalogue. `src/seed/catalogue-data.js` is a pure transform layer (no DB) importing `../../../atelier-app/src/data/{realCatalogue,atelier,suppliers}.js` directly (relative ESM path across packages works; those modules are Node-safe pure data). `src/seed/seed.js` `runSeed(pool)` does the upserts in one transaction.
- Upsert semantics: brands/collections/products/colourways use `ON CONFLICT … DO UPDATE`; **inventory and shipping_rates use `DO NOTHING`** — they become live operational data after first seed (reservations, admin-edited rates) and a reseed must not clobber them.
- Products carry no SKU; the SKU lives on `colourways` (finished goods get one colourway carrying the product SKU). Fabric product slug = slugify(`${brand} ${design}`), e.g. `pierre-frey-atlas`.
- House brand `Atelier Textiles NZ` (slug `atelier-textiles-nz`) is the only `is_international=false` brand; only its finished goods have `retail_price_cents` (indicative values in `HOUSE_RETAIL_PRICE_CENTS`). All fabrics + international finished goods have null retail price (FR-3).
- `hex_tones` jsonb: pass `JSON.stringify(array)` as the query param — pg maps raw JS arrays to Postgres arrays, not jsonb.
- Shipping tiers: `threshold_qty` is the tier floor (0 and 20 per zone); a quote picks the highest threshold <= qty.

## Commands

- `npm run migrate` — node-pg-migrate up (reads `DATABASE_URL` from `.env` via dotenv auto-load)
- `npm run migrate:create <name>` — new migration in `migrations/`, plain JS
- `npm run seed` — idempotent catalogue + shipping-rate import (needs migrations applied)
- `npm run lint` — ESLint 9 flat config (`eslint.config.js`)
- `npm test` — vitest; tests hit real local Postgres (`atelier_dev`), need `.env` present

## Environment

- Requires `atelier-api/.env` with `DATABASE_URL=postgresql://localhost:5432/atelier_dev` (gitignored; see `.env.example`).
- Postgres 14 via Homebrew, database `atelier_dev` already exists.
- Tests fail without a running Postgres — that is expected, not a mock gap.
