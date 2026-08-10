# Epics — "August 6th updates"

Ten epics, one per workstream, in dependency order. The 1:1 mapping is load-bearing: each epic
becomes exactly one Ralph `prd.json`.

Story sizing rule: one story = one iteration = one context window. Hard ceiling **3 files of new
code + 1 test file**. Migrations are always their own story.

Every story's acceptance criteria end with the gates for the repos it touches. **The string
"Typecheck passes" must appear nowhere — there is no typecheck in any of these repos.**

Wave schedule:

```
Wave 1  E1 (alone, supervised)  ·  E10  ·  E9
Wave 2  E8 (needs E10)  ·  E2  ·  E3  ·  E7   (after E1 merges)
Wave 3  E4  ·  E6                             (both need E3's category column)
Wave 4  E5
```

---

## Epic 1 — Foundations (`aug6/w1-foundations`) · api + crm · 6 stories

**Goal:** the shared delete/archive mechanism and the CRM CRUD kit every other epic consumes.
Runs alone; nothing else starts until it merges.

| # | Story | Repos |
|---|---|---|
| US-001 | Lifecycle registry and `deleteOrExplain` with probe-first deletion and the 23503 backstop | api |
| US-002 | `setArchived` replaces the eight duplicated archive helpers, wrappers preserved | api |
| US-003 | Registry safety tests: probe shape, relation names, tables exist in `information_schema` | api |
| US-004 | CRM `list.js` + `useAdminList` + `Pagination`, replacing the five copy-pasted paginators | crm |
| US-005 | CRM `ConfirmDialog` + `deleteFlow` + `useCrudScreen`, plus `apiDelete` in the API client | crm |
| US-006 | CI workflows for all three repos, gates on PRs into `august-6th-updates` | api + crm + store |

Key acceptance criteria — US-001: a delete of a parent with CASCADE children returns 409 listing
them and destroys nothing; the parent is locked `FOR UPDATE` (not `FOR NO KEY UPDATE`) before the
probes; probes count archived rows too; a blocked result carries `archivable`.

---

## Epic 2 — CRUD completion (`aug6/w2-crud`) · api + crm · 12 stories

**Goal:** every dataset the CRM shows has full create, read, update and delete.
**Requires:** E1 merged.

| # | Story | Repos |
|---|---|---|
| US-001 | Registry entries + DELETE routes for brand and collection | api |
| US-002 | Registry entries + DELETE routes for product and colourway | api |
| US-003 | DELETE for price-list item and contact enquiry | api |
| US-004 | DELETE for user, with the self-delete guard | api |
| US-005 | Missing admin reads: brand, collection, price-list item by id | api |
| US-006 | `GET /admin/colourways` (paginated) and `GET /admin/colourways/:id` | api |
| US-007 | Shipping-rate CRUD: list, create, patch, delete with the last-tier guard | api |
| US-008 | Inventory create and delete, unit derived from product type | api |
| US-009 | Delete wired into the products and houses screens through `useCrudScreen` | crm |
| US-010 | Standalone `AdminCollections` screen extracted from `AdminBrands` | crm |
| US-011 | `AdminShipping` screen | crm |
| US-012 | Delete wired into stock, supplier rates, orders and users screens | crm |

**Owns these files** (other Wave 2 epics must not touch them): `src/routes/admin-catalogue.js`,
`admin-inventory.js`, `admin-orders.js`, `admin-price-lists.js`; CRM `AdminProducts.jsx`,
`AdminStock.jsx`, `AdminOrders.jsx`, `AdminCollections.jsx`.

---

## Epic 3 — Suppliers (`aug6/w3-suppliers`) · api + crm · 7 stories

**Goal:** suppliers become first-class and linkable to brands; product categorisation is unblocked.
**Requires:** E1 merged. **Blocks:** E6.

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `suppliers`, `supplier_aliases`, `brands.supplier_id`, `price_list_items.supplier_id` | api |
| US-002 | Migration: `supplier_brand_terms` and `supplier_discount_tiers` | api |
| US-003 | Migration: `products.category` with the four-value check | api |
| US-004 | Supplier read models and admin CRUD module | api |
| US-005 | Supplier routes incl. DELETE with brand/price-list blockers | api |
| US-006 | Backfill script from distinct price-list suppliers and the seed supplier data | api |
| US-007 | `AdminSuppliers` CRM screen beside the existing demo screen | crm |

