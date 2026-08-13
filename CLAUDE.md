# atelier-api

Fastify + Postgres API. Plain JavaScript, ESM, no TypeScript.

## Conventions

- `src/config.js` — `loadConfig(env)` validates env vars, throws with clear message; server exits 1 on failure. Add new env vars here + `.env.example`.
- `src/db.js` — `createPool(databaseUrl)` returns pg Pool. Inject the pool into `buildApp({ pool })`; never import a global pool (keeps tests isolated).
- `src/app.js` — `buildApp()` builds the Fastify instance without listening. Tests use `app.inject()` (no port binding needed).
- **CORS covers TWO browser apps and must name both origins AND every write method.** `buildApp({ storeBaseUrl, crmBaseUrl })` → `@fastify/cors` with `credentials: true`, an exact-match origin allowlist and an explicit `methods` list. Guarded by `test/cors.test.js`. Three traps, each of which has actually broken the product:
  - **The CRM is a second origin.** Storefront islands fetch browser :4321 → api :3001; the CRM fetches :5273 → api :3001. Only the storefront was allow-listed, so *every* CRM call — including sign-in — was blocked by the browser. `CRM_BASE_URL` (→ `config.crmBaseUrl`) is the second entry.
  - **`methods` MUST be spelled out.** @fastify/cors defaults to `GET,HEAD,POST`, so a `PATCH`/`PUT` is refused at the preflight and **never reaches this server**. Every admin edit is a PATCH and shipping rates are a PUT, so the default silently broke every write in both browser apps — while curl and `app.inject()` (neither of which preflights) kept passing. Any CORS assertion made with `inject` alone is worthless for methods; only a real browser preflight proves it.
  - **The allowlist is closed, never reflected.** `origin: true` (echo whatever asked) plus `credentials: true` would let any site drive the API with a logged-in staff cookie. An unknown origin gets `storeBaseUrl` back, which the browser then rejects.
- `src/server.js` — only entry point that listens/exits.
- Config objects frozen (`Object.freeze`); immutable updates house style.

## Migrations

- `migrate:create` emits a CommonJS template (`exports.up`) — rewrite to ESM (`export const up/down`) because this package is `"type": "module"`.
- **Check the timestamp is free before creating a migration** (`ls migrations | grep <prefix>`): the concurrent August-2026 workstreams collided twice — `1786334400000` (`price-list-template-v2` + `suppliers`) and `1786680000000` (`reporting-finance-access` + `samples-register`). Both are harmless-by-luck: node-pg-migrate breaks a timestamp tie by `localeCompare` on the full filename (deterministic), `pgmigrations` keys on the full name, and each pair touches disjoint tables. **Do NOT "fix" them by renaming** — a migration that has already run is recorded under its filename, so a rename makes every already-migrated database treat it as unrun and re-execute `createTable` into a crash. The pairs stay; new collisions must not.
- Tests run migrations themselves via the programmatic runner: `import runner from 'node-pg-migrate'` with `{ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} }`. Runner returns the array of applied migrations — empty array proves a re-run is a no-op.
- `vitest.config.js` sets `fileParallelism: false` — the runner takes a Postgres advisory lock, so parallel test files throw "Another migration is already running". Keep it serialized.
- Schema: one `inventory` row per colourway (`colourway_id` unique). Check constraints: `products.product_type IN ('fabric','finished_good')`, `inventory.unit IN ('metres','units')`. Upsert targets for the seed: `brands.slug`, `products.slug`, `colourways.sku`, `collections (brand_id, slug)` — all unique.
- Commerce schema: `users.role IN ('customer','trade','backoffice','director')` (default `customer`), `orders.kind IN ('checkout','order_request','backorder_request')`, `orders.status IN ('requested','confirmed','paid','shipped','declined')`. `order_lines.colourway_id` is `ON DELETE RESTRICT` (commerce records survive catalogue cleanup); `orders.user_id` is `SET NULL` (guest orders keep `guest_email`). Shipping seed upsert key: `shipping_rates (zone, threshold_qty)` unique.

## Auth

