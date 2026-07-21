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

## Auth

- Sessions are **stateless signed cookies**: cookie `atelier_session` holds the user id, signed by `@fastify/cookie` with `COOKIE_SECRET` (required env var, 32+ chars; `buildApp({ pool, cookieSecret })` throws without it). No sessions table — logout only clears the client cookie.
- `src/auth/session.js` — `setSessionCookie(reply, userId)` / `clearSessionCookie(reply)` / `readSessionUserId(request)` (returns user id or null; use this for US-006 middleware). Cookie flags: HttpOnly, Secure, SameSite=Lax, path=/, 30-day maxAge.
- `src/auth/passwords.js` — argon2id via `hashPassword`/`verifyPassword` (never throws on malformed hash, returns false). `getDummyHash()` is verified against for unknown emails so login timing doesn't enumerate accounts.
- Rate limiting: `@fastify/rate-limit` registered `global: false`; routes opt in via `config: { rateLimit: { max, timeWindow } }`. Login AND register share 10 per 15 min per IP (register is limited because each attempt runs a memory-hard argon2 hash and 409s enumerate emails). The limiter store is per app instance and per route — tests that spend attempts need their own `buildApp()`.
- Fastify's bundled Ajv has **no `format: 'email'`** — body schemas use `EMAIL_PATTERN` regex instead. Schema violations return 400 (Fastify default), not 422.
- Responses use snake_case fields matching DB columns; `password_hash` is never selected into a response — always select via `PUBLIC_USER_COLUMNS` from `src/auth/user-columns.js` (single source of truth, do not redefine locally).
- Guards (`src/auth/guards.js`): `buildApp` decorates `app.guards = createGuards(pool)`; protect routes with `{ preHandler: app.guards.requireAuth }` or `app.guards.requireRole('trade'|'backoffice'|'director'|'customer')`. `requireAuth` loads the user from DB per request and sets `request.user`; 401 when no/invalid session or user deleted. `requireRole` returns 403; unknown role name throws at registration time. Role semantics: unapproved trade collapses to `customer` (`effectiveRole`), `director` passes `backoffice` checks, `requireRole('trade')` is approved-trade ONLY (backoffice/director do NOT get trade capability — deliberate, revisit if staff need trade-pricing views).
- `POST /auth/trade-application` = register with `role='trade'` (`trade_approved` stays false via DB default); same rate limit bucket rules as register. No endpoint sets `trade_approved=true` yet — back-office approval endpoint comes later; tests flip it with direct SQL.
- Deployment note (from security review, deferred): set Fastify `trustProxy` when behind a proxy or per-IP rate limiting collapses; consider @fastify/helmet and account-keyed login backoff.

## Catalogue (public)

- `GET /catalogue/products` (`src/routes/catalogue.js` + `src/catalogue/products.js`) — anonymous product list, `show_on_website = true` only, paginated (`page`, `limit`; defaults 1/20, max 100). Response: `{ products: [...], meta: { total, page, limit } }`.
- Filters are exact-match strings whitelisted in `FILTER_COLUMNS` (`application`, `composition`, `width`, `price_band`, `lead_time`, `product_type`) plus `brand` (matches `brands.slug`). Filter *names* map to trusted columns; filter *values* always go through parameterized placeholders — never interpolate a value into SQL. Unknown query params are simply ignored (the whitelist controls what filters), not rejected.
- Pricing (FR-3), enforced in `toPublicProduct`: international brands (`is_international = true`) get `price_hidden: true` and **no** `retail_price_cents` field; domestic brands get `retail_price_cents` only when non-null, `price_hidden: false`. No trade-price field exists on this endpoint — trade pricing is US-008 (product detail), gated on approved-trade.
- Fastify querystring validation with `additionalProperties: false` does NOT reject unknown params here (extra keys pass through), but `enum`/type constraints (e.g. `product_type`) DO 400. Rely on the code whitelist for filter safety, not on schema strictness for unknown keys.
- `GET /catalogue/products/:slug` (`src/catalogue/product-detail.js`) — public product detail, `show_on_website = true` only (else 404). Response `{ product }`: list fields + `hi_res_asset_url` + `colourways: [{ name, sku, hex_tones, image_url, in_stock }]`. `in_stock = qty_available - qty_reserved > 0`; a colourway with **no** inventory row (LEFT JOIN → nulls) is out of stock. pg returns `numeric` columns as strings — coerce with `Number()` before arithmetic.
- **Trade pricing** (`trade_price_cents`, integer NZD cents on `products`): added by the `1784605289852_trade-price-cents` migration; precomputed at seed for **fabrics only** from `atelier-app/src/data/pricing.js` `tradeUnit(design)` (`Math.round(unit * 100)`); finished goods stay null. Detail endpoint reveals it **only** to approved trade users (`effectiveRole(user) === 'trade'`), never to anonymous/customer/backoffice — the list endpoint never carries it at all.
- Optional-auth pattern for public routes that show extra fields to logged-in users: `app.guards.loadOptionalUser(request)` returns the user or null and never blocks (unlike `requireAuth`). Route derives `includeTrade` from it and passes it into the read model; the read model is the single gate that adds the field.
- `GET /catalogue/brands` → `{ brands: [{ slug, name, country, currency, is_international, story }] }` (all brands, alpha). `GET /catalogue/brands/:slug` → `{ brand: { ...brand, collections: [{ slug, name }] } }`, 404 if unknown (`src/catalogue/brands.js`).

## Shipping

- `GET /shipping/quote?zone=&qty=` (`src/routes/shipping.js` + `src/shipping/rates.js`) — public flat-rate quote. `getShippingQuote` picks the highest tier whose `threshold_qty` floor is `<= qty` for the zone. Response `{ zone, qty, threshold_qty, rate_cents }`. Unknown zone (no rows) → 400 with a clear message; missing/invalid `zone`/`qty` → 400 by schema (Fastify coerces the querystring `qty` to a number). Boundary rule: at `qty == threshold` the higher tier applies (`<=`).
- `PUT /admin/shipping-rates` (backoffice) — body `{ rates: [{ zone, threshold_qty, rate_cents }] }`; `upsertShippingRates` upserts on `(zone, threshold_qty)` in one transaction (edit rate or add a tier without redeploy) and returns the full `{ rates }` list. Note: seed inserts rates `DO NOTHING`, so admin edits here are the mutation path and survive reseeds.

## Commands

- `npm run migrate` — node-pg-migrate up (reads `DATABASE_URL` from `.env` via dotenv auto-load)
- `npm run migrate:create <name>` — new migration in `migrations/`, plain JS
- `npm run seed` — idempotent catalogue + shipping-rate import (needs migrations applied)
- `npm run lint` — ESLint 9 flat config (`eslint.config.js`)
- `npm test` — vitest; tests hit real local Postgres (`atelier_dev`), need `.env` present

## Environment

- Requires `atelier-api/.env` with `DATABASE_URL=postgresql://localhost:5432/atelier_dev` and `COOKIE_SECRET` (32+ chars, `openssl rand -hex 32`) — gitignored; see `.env.example`.
- Postgres 14 via Homebrew, database `atelier_dev` already exists.
- Tests fail without a running Postgres — that is expected, not a mock gap.