Key acceptance criteria — US-001: currency is the supplier's invoicing currency; no cost column is
added to `brands`; `price_list_items.supplier` free text is retained. US-002: discount chains are
stored as arrays, and a test asserts `{0.4,0.4}` evaluates to ×0.36.

---

## Epic 4 — Samples (`aug6/w4-samples`) · api + crm · 9 stories

**Goal:** a real samples register and showroom stocking, replacing three demo screens.
**Requires:** E1, E3 (supplier FK).

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `showrooms` and `samples` | api |
| US-002 | Migration: `sample_loans` with the one-open-loan partial unique index | api |
| US-003 | Migration: `sample_orders` | api |
| US-004 | Samples read models, list filters, overdue derivation | api |
| US-005 | Sample CRUD routes plus `by-barcode` lookup | api |
| US-006 | Check-out / check-in verb routes through `withSampleTxn` | api |
| US-007 | Sample-order lifecycle module and routes | api |
| US-008 | `AdminSamples` and `AdminShowrooms` screens | crm |
| US-009 | `AdminSampleOrders` screen; scanner wired to real endpoints; retired routes redirect | crm |

Key acceptance criteria — every migration story asserts no `legacy_*` table gained a column.
US-002 asserts two concurrent check-outs produce one loan and one 409. US-004 asserts no sample
code path reads or writes `inventory`.

---

## Epic 5 — Reporting (`aug6/w5-reporting`) · api + crm · 8 stories

**Goal:** real aggregation with filters and safe exports.
**Requires:** E2 (read models), E3 (suppliers/category).

| # | Story | Repos |
|---|---|---|
| US-001 | Extract the hardened CSV writer to `src/lib/csv.js`, no behaviour change | api |
| US-002 | Migration: `orders.created_at` index and `users.can_view_finance` | api |
| US-003 | `src/reports/filters.js` — whitelist, parsing, clause building; pure and unit-tested | api |
| US-004 | `revenue-lines.js` scope CTE and the report access/masking module | api |
| US-005 | Product performance by brand: query, mapper, route | api |
| US-006 | Server-side CSV export sharing one query builder with the table | api |
| US-007 | Stock and not-invoiced reports | api |
| US-008 | `report_access` on `/auth/me` and the CRM consuming the live reports | api + crm |

Key acceptance criteria — US-004: a non-finance caller's payload contains no finance key anywhere,
including in `totals`. US-006: the CSV of a non-finance caller has no finance header; a product
name beginning `=` is neutralised. US-005: the report states its coverage window and that historic
D365 data is header-only.

---

## Epic 6 — Category export (`aug6/w6-category-export`) · api + crm · 5 stories

**Goal:** a spreadsheet round trip that lets the office assign product categories.
**Requires:** E3 (`products.category`), E5 US-001 (the CSV writer) or its own extraction.

| # | Story | Repos |
|---|---|---|
| US-001 | Extract the encoding-sniffing CSV reader to `src/lib/csv-text.js`, no behaviour change | api |
| US-002 | Product sheet export with the empty Category column, `?brand=` parameterised | api |
| US-003 | Re-import: parse, validate, report unmatched rows, write nothing on failure | api |
| US-004 | Apply the validated categories in one transaction | api |
| US-005 | CRM export/import panel | crm |

Key acceptance criteria — US-003: a file saved by Excel on Windows (cp1252) parses; rows match on
a server key, never on order; an unknown category value is reported with its row number.

---

## Epic 7 — Featured (`aug6/w7-featured`) · api + crm + storefront · 7 stories

**Goal:** the office controls what the storefront features.
**Requires:** E1 merged. Only epic permitted to touch atelier-storefront.

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `featured_rank` on brands and collections, seeded from the current hardcoded choice | api |
| US-002 | Admin patch support and the whole-list reorder endpoints | api |
| US-003 | Public read-model ordering, respecting the trade-only gate | api |
| US-004 | Seed test asserting `featured_rank` survives a reseed | api |
| US-005 | CRM featured panel with ordering, plus the pure ordering module | crm |
| US-006 | Storefront homepage reads featured instead of the hardcoded slug arrays | store |
| US-007 | Storefront brands page "In focus" reads featured; artwork fallback chain | store |

Key acceptance criteria — US-001: the seeding UPDATE matches on `(brand_slug, slug)` pairs, and a
test with two houses sharing a collection slug proves only the intended one is featured. US-002:
an unknown slug returns 422 naming it. US-006: a featured collection with no artwork renders the
fallback, not a broken image.

---

## Epic 8 — Colour files (`aug6/w8-colour-files`) · api only · 6 stories