- Sessions are **stateless signed cookies**: cookie `atelier_session` holds the user id, signed by `@fastify/cookie` with `COOKIE_SECRET` (required env var, 32+ chars; `buildApp({ pool, cookieSecret })` throws without it). No sessions table — logout only clears the client cookie.
- `src/auth/session.js` — `setSessionCookie(reply, userId)` / `clearSessionCookie(reply)` / `readSessionUserId(request)` (returns user id or null; use this for US-006 middleware). Cookie flags: HttpOnly, Secure, SameSite=Lax, path=/, 30-day maxAge.
- `src/auth/passwords.js` — argon2id via `hashPassword`/`verifyPassword` (never throws on malformed hash, returns false). `getDummyHash()` is verified against for unknown emails so login timing doesn't enumerate accounts.
- Rate limiting: `@fastify/rate-limit` registered `global: false`; routes opt in via `config: { rateLimit: { max, timeWindow } }`. Login AND register share 10 per 15 min per IP (register is limited because each attempt runs a memory-hard argon2 hash and 409s enumerate emails). The limiter store is per app instance and per route — tests that spend attempts need their own `buildApp()`.
- Fastify's bundled Ajv has **no `format: 'email'`** — body schemas use `EMAIL_PATTERN` regex instead. Schema violations return 400 (Fastify default), not 422.
- Responses use snake_case fields matching DB columns; `password_hash` is never selected into a response — always select via `PUBLIC_USER_COLUMNS` from `src/auth/user-columns.js` (single source of truth, do not redefine locally).
- Guards (`src/auth/guards.js`): `buildApp` decorates `app.guards = createGuards(pool)`; protect routes with `{ preHandler: app.guards.requireAuth }` or `app.guards.requireRole('trade'|'backoffice'|'director'|'customer')`. `requireAuth` loads the user from DB per request and sets `request.user`; 401 when no/invalid session or user deleted. `requireRole` returns 403; unknown role name throws at registration time. Role semantics: unapproved trade collapses to `customer` (`effectiveRole`), `director` passes `backoffice` checks, `requireRole('trade')` is approved-trade ONLY (backoffice/director do NOT get trade capability — deliberate, revisit if staff need trade-pricing views).
- `POST /auth/trade-application` = register with `role='trade'` (`trade_approved` stays false via DB default) **plus the full atelier.co.nz trade-account form** in a required `application` object (body schema is structural only; `validateTradeApplication` in `src/users/trade-applications.js` returns the field-level 422s with `application.<field>` paths). `submitTradeApplication` creates the user AND the `trade_applications` row in one transaction — a duplicate email (409) leaves no orphan form. Same rate limit bucket rules as register. The form is reviewed in the CRM's Users → Applicants tab (`GET /admin/trade-applications`(`/:id`), backoffice, read-only — `src/routes/admin-trade-applications.js`); each application embeds the applicant's live `user` state via LEFT JOIN because approval state is NEVER stored on the application: `users.trade_approved` stays the single source of truth, flipped only via `PATCH /admin/users/:id { trade_approved: true }`. `trade_applications.user_id` is `ON DELETE SET NULL` (business record survives account removal — test cleanups must delete applications before users or they orphan). Approval is manual and silent: nothing notifies the applicant. **A pending trade account cannot authenticate at all**: the application sets no session cookie, `/auth/login` answers **403** "awaiting review" (checked only AFTER the argon2 verify, so without the right password it stays the generic 401 — no enumeration), and `SESSION_USER_CONDITION` (`src/auth/user-columns.js`, = active AND NOT pending-trade) is what `/auth/me` + `guards.loadSessionUser` filter on, so revoking approval kills a live session exactly like archiving does. Guarded by `test/trade-applications.test.js`; the shared valid-form fixture lives in `test/helpers/trade-application-fixture.js`.
- **`/admin/users` is the account admin the CRM drives** (`src/routes/admin-users.js` + `src/users/admin-users.js`, backoffice-only). `GET` filters by `role`, by `segment` (`clients` = customer+trade, `staff` = backoffice+director — the coarse split the CRM navigates by; passing both intersects), by free-text `q`, and `include_archived`. `PATCH` writes `role`/`trade_approved`/`name`/`email` from a frozen whitelist. **`email` is editable on purpose**: it is what the client signs in with, and a typo taken down over the phone otherwise leaves an account nobody can reach and no way to fix it short of SQL. It is lower-cased in `updateUser` (not the route) because every auth path looks the address up in lower case, and a collision is the same 409 create answers with. Two self-protection guards live in the handlers (they need `request.user`): you cannot change your own `role`, and you cannot archive yourself. **A patch that moves a role off `trade` also clears `trade_approved`** — the flag only means anything on a trade row, so demoting an approved account used to strand a `true` nothing displays, and re-promoting it months later handed back trade pricing AND every trade-only house with no review. Enforced in `updateUser`, not in a screen, so it holds for the CRM, the AdminJS panel and any future caller; an explicit `trade_approved: true` in the same body loses, because the role is the stronger statement and the two together are a contradiction rather than an instruction.
- **Every auth path must exclude archived accounts.** `archived_at` is a soft delete (orders reference the row), so the account is still fully loginable unless the query says otherwise — archiving from the CRM used to leave the session cookie live, let the old password back in, and keep serving trade pricing. `ACTIVE_USER_CONDITION` in `src/auth/user-columns.js` is the single source of truth for the clause; it is applied in exactly three places (`/auth/login`, `/auth/me`, `guards.loadSessionUser` — which covers `requireAuth`, `requireRole` AND `loadOptionalUser`, so an archived trade user drops to anonymous on the public catalogue) plus `src/admin/authenticate.js` for the panel. (`/auth/me` and `loadSessionUser` actually apply `SESSION_USER_CONDITION`, which embeds it and adds the pending-trade exclusion — see the trade-application bullet.) The back-office `src/users/admin-users.js` queries deliberately do NOT use it — staff must be able to list and restore archived rows. Login and panel login **select** `archived_at` rather than filtering in SQL: filtering would return before the argon2 verify and make "archived" measurably faster than "wrong password". Both answer with the same generic 401. Guarded by `test/auth.test.js`, `test/guards.test.js`, `test/admin-panel.test.js`.
- Behind a reverse proxy set `TRUST_PROXY` (→ `config.trustProxy` → Fastify `trustProxy`) or per-IP rate limiting collapses to one shared bucket. Use the proxy address form (`TRUST_PROXY=127.0.0.1` for same-host nginx), not `true` — `true` trusts client-supplied `X-Forwarded-For` wholesale. Still deferred from the security review: @fastify/helmet, account-keyed login backoff.

