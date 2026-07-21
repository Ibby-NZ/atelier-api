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

## Checkout (Stripe)

- `POST /checkout/session` (`src/routes/checkout.js` + `src/checkout/checkout.js`) — B2C card checkout for finished goods (FR-4). Body `{ lines: [{ sku, qty }], zone }`; **no prices accepted from the client** (`additionalProperties: false` on line items). `validateCheckoutLines` resolves each SKU server-side and rejects with **422**: fabric products (`product_type = 'fabric'`), goods with `retail_price_cents = null`, hidden/unknown SKUs, and insufficient stock (`qty_available - qty_reserved < qty`, pg-numeric strings coerced). Unknown shipping zone → **400**.
- Stripe line items use inline `price_data` (currency/`product_data.name`/`unit_amount` from the DB), never pre-created Price IDs. A shipping line item is appended from `getShippingQuote(zone, totalQty)`. The cart (`[{ sku, qty }]` only) + zone + shipping_cents go into `session.metadata` so the **US-011 webhook** rebuilds the order — this endpoint creates **no** order row. `client_reference_id`/`customer_email` are set when logged in (`loadOptionalUser` — guests allowed). Returns `{ url, session_id }`.
- **Stripe is injected**, not imported globally: `buildApp({ ..., stripe, storeBaseUrl })`. `src/server.js` builds the real client from `STRIPE_SECRET_KEY` (optional env — checkout returns **503** when unset, so the rest of the API boots without it). Tests pass a stub whose `checkout.sessions.create` records params — no SDK/network. Secret comes from env only; `test/checkout.test.js` greps `src/` for an `sk_(live|test)_` literal and asserts none (the pattern is built from fragments so it never self-matches).
- Errors are thrown as `Object.assign(new Error(msg), { statusCode })`; Fastify serializes `{ statusCode, error, message }`, so handlers stay thin.

## Webhooks (Stripe)

- `POST /webhooks/stripe` (`src/routes/webhooks.js` + `src/webhooks/stripe-webhook.js`) — records completed payments as paid orders (FR-4). Verifies the signature with `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)`; invalid signature → **400**. On `checkout.session.completed`: inserts an order (`kind='checkout'`, `status='paid'`) with lines and decrements `inventory.qty_available`. Other event types are recorded but create no order. Returns `{ received: true, duplicate }`.
- **Raw body**: signature verification needs the exact bytes, so the webhook plugin registers its own `addContentTypeParser('application/json', { parseAs: 'buffer' }, …)`. Content-type parsers are **encapsulated** — this only affects the webhook plugin; every other route keeps normal JSON parsing. `request.body` is a Buffer here.
- **Idempotency**: the `webhook_events` table (migration `1784606400000`, PK `event_id`) is the ledger. `processStripeEvent` opens one transaction, claims the event with `INSERT … ON CONFLICT (event_id) DO NOTHING`; `rowCount === 0` → replay → rollback and return `{ duplicate: true }` (creates nothing). Order creation + inventory decrement + ledger claim all commit together.
- **Money is re-resolved server-side**, never read from the payload: the cart (`[{ sku, qty }]`) lives in `session.metadata.cart`, zone in `metadata.zone`, shipping in `metadata.shipping_cents` (all stashed by US-010 checkout). Line prices come from a fresh DB lookup by SKU (`retail_price_cents`). `order_number = WEB-${session.id}` (stable per session). `user_id` from `client_reference_id` (int), else `guest_email` from `customer_details.email`/`customer_email`.
- **Config**: `STRIPE_WEBHOOK_SECRET` (optional env → `config.stripeWebhookSecret`) injected as `buildApp({ ..., stripeWebhookSecret })`. Webhook returns **503** when stripe or the secret is unset. Tests inject a stub whose `webhooks.constructEvent` re-parses the raw body into an event when the signature header matches a sentinel, else throws — no SDK/network.

## Order requests (fabric / backorder)

