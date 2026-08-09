# Merge review — `august-6th-updates` → `main` / `master`

**Audience:** the senior developer merging this branch. Everything below is verifiable
from the branch itself; nothing depends on taking this document's word.
**Written:** 10 Aug 2026, at api `3015522` · crm `7d5885f` · storefront `27910b1`.

---

## 1. What this branch is

Ten workstreams ("August 6th updates"), planned in `_bmad-output/planning-artifacts/`
(PRD, architecture, epics — one epic per workstream) and executed as autonomous
per-story agent loops (Ralph, `ralph/README.md`) in isolated git worktrees, one
Postgres database per workstream. Every story's audit trail is committed:
`ralph/<ws>/prd.json` (acceptance criteria + pass flags), `progress.txt` (per-story
log with learnings), `PR-BODY.md` (the workstream's own merge summary), and
`verify-*.log` (gate runs, committed as artefacts).

| Epic | Branch scope | Stories | What shipped |
|---|---|---|---|
| W1 Foundations | api + crm + store | 6 | `src/lifecycle/` delete/archive module; CRM CRUD kit (`useAdminList`, `useCrudScreen`, `ConfirmDialog`, `deleteFlow`, `Pagination`); CI workflows in all three repos |
| W2 CRUD completion | api + crm | 12 | DELETE endpoints for every dataset (via lifecycle registry — the API never had them); brand/collection/price-list admin reads; shipping-rate CRUD; AdminCollections + AdminShipping screens; delete on every CRM screen |
| W3 Suppliers | api + crm | 7 | `suppliers`, `supplier_aliases`, `supplier_brand_terms`, `supplier_discount_tiers`; `brands.supplier_id` (RESTRICT), `price_list_items.supplier_id` (SET NULL); `products.category`; corpus backfill; AdminSuppliers screen |
| W4 Samples | api + crm | 9 | `showrooms`, `samples`, `sample_loans` (one-open-loan partial unique index), `sample_orders` + state machine; by-barcode lookup; check-out/check-in; three live screens replacing the demo pair |
| W5 Reporting | api + crm | 8 | `src/reports/` (product performance, stock, not-invoiced) + CSV exports sharing one builder; `src/lib/csv.js` extraction; `users.can_view_finance` + derived `report_access` on `/auth/me`; server-side masking |
| W6 Category export | api + crm | 5 | Product-sheet CSV round trip (export with empty Category, validate, apply); AdminProductSheet screen |
| W7 Featured | api + crm + store | 7 | `featured_rank` on brands + collections; whole-list reorder endpoints; public ordering; CRM featured panel; storefront homepage + brands page read featured (hardcoded slug arrays deleted) |
| W8 Colour files | api | 6 | `scripts/convert-colour-files.js` + adapter registry for the 18 supplier colour spreadsheets; colourway importer; 2026 rates emitted in the W10 template shape |
| W9 Scanner spike | api (docs) | 3 | `research-sample-scanner.md` + ADR 001 (keyboard-wedge scanner; `BarcodeDetector` absent on all iOS browsers) — research only, no code |
| W10 Pricing template | api | 6 | Universal supplier pricing template v2 (strict superset of the 14 v1 columns, versioned by header row); template registry; shared vocabulary module; byte-pin tests |

All 68 stories `passes: true`. No `BLOCKED.md` anywhere.

## 2. Scale

| Repo | vs base | Commits | Diff |
|---|---|---|---|
| atelier-api | `main` (`5d19d48`) | 119 | 471 files, +83,447 −1,142 |
| atelier-crm | `master` (`0989524`) | 25 | 83 files, +12,774 −1,689 |
| atelier-storefront | `main` (`f5cfc5e`) | 7 | 26 files, +2,191 −693 |

**Zero dependency changes in any repo** — `package.json` diffs are npm scripts only
(`convert:pricing`, `convert:colour`, `import:colour`, `backfill:suppliers`, …).
No new env vars; `.env.example` unchanged.

## 3. How it was verified (the part to trust least — so here is the evidence)

Per workstream, in order:

1. **Gates on every story commit** — api `lint` + full test suite; crm tests + build;
   storefront lint + tests + build. The api suite runs real migrations against a real
   Postgres — no DB mocks exist in this codebase.
2. **`ralph/verify.sh` at the branch tip**, log committed under `ralph/<ws>/verify-*.log`.
   Two logs record *false* failures worth understanding before you re-run anything:
   node-pg-migrate takes an advisory lock, so two concurrent gate runs against one
   database throw "Another migration is already running". W3's and W4's logs document
   this; the committed green runs were taken alone on the database.
3. **Independent agent reviews after each loop** — code-reviewer on every branch diff,
   database-reviewer where `migrations/` changed, security-reviewer for W2/W3/W5/W8
   (the workstreams touching auth, money or exports). Verdicts: **every workstream
   APPROVE / nothing-blocking; zero CRITICAL, zero HIGH left open.**
4. **Cross-repo drift check** — every API path called in a CRM/storefront diff was
   resolved against the branch's registered routes.
5. Final suite at tip: **api 62 files / 1,733 tests · crm 41 files / 713 tests ·
   storefront green** — all exit 0.

### Defects the reviews caught, fixed on this branch (each with a regression test)

| Commit | What was wrong |
|---|---|
| api `0c60ba4` | W10 added `duty_class ~ '^[A-Z]$'` as a **validating** CHECK over a column that had been free text since creation — aborts the migration (23514) on any database holding a staff-typed value. Reproduced on a scratch DB, fixed to `NOT VALID` (new writes constrained, existing rows untouched). |
| api `e38b5fa` | A house carrying negotiated supplier terms but no products/collections (17 of 41 seeded houses) hard-deleted straight through the catalogue probes and CASCADE-took its `supplier_brand_terms`. Brand entity now probes the terms table; W3's source-scan test allow-lists the registry with the reason. |
| api `3015522` | Product/colourway deletes died mid-cascade on a bare 23503 when samples were cut from the design ("related records" instead of naming them). Both entities now probe `samples` + `sample_orders`; `CONSTRAINT_BLOCKERS` names all four samples-domain RESTRICT edges. |
| crm `2f9a909` | W2's "not one collection endpoint is called from the houses screen" test passed **for the wrong reason** after W7's featured panel falsified it (path literals live in `featuredOrder.js`, out of the source scan's sight). Narrowed to the true invariant: no collection CRUD on the screen. |
| crm `7d5885f` | SideNav never highlighted on the three live sample screens (match arrays predated the redirects); the two retired 721-line demo screens were still on disk unrouted. Fixed + deleted. |

Two workstreams died mid-story on an account spend limit and were rescued by the
supervising session — W5-US-008 (complete but uncommitted in both repos; diff
re-reviewed line-by-line before commit `95ed056`/`b825dd7`) and W4-US-009 (loop
relaunched, finished normally). Disclosed in each `progress.txt` and PR body.

## 4. Database changes — read before deploying

Nine new migrations (all `node-pg-migrate`, ESM, idempotent — `npm run migrate`
twice is a no-op, proven per migration story):

```
1786334400000_price-list-template-v2.js    W10: brand_name, pattern_match, duty_percent,
                                                template_version on price_list_items;
                                                class CHECKs (duty_class is NOT VALID — see below)
1786334400000_suppliers.js                 W3:  suppliers, supplier_aliases, the two FK columns
1786420800000_suppliers-brand-terms.js     W3:  supplier_brand_terms, supplier_discount_tiers
1786507200000_product-category.js          W3:  products.category (nullable, CHECKed vocabulary)
1786593600000_featured-rank.js             W7:  featured_rank on brands + collections (nullable, no rewrite)
1786680000000_reporting-finance-access.js  W5:  users.can_view_finance (fast-default), orders.created_at index
1786680000000_samples-register.js          W4:  showrooms, samples
1786766400000_samples-loans.js             W4:  sample_loans + one-open-loan partial unique index
1786852800000_samples-orders.js            W4:  sample_orders
```

Four things a reviewer should actively check rather than skim:

- **Two timestamp collisions** (`1786334400000` ×2, `1786680000000` ×2). Verified
  harmless: node-pg-migrate breaks the tie deterministically by filename
  (`localeCompare`), `pgmigrations` keys on the full name, and each pair touches
  disjoint tables. **Do not "fix" by renaming** — a migration already recorded under
  its filename would be re-run by every migrated database and crash on `createTable`.
  Documented in `CLAUDE.md` § Migrations.
- **`duty_class` CHECK is `NOT VALID` on purpose** (`0c60ba4`). Validating it is a
  deliberate second migration after someone audits the column on the live database.
- **`orders.created_at` index is a plain (non-CONCURRENT) build** — takes a write
  lock on `orders` for the build's duration. Trivial at current row counts; schedule
  consciously if the production table is large.
- **FK posture** follows the codebase rule (see `CLAUDE.md` § Foundations): new
  RESTRICT edges (`samples`/`sample_orders` → colourways, `sample_orders` → showrooms,
  `sample_loans` → samples, `brands` → suppliers) are all probed by the lifecycle
  registry so staff get a named 409, not a bare 23503.

## 5. API surface added

All new admin routes are `requireRole('backoffice')` (director inherits); no new
public routes; report routes additionally opt into the rate limiter.

- **DELETE (W2, via `deleteOrExplain` — refusals carry named blockers):**
  `/admin/{brands,collections,products,colourways,price-list-items,contact-enquiries,shipping-rates,users}/:id`
  and (W3/W4) `/admin/{suppliers,samples,showrooms,sample-orders}/:id`
- **Suppliers (W3):** `GET/POST /admin/suppliers`, `GET/PATCH/DELETE /admin/suppliers/:id`, `/archive`, `/restore`
- **Samples (W4):** samples/showrooms/sample-orders CRUD + `/archive` + `/restore`,
  `GET /admin/samples/by-barcode/:barcode` (deterministic 200/404 per ADR 001),
  `POST /admin/samples/:id/check-out|check-in`, `POST /admin/sample-orders/:id/transition`
- **Reports (W5):** `GET /admin/reports/{product-performance,stock,not-invoiced}` + `/export.csv` each
- **Product sheet (W6):** `GET /admin/product-sheet/export.csv?brand=`, `POST …/validate`, `POST …/apply`
- **Featured (W7):** featured columns on existing brand/collection admin PATCHes + whole-list
  reorder endpoints (`PUT /admin/brands/featured`, `PUT /admin/collections/featured`)
- **Auth (W5):** `/auth/me` now carries derived `report_access: { reports, finance }`;
  the backing `can_view_finance` flag is provably absent from every response
  (projection, asserted by test).

## 6. Security posture (what the security reviews verified, not asserted)

- **BUY-side isolation holds.** No supplier cost, discount tier, margin or term
  reaches any client-facing route; `brands` (served anonymously) gained only
  `supplier_id`, which no public read model selects. Enforced by source-scan tests
  (`test/suppliers-terms.test.js`, `test/price-list-exposure.test.js`), not convention.
- **Report masking is server-side, fail-closed, applied before headers on both the
  JSON and CSV paths**, keyed on the session-resolved user id. CSV formula-injection
  guard proven end-to-end (fixture design named `=SUM(A1:A9)`).
- **SQL**: every filter/sort/update column comes from frozen in-code whitelists
  validated at module load; values always `$n`-bound. The samples suite fires a
  literal injection string through every filter and asserts it never reaches SQL.
- **CRM masking is cosmetic by design** — the server guard is the boundary; the CRM
  files say so in their headers. Pre-existing posture, not introduced here.

## 7. Known-accepted items (decided, not forgotten — confirm you agree)

1. **Migration timestamp collisions stay** (see §4).
2. **`TRADE_PRICE_LISTS_ENABLED` remains off**; `trade_price_cents` is still demo data.
3. **Featured merchandising footgun:** the office can feature a trade-only house's
   collection; the homepage hero then links signed-out visitors to an empty grid.
   Correct per the visibility design, but the CRM shows no warning. UI hint = follow-up.
4. **Reorder endpoints are last-write-wins** between two concurrent staff saves
   (row-locked, no corruption) — matches the existing shipping-rates precedent.
5. **W4 LOWs, self-disclosed:** no loan-note edit route (append-only history);
   colourway on sample forms is a raw id box pending a picker; `__proto__` lookup
   edge in the sample-order state machine is unreachable through the routes
   (Fastify enum 400s first).
6. **W5:** no live report declares a finance column until A1 (cost source) is
   settled, so column-masking is unit-proven but idle in production; the stock
   report deliberately ships without valuation; `can_view_finance` is grantable
   only via the AdminJS panel until the users PATCH whitelist is widened.
7. **W9's ADR 001 is `proposed`**, awaiting confirmation of the showroom device
   (iPad vs laptop). Flip to `accepted` when known.

## 8. Suggested review path

```bash
# Per repo, the whole change:
git log --oneline --graph main..august-6th-updates     # (master for the CRM)
git diff main...august-6th-updates

# Per workstream: the [Wn-US-nnn] tags reassemble cross-repo stories.
git log --oneline --grep='\[W4-' august-6th-updates    # example

# Each workstream's own summary + verification list:
ls ralph/*/PR-BODY.md ralph/*/verify-*.log

# Re-run everything (needs local Postgres; suite migrates it):
npm run lint && npm test                               # api
npm test && npm run build                              # crm
npm run lint && npm test && npm run build              # storefront

# Converter byte-identity (main checkout only — incoming/ is gitignored and
# exists nowhere else; in a worktree this check passes vacuously):
npm run convert:pricing && git diff --exit-code src/seed/data/price-lists.json
```

**Merge order: api → crm → storefront** (a merged CRM screen calling an unmerged
endpoint 404s). After merging, run `npm run migrate` before deploying the API, and
note the human-verification lists aggregated in each `ralph/<ws>/PR-BODY.md` — the
items only a person with a browser and a back-office login can check (masked report
library under a non-finance login, the featured panel, the sample scanner flow).

## 9. Where everything lives

| What | Where |
|---|---|
| Requirements / architecture / epics | `_bmad-output/planning-artifacts/` |
| Status board (all done) | `_bmad-output/implementation-artifacts/sprint-status.yaml` |
| Per-workstream audit trail | `ralph/<ws>/{prd.json,progress.txt,PR-BODY.md,verify-*.log}` |
| Scanner research + ADR | `_bmad-output/planning-artifacts/research-sample-scanner.md`, ADR 001 in `architecture.md` |
| House rules the branch added | `CLAUDE.md` sections: Foundations · Pricing template · Suppliers · Samples · Category export · Reporting · Featured · Colour files |
| D365 export analysis | `docs/d365-export-analysis.md` |