## Commands

- `npm run migrate` — node-pg-migrate up (reads `DATABASE_URL` from `.env` via dotenv auto-load)
- `npm run migrate:create <name>` — new migration in `migrations/`, plain JS
- `npm run seed` — idempotent catalogue + shipping-rate import (needs migrations applied)
- `npm run push:legacy -- --api <url> --email <director>` — pushes the normalised D365 exports to a REMOTE API over HTTPS (`ATELIER_API_PASSWORD` in the environment). For servers with no shell; the local equivalent is `npm run import:legacy`.
- `npm run sheet:prices` / `npm run sheet:stock` — the category workbooks for the two D365 catalogues: 19,327 price rows (`product-prices.xlsx`) and 7,611 stock items (`stock-items.xlsx`), both into `incoming/product-sheets/`. Needs `npm run convert:legacy` first; main checkout only, like every `incoming/` step.
- `npm run lint` — ESLint 9 flat config (`eslint.config.js`)
- `npm test` — vitest; tests hit real local Postgres (`atelier_dev`), need `.env` present

## Environment

- Requires `atelier-api/.env` with `DATABASE_URL=postgresql://localhost:5432/atelier_dev` and `COOKIE_SECRET` (32+ chars, `openssl rand -hex 32`) — gitignored; see `.env.example`.
- Postgres 14 via Homebrew, database `atelier_dev` already exists.
- Tests fail without a running Postgres — that is expected, not a mock gap.
- `CRM_BASE_URL` (default `http://localhost:5273`) is CORS-only but production-critical: wrong or unset behind a real domain and every CRM screen is blocked by the browser, sign-in included. `STORE_BASE_URL` does double duty as the Stripe redirect target and the storefront's CORS origin.
- Three apps, three ports, all three needed for a full local loop: api `3001`, storefront `4321`, CRM `5273`. `npm run seed:staff` creates the back-office logins the CRM signs in with (`STAFF_TEMP_PASSWORD`, default `AtelierTemp2026!`).

