# PRD — Atelier platform, "August 6th updates"

**Date:** 2026-08-06
**Status:** draft for review
**Repos:** atelier-api, atelier-crm, atelier-storefront
**Integration branch:** `august-6th-updates` (all three repos)

---

## 1. Overview

The CRM is a back-office application over `atelier-api`, but only 8 of its 45 screens write to the
database. Products, houses, stock, supplier rates, web orders, trade accounts and users have live
create and edit; everything else is either a read-only Dynamics 365 mirror or a localStorage demo.
Suppliers and samples have no tables at all. Reporting is entirely static fixtures. And nothing in
the product can delete a row — the API has exactly one `DELETE` route in the whole codebase.

This change set closes those gaps so the CRM becomes the system of record Atelier runs on, rather
than a viewer over one.

## 2. Goals

1. Every dataset the CRM displays supports add, update and delete.
2. Deleting is safe: a row with commercial history can never be destroyed silently.
3. Reports answer real questions from real data, filterable before export.
4. Suppliers become first-class and linkable to brands, unblocking product categorisation.
5. Samples move off demo fixtures onto a real register a scanner can drive.
6. The office controls what the storefront features, without a developer.
7. Supplier colour files import into the catalogue.
8. One pricing template serves every supplier, versioned so old drops keep working.

## 3. Non-goals

- Migrating live D365 operations. Atelier runs on D365 until cutover; the staging import must
  stay re-runnable.
- Historic product-grain sales reporting (see FR-55 constraint).
- Xero integration of any kind (standing constraint FR-8).
- Building a sample scanner application. This round produces a recommendation only.
- Exposing supplier cost data to any client-facing surface.

## 4. Users

- **Back office (`backoffice`)** — the primary user. Runs the catalogue, orders, stock, samples.
- **Director (`director`)** — back office plus finance visibility and bulk legacy import.
- **Trade client (`trade`, approved)** — unchanged by this work except where noted.
- **Anonymous visitor** — storefront only; sees the featured ordering.

## 5. Functional requirements

Numbered in reserved blocks so late additions do not renumber.

### W1 Foundations — FR-1…FR-9
- **FR-1** One shared lifecycle module in the API owns archive and delete for every entity,
  replacing the eight duplicated `setXArchived` helpers.
- **FR-2** `deleteOrExplain(pool, entity, id)` attempts a real delete inside a transaction and
  returns a structured result, never throwing the 409.
- **FR-3** A blocked delete returns **409** listing each blocking relation and its count, plus
  whether archiving is available instead.
- **FR-4** The entity name is always a literal supplied at route registration; there is never a
  route whose path parameter selects a table.
- **FR-5** The CRM gains a shared CRUD kit: list hook, pagination, confirm dialog, delete flow.
- **FR-6** Pagination behaviour is correct by construction: filters reset the page to 1, and
  emptying the last page steps back.
- **FR-7** A blocked delete is explained in place in the dialog, offering "Archive instead".
- **FR-8** `apiDelete` exists in the CRM API client, so a DELETE carries no body and no JSON
  content-type.
- **FR-9** Each repo gains CI running its gates on pull requests into `august-6th-updates`.

### W2 CRUD completion — FR-10…FR-29
- **FR-10…FR-18** DELETE endpoints for brand, collection, product, colourway, inventory row,
  price-list item, user, shipping rate and contact enquiry, each with its declared blocker set.
- **FR-19** Orders, order lines, webhook events, all `legacy_*` tables, trade applications and
  trade accounts are never hard-deletable.
- **FR-20** Deleting a user is refused when they have orders, a trade application or a contact
  enquiry; a user may never delete themselves.
- **FR-21** Deleting the last shipping tier for a zone is refused — an empty zone fails every
  checkout in it.
- **FR-22…FR-26** Missing read endpoints: `GET /admin/brands/:id`, `GET /admin/collections/:id`,
  `GET /admin/colourways` (paginated), `GET /admin/colourways/:id`,
  `GET /admin/price-list-items/:id`.
