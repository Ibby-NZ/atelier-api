# Project context — Atelier platform, "August 6th updates"

Rules an AI agent must follow when writing code in these repos. Unobvious things only —
anything you would get wrong by pattern-matching from other projects.

BMAD scans only the repo it is installed in (`atelier-api`). The CRM and storefront sections
below are hand-written; do not assume BMAD derived them.

---

## The three repos

| Repo | Path | Stack | Default branch |
|---|---|---|---|
| atelier-api | `/Users/verumoffice/atelier-api` | Fastify 5 + node-pg (raw SQL, no ORM) + node-pg-migrate | `main` |
| atelier-crm | `/Users/verumoffice/atelier-crm` | React 18 + Vite, HashRouter | **`master`** |
| atelier-storefront | `/Users/verumoffice/atelier-storefront` | Astro 7 + React 19 islands + EmDash CMS | `main` |

**All three are plain JavaScript, ESM. There is no TypeScript and no typecheck step anywhere.**
If a template or convention tells you to add "Typecheck passes" as an acceptance criterion,
it is wrong — substitute the real gates below.

Ports for a full local loop: api `3001`, storefront `4321`, CRM `5273`.

---

## Quality gates — the real ones

| Repo | Gates |
|---|---|
| atelier-api | `npm run lint` (ESLint 9 flat config) and `npm test` (vitest, **against a real local Postgres**) |
| atelier-crm | `npm test` (vitest) and `npm run build` — **there is no ESLint here**; `build` is the only compile check, so a bad import or JSX syntax error surfaces nowhere else |
| atelier-storefront | `npm run lint`, `npm test` (`node --test`, needs Node ≥ 21), `npm run build` |
| Any converter change | `npm run convert:pricing && git diff --exit-code src/seed/data/price-lists.json` |

Migration stories additionally: run `npm run migrate` twice and prove the second run is a no-op —
the programmatic runner returns an empty array.

---

## Branch discipline (absolute)

**Never commit, push, merge or rebase onto `main` or `master`.** The live sites and API run off
them. Work happens on `aug6/<workstream>` branches; a human merges into `august-6th-updates`.

Never run `git push`, `git rebase`, `git stash`, `git reset --hard`, `git switch`, `git branch`
or any `--force`. `git stash` is especially dangerous: a stash is shared across all worktrees of
a repo, so stashing in one worktree silently moves another's work.

---

## atelier-api

### Structure
- `src/config.js` — `loadConfig(env)` validates env vars and throws with a clear message.
- `src/db.js` — `createPool(databaseUrl)`. **Inject the pool into `buildApp({ pool })`; never
  import a global pool** (keeps tests isolated).
- `src/app.js` — `buildApp()` builds the Fastify instance without listening. Tests use
  `app.inject()`, so no port binding.
- `src/server.js` — the only entry point that listens.
- Route files are thin; read/write logic lives in a domain module (`src/catalogue/`, `src/orders/`,
  `src/pricing/`, `src/users/`, `src/trade-accounts/`).

### Migrations
- `npm run migrate:create` emits a **CommonJS** template (`exports.up`). **Rewrite it to ESM**
  (`export const up/down`) — the package is `"type": "module"`.
- `vitest.config.js` sets `fileParallelism: false` because node-pg-migrate takes a Postgres
  advisory lock. Do not "optimise" that away.

### Hard-won rules
- **Column names are never user input.** Every PATCH builds its SET clause from a frozen in-code
  whitelist via `buildUpdate(input, columns)`; values are always `$n` placeholders.
- **`Object.hasOwn` keeps an explicit `null` distinct from an absent key** — that is how a PATCH
  clears a nullable column versus leaving it alone.
- **Duplicates are detected by the database, never pre-checked.** pg `23505` maps to 409 through
  `rethrowConflict`, keyed on `error.constraint`. An unknown constraint degrades the *message*,
  never the status. A pre-check races and would still need the handler.
- **Fastify's bundled Ajv runs `removeAdditional: true`**, so `additionalProperties: false`
  silently *strips* unknown body keys rather than rejecting them. Never rely on schema strictness
  to reject a field — leave it out of the whitelist.
- **Fastify has no `format: 'email'`** — body schemas use `EMAIL_PATTERN` regex.
- **A `.csv` route suffix must be its own path segment** (`/export.csv`), or Fastify folds it into
  the preceding `:param` and every lookup 404s.
- **The rate limiter is `global: false`** — a route without `config: { rateLimit: ... }` is
  unmetered. New routes must opt in.
- **pg returns `numeric` columns as strings.** Coerce with `Number()` before arithmetic.
- **`jsonb` params must be `JSON.stringify`'d** — pg maps a raw JS array to a Postgres array and a
  raw object to a record, not to jsonb.
- **CORS names two browser origins and every write method explicitly.** `@fastify/cors` defaults to
  `GET,HEAD,POST`, so an unlisted `PATCH`/`PUT`/`DELETE` is refused at the preflight and never
  reaches the server — while curl and `app.inject()` (neither of which preflights) keep passing.
  A CORS assertion made with `inject` alone is worthless for methods.