- `POST /orders/request` (`src/routes/orders.js` + `src/orders/order-request.js`) — a customer or guest asks the back office to cut and invoice fabric (FR-5/FR-6). Body `{ lines: [{ sku, qty_metres, cut_requirements? }], contact?: { name, email, phone }, accepted_lead_time? }`. Public (guests allowed via `loadOptionalUser`). Returns **201** `{ order: { id, order_number, kind, status, lines } }`.
- **Two-layer validation**: the body schema is structural only (empty `lines`/missing `sku` → **400**). `qty_metres > 0` and email validity are checked in the handler via `validateOrderRequestInput`, which returns **422** `{ message, errors: [{ field, message }] }` with field paths like `lines[0].qty_metres` / `contact.email`. Guests must supply `contact.email`; logged-in users fall back to their session email (order gets `user_id`, `guest_email` stays null).
- **Availability decides the kind**: for every line, `available = qty_available - qty_reserved` (pg-numeric strings coerced). All lines in stock → `kind='order_request'`, `order_number` `REQ-…`. Any line short → requires `accepted_lead_time=true` (else **422** "accept the quoted lead time"); then `kind='backorder_request'`, `order_number` `BO-…`. Both create `status='requested'`.
- **Reservation**: in one transaction each line increments `inventory.qty_reserved` by `qty_metres` (backorder lines reserve too — committed demand). The colourway row is locked `FOR UPDATE OF c` — the inventory row is the nullable side of the LEFT JOIN and **can't** be locked directly ("FOR UPDATE cannot be applied to the nullable side of an outer join"), so locking the colourway serialises concurrent same-SKU requests. Unknown/hidden SKU → **422**.
- Pricing is deliberately **0** on request lines (`unit_price_cents = 0`); the invoice amount is set manually by the back office at confirmation (US-014), not by the client. `contact` name/phone are stored in `orders.notes`.

## Order history + guest lookup

- `GET /orders/mine` (`src/routes/orders.js` + `src/orders/order-history.js`) — auth (`requireAuth`), returns `{ orders: [...] }` newest first, each with `lines`. Ownership is enforced in SQL (`WHERE user_id = request.user.id`), never in the handler, so one user can never read another's orders.
- `GET /orders/lookup?order_number=&email=` — public guest lookup. Returns `{ order }` only when order number AND email match; email matches either `guest_email` or the placing user's `users.email` (case-insensitive `lower()`). No match → **404** (never a 400/enumeration signal). Both query params required by schema (missing → 400).
- Order shape (`toOrder`): `id, order_number, kind, status, subtotal_cents, shipping_cents, total_cents, shipping_zone, xero_invoice_ref, created_at, lines`. Lines carry `sku, product_name, qty, unit_price_cents, cut_requirements`. Internal columns (`stripe_session_id`, `guest_email`) are not exposed. Lines are batch-loaded for all order ids in one query (`ol.order_id = ANY($1::int[])`) then grouped — no N+1.

## Back-office order management

- `src/routes/admin-orders.js` + `src/orders/admin-orders.js` (US-014, FR-7). All routes `requireRole('backoffice')` (director inherits). Handlers stay thin; the state machine + reservation logic live in the module.
- **Lifecycle** (order-request / backorder kinds): `requested --confirm--> confirmed --mark-paid--> paid --ship--> shipped`; `requested|confirmed --decline--> declined`. Any other transition throws **409** via `requireStatus`. `confirm` stores `xero_invoice_ref` from the body (manual Xero, no API call).
- **Reservation model**: only `RESERVING_KINDS` (`order_request`, `backorder_request`) touch inventory here; `checkout` orders arrived paid + already-decremented and hold no reservation (`reserves(kind)` guards every inventory write). `reservation_state` per order = `held` (requested/confirmed/paid) → `converted` (shipped: `qty_reserved -=`, `qty_available -=`) or `released` (declined: `qty_reserved -=`). `ship`/`decline` update inventory with a single `UPDATE inventory i ... FROM order_lines ol WHERE ol.order_id=$1 AND i.colourway_id=ol.colourway_id` (no per-line loop). A colourway with no inventory row (short backorder) reserved nothing, so the join simply matches nothing.
- **Endpoints**: `GET /admin/orders?status=` (optional enum filter → 400 on unknown), `GET /admin/orders/:id` (404), `PATCH /admin/orders/:id` (body `{ lines: [{ id, qty }] }` — edits qtys, adjusts held reservation by delta; **only** requested/confirmed, else 409), `POST .../confirm|mark-paid|ship|decline`. `:id` is an integer param (Fastify coerces; non-numeric → 400).
- Every mutation runs through `withOrderTxn(pool, id, fn)`: `BEGIN`, `SELECT ... FOR UPDATE` the order (404 if missing), run `fn`, `COMMIT`, then return the fresh order via `getAdminOrder`. Admin order shape exposes internal fields customers don't see (`guest_email`, `notes`, per-line `colourway_id` + `inventory` snapshot + `reserved_qty`).
- **Test gotcha**: register shares a rate-limit bucket (10 / 15 min / IP). Register staff/customer **once** in `beforeAll` and keep them; per-test `beforeEach` cleans only orders + brand fixtures, never users (re-registering each test 429s and yields no cookie). pg `numeric` qty comes back like `'10.00'` — compare with `Number()`, not string equality.

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