- **FR-27** Full shipping-rate CRUD, with `zone` and `threshold_qty` create-only.
- **FR-28** `POST /admin/inventory` derives `unit` from the product type; it is never accepted
  from the client.
- **FR-29** Collections get their own CRM screen, extracted from the houses screen.

### W3 Suppliers — FR-30…FR-39
- **FR-30** A `suppliers` table with name, slug, invoicing currency, agent, incoterm, PO email
  and D365 token.
- **FR-31** `brands.supplier_id` links a house to its supplier.
- **FR-32** Supplier commercial terms live in their own tables, never on `brands`.
- **FR-33** `supplier_aliases` absorbs the converter's existing name overrides.
- **FR-34** `price_list_items` gains a nullable `supplier_id` beside its existing free-text name.
- **FR-35** Backfill from the distinct price-list supplier names and the seed supplier data.
- **FR-36** Full supplier CRUD API and a CRM screen.
- **FR-37** Deleting a supplier is refused while brands or price-list items reference it.
- **FR-38** `products.category` with the four-value vocabulary shared with `price_list_items.category`.
- **FR-39** `category` is filterable on the public catalogue listing.

### W4 Samples — FR-40…FR-54
- **FR-40** A `samples` register keyed by barcode, separate from `inventory`.
- **FR-41** `sample_loans` records every loan append-only, with a snapshotted holder name.
- **FR-42** At most one open loan per sample, enforced by a partial unique index.
- **FR-43** `showrooms` and `sample_orders` model showroom stocking through its own lifecycle.
- **FR-44** Check-out and check-in are verb routes writing two tables in one transaction.
- **FR-45** `GET /admin/samples/by-barcode/:barcode` returns one deterministic 200 or 404.
- **FR-46** Overdue is derived at read time, never stored.
- **FR-47** No sample route touches `inventory` quantities.
- **FR-48** No column is added to any `legacy_*` table.
- **FR-49** `legacy_cuttings.comments` is never copied into the new tables.
- **FR-50…FR-53** CRM screens for the register, showrooms and sample orders; the scanner screen
  wired to the real endpoints.
- **FR-54** Retired demo routes redirect rather than falling through to the dashboard.

### W5 Reporting — FR-55…FR-69
- **FR-55** Product performance by brand, computed from live orders and order lines.
  *Constraint: the D365 exports are header-only, so no historic sale is attributable to a
  product. Coverage is stated on the report.*
- **FR-56** The revenue population is a filter defaulting to `status IN ('paid','shipped')`.
- **FR-57** Request-kind orders contribute quantity at zero value, with an unpriced-line count.
- **FR-58…FR-62** Filters: date range, brand, product type, collection, order kind, status —
  whitelisted names, parameterised values.
- **FR-63** The same filter set feeds the on-screen table and the export.
- **FR-64** Export is server-side and neutralises spreadsheet formula lead-ins.
- **FR-65** Finance columns are removed from the payload for callers without finance access —
  deleted, not nulled.
- **FR-66** A report that is finance end-to-end answers 403 with a reason, never an empty table.
- **FR-67** `GET /auth/me` exposes derived report access; the CRM stops assuming every staff login
  is a director.
- **FR-68** Report routes are rate-limited, exports more tightly.
- **FR-69** Own-sales scoping is explicitly out of scope and documented as blocked.

### W6 Category export — FR-70…FR-79
- **FR-70** Export a brand's products as a spreadsheet with an empty Category column.
- **FR-71** Default to Atelier Textiles NZ; accept any brand via a parameter.
- **FR-72** Re-import applies the filled categories.
- **FR-73** Re-import decodes Excel's cp1252 output through the existing encoding sniff.
- **FR-74** Rows match on a stable server key, never on row order.
- **FR-75…FR-79** Validation, error reporting, and a documented header contract making it a
  reusable template.

