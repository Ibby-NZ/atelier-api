# W3 — Suppliers (Epic 3)

Suppliers become a first-class domain linkable to brands, and `products` gains the `category`
column that unblocks W6.

**Epic:** [`_bmad-output/planning-artifacts/epics.md` — Epic 3](../../_bmad-output/planning-artifacts/epics.md)
**Branch:** `aug6/w3-suppliers` in both `atelier-api` and `atelier-crm`
**Requires:** W1 merged into `august-6th-updates` in both repos · **Blocks:** W6 (needs `products.category`)

---

## Stories

| # | Story | Repos | Commit(s) |
|---|---|---|---|
| US-001 | Migration: suppliers, aliases and the two FK columns | api | `b811e91` |
| US-002 | Migration: supplier brand terms and discount tiers | api | `4ffadf9` |
| US-003 | Migration: `products.category` | api | `9d912c2` |
| US-004 | Supplier read models and admin module | api | `ed60431` |
| US-005 | Supplier routes including DELETE | api | `c473ce7` |
| US-006 | Backfill suppliers from existing data | api | `b4d21fa` |
| US-007 | AdminSuppliers CRM screen | crm | `137d272` (crm) · `286c236` (api, story record) |

All seven pass. Nothing is blocked.

---

## What landed

**Schema** (`atelier-api/migrations/`) — `suppliers` (unique name + slug, `d365_token`, partial live
index, `discount_method` CHECK) and `supplier_aliases` (unique on `lower(btrim(alias))`);
`brands.supplier_id` **RESTRICT** and `price_list_items.supplier_id` **SET NULL** beside the
retained free-text `supplier`; `supplier_brand_terms` (flat discount, `numeric(6,4)[]` chain,
markup, unique per brand) + `supplier_discount_tiers` (partial-unique fallback); `products.category`
with the same four-value CHECK as `price_list_items.category`.

**No cost column was added to `brands`** — it serves anonymous visitors. It gains exactly one
integer FK, and a schema-layer test asserts no `brands` column matches the cost vocabulary.

**API** — `src/suppliers/` (`admin-suppliers.js`, `supplier-terms.js`, `discount-chain.js`,
`backfill.js`, `backfill-plan.js`) and `src/routes/admin-suppliers.js`
(`GET|POST /admin/suppliers`, `GET|PATCH|DELETE /admin/suppliers/:id`,
`POST /admin/suppliers/:id/archive|restore`), every route `requireRole('backoffice')`. DELETE is the
first route wired to the shared `deleteOrExplain`/`replyDelete` lifecycle, blocked by houses and
price-list items with a count each and offering `archivable: true`.

**Backfill** — `npm run backfill:suppliers`, from `SELECT DISTINCT price_list_items.supplier` plus
the vendored `src/seed/data/suppliers.js`. Real corpus: 42 suppliers, 4 aliases, 40 name matches,
15 house links, 6 terms rows. Re-running changes nothing.

**CRM** — `AdminSuppliers` at `/admin/suppliers`, beside the untouched demo `Suppliers` screen under
a `suppliersTabs` strip. First consumer of the whole W1 kit (`useCrudScreen`, `Pagination`,
`ConfirmDialog`).

**A discount chain is multiplicative**: `{0.4, 0.4}` is **×0.36**, not −80%. One evaluator
(`src/suppliers/discount-chain.js`), asserted by test; the CRM formats the API's `net_multiplier`
and never reduces a chain itself.

---

## Gates

| Repo | Command | Result |
|---|---|---|
| atelier-api | `npm run lint` | 0 |
| atelier-api | `npm test` | 0 — 45 files, 802 tests |
| atelier-api | `npm run migrate` ×2 | second run "No migrations to run!" (programmatic runner returns `[]`) |
| atelier-crm | `npm test` | 0 — 33 files, 412 tests |
| atelier-crm | `npm run build` | 0 |

No typecheck step: there is no TypeScript in either repo.

---

## Needs human verification

Nothing in this branch was verified in a browser — there is no e2e harness in either repo and no
jsdom in the CRM, so a person must look at the following.

1. **`http://localhost:5273/#/admin/suppliers`, signed in as a seeded staff login.**
   - The tab strip moves between the demo **Supplier master** (`/suppliers`) and the live
     **Manage suppliers**, and the SideNav item stays lit on both.
   - A delete blocked by houses / price-list items keeps the confirm dialog **open**, lists the
     counts ("2 houses, 3 price-list items") and offers **Archive instead**.
   - Expanding a row loads its aliases, the houses it invoices and each house's terms; a chain
     renders as ×0.36 and a tiered house as "N discount tiers" with the tier rates beneath.
   - **`CAPS.FINANCE_VIEW` masking.** Every CRM login maps to the demo `director` capability set
     today, so the masked state is only visible by signing in as a non-finance demo login (or
     temporarily flipping `STAFF_ROLE_MAP`). Expected: the method survives, the rate is replaced.
2. **Run the real backfill sequence on a database that has the rates** and read the printed report:
   `npm run migrate && npm run seed && npm run import:pricing && npm run backfill:suppliers`. Three
   items on it are decisions for the office, not defects —
   - `Jannelli Volpi` (rate ledger, 2,516 rows) vs `Janelli Volpi` (snapshot, holds JV's tiers and
     the ×0.36 chain): both rows are created and the pair reported. The merge is manual — add the
     alias, DELETE the duplicate (SET NULL keeps the rates), re-run.
   - Manuel Canovas: every rate on file is GBP, the snapshot says EUR. The rates win.
   - Seven JV houses the snapshot names that were never catalogued, so their tiers and chain do not
     land today.
3. **The AdminJS panel at `/panel`** now introspects the new columns on `products` and `brands`.
   `suppliers`, `supplier_brand_terms` and `supplier_discount_tiers` are deliberately **not**
   registered as panel resources — they are cost-bearing.