## Domain guides

The deep per-domain docs live in nested CLAUDE.md files that load automatically when working in that directory. **Read the relevant one BEFORE editing that area** — each records invariants and confirmed regressions, not style preferences:

- `src/catalogue/CLAUDE.md` — public catalogue, admin catalogue CRUD, trade PRICE vs trade VISIBILITY gates, collections, featured ranking
- `src/orders/CLAUDE.md` — order requests, history + guest lookup, back-office state machine + reservation model
- `src/checkout/CLAUDE.md` — Stripe checkout (no client prices; 422 rules)
- `src/webhooks/CLAUDE.md` — Stripe webhook (raw body, idempotency ledger, server-side money re-resolution)
- `src/shipping/CLAUDE.md` — flat-rate quotes + tier upserts
- `src/email/CLAUDE.md` — transactional mail (mailer never throws, no-op when null)
- `src/admin/CLAUDE.md` — AdminJS panel (fails soft; security invariants that each fixed a confirmed exploit)
- `src/lifecycle/CLAUDE.md` — delete/archive foundations + every hard DELETE route (entity names are single-quoted code literals, never path params)
- `src/seed/CLAUDE.md` — seed, supplier price-list pipeline, pricing template v1/v3, **self-service import (`/admin/price-lists/import/*`)**, the deleted duty placeholder + the corrected waterfall order, colour-file converters + `import:colour` (converters in `scripts/` share it)
- `src/legacy/CLAUDE.md` — D365 staging import, `push:legacy`, `d365_overrides` correction layer + custom fields
- `src/suppliers/CLAUDE.md` — suppliers vs brands, commercial terms (discount chains are MULTIPLICATIVE), backfill
- `src/trade-accounts/CLAUDE.md` — trade client portal, viewer scoping, account-name collision rules
- `src/products/CLAUDE.md` — category spreadsheet round trip (export/validate/apply), hardened CSV reader/writer
- `src/reports/CLAUDE.md` — reporting: filters, revenue scope, finance masking, CSV export, stock/not-invoiced
- `src/samples/CLAUDE.md` — samples register (samples are NOT stock), loans, sample orders, showrooms
- `scripts/CLAUDE.md` — pointer to the pipeline docs above
- `.github/CLAUDE.md` — CI workflow constraints (Node 22, postgres:14 service, no typecheck step)

## Cross-cutting traps

The ones that bite from outside their home directory:

- pg returns `numeric` columns as strings — coerce with `Number()` before arithmetic. `Number(null)` is 0, so nullable numerics need `value == null ? null : Number(value)`.
- Fastify's bundled Ajv runs `removeAdditional: true`: unknown body/query keys are silently STRIPPED, never rejected. In-code column whitelists are the real gate, and `additionalProperties: false` proves nothing.
- Register/login share a 10-per-15-min per-IP rate-limit bucket: test suites register users once in `beforeAll`, never per test; the limiter store is per `buildApp()` instance.
- Fixture cleanup order: delete `orders` (and `sample_loans`/`sample_orders`/`samples`) before `brands` — `order_lines.colourway_id`, `samples.colourway_id` and `sample_orders.colourway_id` are RESTRICT edges that 23503 the cleanup itself.
- Never join a supplier colour code or a D365 item-code fragment to `price_list_items.code` — they do not match by construction; the corpus is evidence, not a key.
- jsonb query params must be `JSON.stringify`'d before binding — pg maps raw JS arrays/objects to Postgres arrays/records, not jsonb.
- `incoming/` is gitignored and exists only in the main checkout — converters cannot run from a worktree, and no test may read it.