### W7 Featured — FR-80…FR-89
- **FR-80** `featured_rank` on brands and collections; null means not featured.
- **FR-81** Ordering is deterministic without a unique constraint.
- **FR-82** The migration seeds the storefront's current hand-picked choice, so nothing moves
  on deploy.
- **FR-83** Featured survives a reseed.
- **FR-84** Whole-list reorder endpoints; the collections one takes brand+slug pairs.
- **FR-85** An unknown slug is a 422 naming it, never a silent drop.
- **FR-86** A CRM panel sets and orders the featured lists.
- **FR-87** The storefront reads featured instead of hardcoded slug arrays.
- **FR-88** A featured item with no artwork degrades through a defined fallback chain.
- **FR-89** Featuring never leaves a hole for a viewer who cannot see a trade-only house.

### W8 Colour files — FR-90…FR-99
- **FR-90** Import the supplier colour files into the colourway catalogue.
- **FR-91** Per-supplier adapters declare sheet, header row and column map.
- **FR-92** Extract brand, design, supplier colour code and colour name.
- **FR-93** Extract 2026 rates as a secondary output into the pricing template.
- **FR-94** The supplier colour code is never joined to the price-list code.
- **FR-95** Failure is loud and writes nothing.
- **FR-96** The source directory is treated as read-only.
- **FR-97…FR-99** Reporting of unmapped rows, unsupported files and per-file summaries.

### W10 Pricing template — FR-105…FR-114
- **FR-105** One universal template, v2, a strict superset of the existing 14 columns in the same order.
- **FR-106** Appends Supplier, Brand, Pattern Match and Duty Percent.
- **FR-107** A Supplier cell wins over the filename, removing the pipeline's most fragile input.
- **FR-108** Brand is text and deliberately not a foreign key.
- **FR-109** Pattern Match unjams the pattern text currently embedded in `vertical_repeat`.
- **FR-110** The header row is the version; v1 files import forever and v3 costs one registry entry.
- **FR-111** `duty_class`/`freight_class` accept any single uppercase letter, raw and uninterpreted.
  No placeholder duty or freight value is written.
- **FR-112** v2-only fields are omitted on v1 rows, so the committed 19.5k-row JSON stays byte-identical.
- **FR-113** Enum vocabularies live in one module consumed by the converter, seed, routes and migration.
- **FR-114** A unit-level byte pin and a regeneration tripwire catch converter drift without
  regenerating 8 MB.

### W9 Scanner spike — FR-100…FR-104
- **FR-100** A written comparison of off-the-shelf, PWA and native scanning options.
- **FR-101** A recommendation with the conditions under which it holds.
- **FR-102** Account for the existing scanner screen and the by-barcode endpoint.
- **FR-103** Cost and operational implications.
- **FR-104** Recorded as an architecture decision record.

## 6. Success metrics

- Every dataset in the CRM navigation supports create, update and delete.
- No delete can destroy a row referenced by commercial history; each refusal names why.
- Product performance by brand is answerable from the CRM with filters, and exports match the
  on-screen figures exactly.
- The office can change what the storefront features without a code change.
- All gates green in all three repos; no story merged without a review record.

## 7. Open questions — owed by the client

| Ref | Question | Consequence while open |
|---|---|---|
| — | D365 sales-order and invoice **line items** | No historic product-grain revenue; W5 covers live orders only |
| A2 | What counts as a sale | W5 ships `paid`+`shipped` as a filterable default |
| A6 | Salesperson vs owner vs account holder | Own-sales report scoping cannot be built |
| A10 | The broker's duty table | `duty_class` stays a raw uninterpreted letter |
| — | Freight class → rate table | Same |
| — | Definitive product field list (Charlotte) | Pricing template stays additive and header-versioned |
| — | Re-export of stock items / item locations with a **code** column | Only 52% of stock items resolve to one price row |
| — | `de Le Cuona March 2026 pricelist.pdf` | No extraction path; out of scope |