**Goal:** import the supplier colour files into the colourway catalogue.
**Requires:** E10 Pricing template merged — the rate output uses its column shape.

| # | Story | Repos |
|---|---|---|
| US-001 | Adapter registry and the shared row-extraction harness over `scripts/lib/` | api |
| US-002 | Adapters for the single-sheet, single-brand files | api |
| US-003 | Adapters for the multi-sheet and multi-brand files | api |
| US-004 | Normalised colourway output, loud failure, per-file summary report | api |
| US-005 | Rates extracted as a secondary output in the pricing-template shape | api |
| US-006 | Importer landing colourways into products/colourways, idempotent | api |

Key acceptance criteria — US-001: a header row is located by matching labels, never by a fixed
index. US-004: any unmappable row aborts the file with a `file:sheet:row` list and writes nothing;
the PDF is reported as unsupported, not silently skipped. US-006: the supplier colour code is never
joined to `price_list_items.code`; re-running changes nothing.

---

## Epic 9 — Sample scanner spike (`aug6/w9-scanner-spike`) · docs only · 3 stories

**Goal:** a decision, not an implementation. **Do not run under Ralph** — a research task has no
gates, so a loop with nothing to verify against is the wrong instrument. One supervised session.

| # | Story | Deliverable |
|---|---|---|
| US-001 | Options matrix: off-the-shelf scanner apps, PWA (`BarcodeDetector`/`getUserMedia`), native | `research-sample-scanner.md` |
| US-002 | Recommendation with the conditions under which it holds, and cost/ops implications | same |
| US-003 | ADR appended to `architecture.md` | `architecture.md` |

Must account for the existing `SampleScanner.jsx` phone-frame preview and Epic 4's
`GET /admin/samples/by-barcode/:barcode`.

---

## Epic 10 — Pricing template (`aug6/w10-pricing-template`) · api only · 6 stories

**Goal:** one universal pricing template for every supplier going forward. v2 is a strict superset
of the existing 14 columns, in the same order, with new columns appended — that is what lets it be
universal without breaking a single existing drop.
**Requires:** nothing. Runs in Wave 1 alongside E1; footprints are disjoint.
**Blocks:** E8 (its rate output is emitted in this template's shape).

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `brand_name`, `pattern_match`, `duty_percent`, `template_version`; widen the class checks | api |
| US-002 | Template registry, with v1's mapper moved verbatim | api |
| US-003 | v2 mapping and the omit-on-v1 rule | api |
| US-004 | Importer accepts the v2 fields | api |
| US-005 | Shared vocabulary module, replacing three hand-copied lists | api |
| US-006 | Byte-pin unit test and regeneration tripwire | api |

Key acceptance criteria — **the header row is the version**: no version column, no preamble line.
A version column can be misdeclared by deleting a column; a header mismatch fails loudly.
**v2-only fields are omitted entirely on v1 rows, never written as null** — nulls would grow all
19.5k committed records and make the next regeneration a total diff. `template_version` must use
`COALESCE`, because `unnest` binds an explicit NULL for a missing key and that defeats the column
DEFAULT. `npm run convert:pricing` must still produce a byte-identical `price-lists.json`.

`duty_class` and `freight_class` widen to a single uppercase letter: today's sets encode a guess
about a broker table nobody has, so the first `B` would reject the client's own file as a bug in
ours. No placeholder duty or freight *value* is written anywhere.

---

## File ownership across concurrent epics

Wave 2 runs E2, E3 and E7 together. Ownership is exclusive:

| | E2 CRUD | E3 Suppliers | E7 Featured |
|---|---|---|---|
| api migrations | none | `*suppliers*`, `*product-category*` | `*featured*` |
| api routes | `admin-catalogue.js`, `admin-inventory.js`, `admin-orders.js`, `admin-price-lists.js`, `shipping.js` | new `admin-suppliers.js` | `catalogue.js` + the featured endpoints only |
| api modules | `src/catalogue/admin-products.js`, `src/inventory/` | `src/suppliers/` | `src/catalogue/brands.js`, `collections.js` |
| crm screens | `AdminProducts`, `AdminStock`, `AdminOrders`, `AdminCollections`, `AdminShipping` | `AdminSuppliers` | `AdminBrands` |
| storefront | none | none | all |

`src/catalogue/admin-brands.js` is touched by E2 (delete) and E7 (featured columns). **E2 owns the
file**; E7's whitelist additions land as an E2 story (US-001 includes the `featured_rank` column
names in the update whitelist, guarded by E7's tests). Resolved here, not at merge time.