### Seed semantics
- Brands/collections/products/colourways upsert `ON CONFLICT … DO UPDATE`.
- **`inventory` and `shipping_rates` use `DO NOTHING`** — they become live operational data after
  the first seed and a reseed must not clobber them.
- **Columns deliberately absent from the `DO UPDATE` set list survive every reseed**: `trade_only`,
  `website_url` (COALESCE), and any new operational flag. That is the mechanism by which a
  back-office decision outlives a reseed. If you add such a column, add a `test/seed.test.js`
  assertion or it regresses the first time someone extends the upsert.

### Legacy D365 staging — read-only by design
- Eleven `legacy_*` tables, upserted on the D365 GUID by `npm run import:legacy`.
- **`importLegacyEntity` upserts every mapped column to EXCLUDED**, so anything an application
  writes onto a `legacy_*` row is destroyed by the next import. **Never store live state there** —
  that is why `trade_accounts` exists outside the namespace, and why the new `samples` domain must
  too.
- **All four transaction entities are header-only.** No line items exist in any export. Historic
  product-grain revenue is therefore impossible; do not invent it.
- **Lookup columns export as the target's display name, not a key.** Names are not unique
  (866 accounts, 865 distinct names), so a name-equality predicate returns the union of every
  account sharing it — cross-client disclosure by construction.
- **`legacy_cuttings.comments` must never be served to a client or copied into a new table.**
  1,757 of 1,886 rows carry it, holding staff names, handling instructions and, in current rows,
  third parties' names, emails, phones and home addresses.

### Money and trade pricing
- `price_list_items` is Atelier's **BUY** side — supplier rates, mostly discount-inclusive.
  It must never reach a client-facing response. `test/price-list-exposure.test.js` asserts no
  client-facing key matches `/wholesale|landed|duty|freight|cost|margin|markup|credit_limit|payment_terms/`.
- `src/catalogue/brands.js` serves brand rows to **anonymous** visitors. Never put a cost column
  on `brands`.
- Two independent gates that are easy to conflate: `includeTrade` (who may see
  `trade_price_cents`) is **approved trade only**; `includeTradeOnly` (whose products exist at all)
  is approved trade **plus** backoffice/director.

---

## atelier-crm

- **Never call `fetch` directly in a screen.** Everything goes through `src/lib/api.js`
  (`apiGet`, `apiSend`, `apiFetch`, `safeFetch`), which sets `credentials: 'include'` and throws
  `ApiError` carrying `.status` and `.body` (so a 422's field errors survive).
- **There is no jsdom, so component tests are impossible.** House convention: put the rules in a
  plain `.js` beside the screen and unit-test that; keep the `.jsx` dumb. See
  `src/screens/clientAccounts.js` + `clientAccounts.test.js`.
- Shared admin chrome is `src/admin/parts.jsx` (`panel`, `PanelHead`, `Field`, `CheckField`,
  `GhostButton`, `ErrorLine`, `PanelNote`, `Row`, `HeaderRow`, `useToast`, `ToastLine`,
  `messageOf`, `useMutation`). Draft/diff plumbing is `src/admin/drafts.js`
  (`draftFrom`/`diffFields`/`bodyFrom`, field kinds `text|enum|upper|money|decimal|date|tones|bool|ref|url`).
- `diffFields` sends **only changed keys** — the API 400s an empty PATCH.
- `useMutation({ reload, flash })` awaits `reload()` before flashing, because the server generates
  slugs and counts the client cannot predict.
- Styling is inline styles off `src/theme.js` tokens. Sub-components at the bottom of a screen file
  are house style here (unlike the storefront, whose ESLint forbids them).
- Data fetching uses a hand-rolled `useEffect` with an `active` flag — StrictMode double-mounts.

---

## atelier-storefront

- **Every page must declare `export const prerender = true`** unless it genuinely needs
  request-time rendering — EmDash forces `output: "server"`, so omitting it silently makes a page SSR.
- A page's SSR fetch **carries no browser cookie**, so anything viewer-dependent must resolve in a
  client island, not in frontmatter.
- `src/lib/api.js` exposes `apiFetch` (throws), `safeFetch` (never throws — used at build time so
  an API outage cannot fail the build) and `apiDownload`.
- Keep real logic in `.js`/`.jsx` modules: `.astro` files are deliberately not linted.
- Tests are `node --test` over `src/**/*.test.js`, pure functions only.

---

## Working style

- Small files (200–400 lines typical), high cohesion. Functions under 50 lines.
- Immutable updates; config objects frozen.
- Handle errors explicitly; never swallow. Validate at every system boundary.
- No hardcoded secrets, ever. Secrets come from the environment.
- Match the surrounding code's comment density and idiom.
- When you learn something durable, write it into that repo's `CLAUDE.md` under your workstream's
  own heading — never restructure an existing section, because other workstreams are editing the
  same file concurrently.
