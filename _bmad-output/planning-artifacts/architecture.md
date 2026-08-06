# Architecture — "August 6th updates"

Companion to `prd.md`. Sections are referenced by name from the Ralph loop prompts, so an
executing agent reads only what its story names.

---

## Shared lifecycle module

**Location:** `src/lifecycle/` in atelier-api. Replaces eight duplicated `setXArchived` helpers.

**Registry.** One frozen entry per entity declaring `table`, `idColumn`, `archivable`, an optional
`guard`, and a list of dependency probes `{ relation, label, sql }`. Registry keys are literals
used at route registration — never a path parameter.

**`deleteOrExplain(pool, entityName, id, ctx)`** returns a result, never throws the 409:

```js
{ deleted: true, entity, id }
| { deleted: false, status: 404|403|409, error, message,
    blockers: [{ relation, label, count, capped }], archivable }
```

Fastify's error serializer emits `{ statusCode, error, message }` and drops custom properties, so
a thrown error cannot carry `blockers`. A `replyDelete(reply, result)` helper keeps handlers thin.
Success is **200 `{ deleted: { entity, id } }`**, not 204 — every route here returns a JSON
envelope and the CRM's `useMutation` names the result in its toast.

**Transaction order:**

```
BEGIN
  SELECT <id> FROM <table> WHERE <id> = $1 FOR UPDATE   (A)  0 rows -> 404
  entity.guard?.(client, id, ctx)                       (B)  non-null -> that status
  one probe query covering all relations                (C)  any count > 0 -> 409
  DELETE FROM <table> WHERE <id> = $1                   (D)
COMMIT
catch 23503 -> map error.constraint through constraintBlockers -> 409
```

**Probe first; the 23503 catch is only a backstop.** Nine of twelve FK edges are CASCADE or
SET NULL and never raise. `DELETE FROM brands WHERE id = <a stocked house>` raises nothing and
destroys its collections, products, colourways and inventory, returning 200. SET NULL is worse
because the damage is invisible: deleting a user SET NULLs their whole order history into
anonymous guest orders with no `guest_email`, and nothing is logged. The catch still earns its
place for the grandchild window below, and as an honest 500-preventer if someone adds a RESTRICT
FK and forgets the registry entry.

**Why probe-then-delete in one transaction is not a TOCTOU race**, at READ COMMITTED:

- The parent row is locked `FOR UPDATE` before the probes run. Postgres takes `FOR KEY SHARE` on a
  referenced row whenever a transaction inserts a row pointing at it, and `FOR KEY SHARE` conflicts
  with exactly one mode — `FOR UPDATE`. It must **not** be `FOR NO KEY UPDATE`, which does not
  conflict and would leave the window wide open.
- Probes and the DELETE share one transaction, so the DELETE sees everything the probes saw.
- The one window the parent lock does not cover is a **grandchild** (an order line inserted against
  an existing colourway of the brand being deleted). Postgres closes it anyway: the inserter takes
  `FOR KEY SHARE` on the colourway and the cascade's delete of that colourway takes a conflicting
  lock, so the two serialise. If the insert wins, the RESTRICT FK turns the cascade into 23503 and
  the catch produces the same 409 shape.
- No SERIALIZABLE — it would add 40001 retries nothing in this codebase handles.

**Probes ignore `archived_at`.** An archived product still blocks its house; archiving is not
deletion, and skipping archived rows would let a delete quietly destroy the archive. Each probe is
`LIMIT 101` and reports `{ count: 100, capped: true }` rather than counting 19,000 rows to answer
a question whose answer is already "no".

**`setArchived(db, entityName, id, archived)`** replaces the duplicated UPDATE fragment. The eight
callers keep a thin wrapper each, because each returns a different frozen shape; what was actually
duplicated is the `now()`/`NULL` fragment, the 404 and the RETURNING projection. The order state
machine keeps its own `withOrderTxn` wrapper and terminal-state guard — do not force it through the
generic path.

**Invariants to assert in tests:** every probe matches `/^SELECT 1 FROM [a-z_ ]/` with exactly one
`$1`; every relation name matches `/^[a-z][a-z0-9_]*$/`; every declared table and id column exists
in `information_schema.columns`.

---

## Delete policy

| Entity | Blockers → 409 | Guard |
|---|---|---|
| brand | products, collections | — |
| collection | products (FK is SET NULL — without the probe this silently uncollects them) | — |
| product | order lines via colourways, samples, non-zero inventory | — |
| colourway | order lines (RESTRICT), samples, non-zero inventory | — |
| inventory row | — | `qty_reserved > 0` |
| price-list item | — | — (copy must warn a re-import recreates it) |
| user | orders, trade applications, contact enquiries | 403 self-delete |
| supplier | brands, price-list items | — |
| shipping rate | — | 409 last tier for zone |
| sample | sample loans | — |
| sample order | — | 409 unless requested/cancelled |
| sample loan | — | 409 when still open |
| contact enquiry | — | — |

**Never hard-deletable:** orders (CASCADE destroys the lines; the delete does not release
`qty_reserved`, permanently corrupting stock; and the row carries `xero_invoice_ref` and
`stripe_session_id`) · order lines (mutate only through the order PATCH, which adjusts the
reservation by the delta) · webhook events (the Stripe idempotency ledger — deleting a row lets a
replay create a second paid order) · every `legacy_*` table (a delete is undone by the next import,
so the operator sees the row reappear and reports a bug) · trade applications (their `user_id` is
SET NULL precisely so they outlive the account) · trade accounts.

---

## CRM CRUD kit

Five files under `src/admin/`. Rules live in `.js` with `.test.js` siblings; `.jsx` holds zero
rules, because this repo has no jsdom.

| File | Surface |
|---|---|
| `list.js` | `buildListQuery`, `pageCount`, `clampPage`, `readList` — pure |
| `useAdminList.js` | `{ path, key, limit, filters }` → `{ rows, total, page, setPage, totalPages, status, error, reload }` |
| `Pagination.jsx` | `{ page, totalPages, total, unit, onPage, busy }`; null when `totalPages <= 1` |
| `ConfirmDialog.jsx` | `{ open, title, body, lines, confirmLabel, secondaryLabel, onConfirm, onSecondary, onCancel, busy, error }` |
| `deleteFlow.js` + `useCrudScreen.js` | `describeBlockers(error, opts)` and the ask → attempt → explain composition |

`buildListQuery` drops null, undefined and empty-string values. That is load-bearing: an "All"
select must not become `role=`, which the API's enum answers with a 400 that kills the whole list
rather than one filter.

`useAdminList` depends on the **serialised query string**, not the `filters` object — a screen
passing an inline object literal otherwise refetches on every render. It resets `page` to 1 when
filters change, and steps back a page when a delete empties the last one.

**No pre-flight "can I delete this" GET.** It is a second round trip that races the delete, and the
API already answers authoritatively in the 409. On 409 the dialog does not close; it re-renders
with the blocker lines and an "Archive instead" button. This mirrors the API's own rule that
duplicates are detected by the database, never pre-checked.

`apiSend('DELETE', path)` would set `Content-Type: application/json` with an empty body, which
Fastify answers with 400 `FST_ERR_CTP_EMPTY_JSON_BODY`. Add `apiDelete` to `src/lib/api.js`.

---

## Suppliers domain

`suppliers` (name unique, slug, short code, `d365_token`, country, invoicing currency, agent,
incoterm, PO email, discount method, archived_at) · `supplier_aliases` (unique on
`lower(btrim(alias))`) · `brands.supplier_id` RESTRICT · `price_list_items.supplier_id` SET NULL ·
`supplier_brand_terms` (per-brand discount, discount chain, markup) · `supplier_discount_tiers`.

**Currency is the supplier's invoicing currency, not the country's** — Jim Thompson is Thailand
but invoices USD.

**Discount chains are multiplicative.** A `{0.4, 0.4}` chain means ×0.36, not −80%. Model it as an
array, never as a summed percentage.

**No cost column on `brands`.** `src/catalogue/brands.js` serves brand rows to anonymous visitors
and `test/price-list-exposure.test.js` asserts no client-facing key matches the cost vocabulary.
`brands` gains exactly one integer.

`price_list_items.supplier` free text stays — it is part of the `(supplier, category, code)` unique
key, so removing it would rewrite the upsert target. `supplier_id` is added beside it and
backfilled.

**`products.category`** — `text` with `CHECK (category IN ('fabric','wallpaper','trimming','accessory'))`,
the exact vocabulary `price_list_items.category` already uses, so the catalogue and the rate ledger
become joinable on one axis. Same shape as the existing `product_type`. Widening it later is a
one-line migration.

---

## Samples domain

Two independent lifecycles, both built:

- **Loan register** — `samples` (barcode unique, colourway RESTRICT, supplier SET NULL, showroom
  SET NULL, type, location, status) + `sample_loans` (sample RESTRICT, snapshotted `holder_name`,
  `out_at`, `due_back_at`, `returned_at`).
- **Showroom stocking** — `showrooms` + `sample_orders` advancing
  `requested → ordered → in_transit → received → displayed | cancelled`.

Invariants, each with a test:

- **Outside the `legacy_*` namespace, deliberately** — the legacy import upserts every mapped
  column to EXCLUDED, so state stored there is destroyed by the next import.
- **`legacy_cuttings.comments` is never copied in.**
- **Samples are not inventory** — no sample route may touch `qty_available`/`qty_reserved`, or the
  order state machine's reservation arithmetic breaks silently.
- **One open loan per sample is a partial unique index**, not application code. The scanner is a
  concurrent device; two staff scanning "out" would otherwise open two loans and the register would
  report the wrong holder forever.
- **`holder_name` is a snapshot**, so loan history stays readable after a trade account is unlinked
  or renamed.
- **Overdue is derived**, never stored — a stored boolean goes stale the moment nobody runs the job.

Check-out and check-in are verb routes, not a status PATCH: each writes two tables and must be one
transaction, through a `withSampleTxn` mirroring the existing `withOrderTxn`. "Already out" is a
caught 23505 on the partial index, never a pre-check.

---

## Reporting

**Revenue population** defaults to `status IN ('paid','shipped')`, all kinds, exposed as a filter.
Only checkout orders carry money — the webhook inserts them `paid` with prices re-resolved from
`retail_price_cents`. Request-kind lines are created at `unit_price_cents = 0` and nothing ever
fills them in, so they contribute quantity and zero value, with a per-row unpriced-line count.
`confirmed` is excluded because on this platform confirmation is a Xero reference typed by a human,
carrying no amount. When the client settles A2 it is a default change in one frozen constant.

**Files:** `src/reports/{access,filters,revenue-lines,product-performance,stock,not-invoiced,catalogue}.js`
plus `src/routes/admin-reports.js`. `filters.js` is pure and unit-tested with no database.

**A `scope` CTE is the future-proofing seam** — when D365 line data arrives it is unioned in there,
not by rewriting each report.

**Masking is server-side**, before either the table or the CSV exists. Finance columns are removed
from `columns`, from every row and from `totals` — deleted, not nulled, so the JSON carries no key
name to grep for. `meta.masked_columns` carries labels only. A report that is finance end-to-end
answers 403 with a reason, never 200 with an empty table, which is indistinguishable from "no data".

**The CRM currently maps every staff login to full director access**, so its masking has never
fired. `GET /auth/me` gains a derived `report_access`, backed by `users.can_view_finance`
(default false, backfilled true for directors), and the CRM prefers it over the demo capability map.

**Export is server-side** — the CRM's CSV writer quotes fields but does not neutralise `= + - @`
lead-ins, a client-side export would silently ship only the current page, and one SQL means table
and file cannot disagree about what revenue means.

---

## Featured ordering

`featured_rank integer NULL` on `brands` and `collections`, with a positive check. Null means not
featured and sorts naturally with `NULLS LAST`. Not a boolean: the homepage needs three hero slides
*in a chosen order*, and a boolean produces a set with no order.

No unique index — `ORDER BY featured_rank ASC NULLS LAST, name ASC, id ASC` is deterministic even
with duplicate ranks, and a partial unique index would make every reorder step a potential 409.

**The database owns the order; the page owns the composition.** Do not encode "ranks 1–3 are the
hero" in the schema.

**Collection slugs are unique per brand, never globally.** Every collection lookup, the seeding
UPDATE and the reorder endpoint body must use the `(brand_slug, slug)` pair, or another house's
identically-slugged collection is featured instead.

`featured_rank` stays out of the seed's `ON CONFLICT DO UPDATE` set lists, so an office decision
survives every reseed — the same posture as `trade_only`, inventory and shipping rates.

**Storefront asymmetry, and it is real:** the homepage is `prerender = true`, so featured
collections appear at the next build, while `/brands` is `prerender = false` and updates
immediately. Surface it as a standing note in the CRM panel rather than letting it read as a bug.
Banner art is committed and keyed to the old hardcoded slugs, so a newly featured collection needs
a defined fallback chain.

---

## Pricing template

**v2 is a strict superset of the existing 14 columns, in the same order, with new columns
appended.** That is what lets it be universal without breaking a single existing drop.

Appended: `Supplier` (wins over the filename, removing the pipeline's most fragile input),
`Brand` (stored as text, deliberately not FK'd — supplier names do not reliably match the 41
houses and a broken FK would fail whole imports over a naming difference), `Pattern Match` (which
unjams the pattern text currently embedded in `vertical_repeat`), and `Duty Percent` (the seam for
the owed broker table — no placeholder is written).

**The header row is the version.** No version column, no preamble line — a version column can be
misdeclared by deleting a column, whereas a header mismatch fails loudly. A registry of
`{ version, header, map }` entries; first exact match wins; v3 is a fourth entry and v1 files keep
importing forever.

**Avoiding a spurious 8 MB diff:** `mapV1` is the current normaliser *moved*, not rewritten, so v1
output stays byte-for-byte identical. v2-only fields are **omitted entirely on v1 rows, never
written as null** — the importer already coalesces a missing key to NULL, so no importer change is
needed, but the reason must be commented or someone will "tidy" it into explicit nulls. Regenerating
the committed JSON happens in its own commit touching only that file.

---

## Colour files

**Per-supplier adapters, not one universal parser.** 18 spreadsheets, 18 layouts: some carry
several brands, some have ten sheets, headers sit on different rows, and one file is a PDF with no
extraction path. A registry keyed by filename prefix declares sheet(s), header row index and column
map. Reuse `scripts/lib/{zip,xml,xlsx,text}.js`. Fail loudly with a file:sheet:row list and write
nothing, matching the existing converter's posture.

**Primary output is the colourway catalogue** — brand, design, supplier colour code, colour name.
That is what the D365 item-code logic needs. Rates are a secondary output into the pricing template.

**Never join the supplier colour code to `price_list_items.code`** — the D365 item code's numeric
part is the supplier's colour code and does not match the price-list code.

The source directory is the client's only copy and is mounted read-only.

---

## ADR 001 — Sample scanning uses a keyboard-wedge scanner, not a camera

**Date:** 2026-08-06 · **Status:** proposed, awaiting confirmation of the showroom device
**Full analysis:** `research-sample-scanner.md`

**Context.** W4 gives the sample register `GET /admin/samples/by-barcode/:barcode` plus check-out and
check-in verb routes, so the integration point is settled. What was not settled is what performs the
scan. The CRM's `/sample-scanner` screen is a phone-frame preview that writes nothing.

The decisive constraint: **`BarcodeDetector` is not implemented on iOS.** Safari does not provide it,
and every iOS browser is WebKit underneath, so Chrome and Firefox on an iPhone do not either. A web
app calling it fails on every iPhone and iPad, and fails silently — the constructor is simply absent.
Any browser-camera option therefore requires a WebAssembly decoder, which is a real dependency and
bundle cost, not a footnote.

**Decision.** Use a Bluetooth barcode scanner paired as a keyboard wedge. It types the code into a
focused input followed by Enter — no camera API, no WebAssembly, no app store, no permission prompt,
and it works identically on every device. The existing screen needs only to be pointed at the
endpoint.

**Consequences.**
- Hardware cost of roughly NZ$60–200 per showroom counter, and a label printer is implied but has
  never been specified.
- Scanning is tied to wherever the scanner sits. Shelf-walking with a phone is not supported.
- A camera PWA with a WASM decoder remains available and bolts on beside this, because both paths
  call the same `by-barcode` endpoint. Nothing is wasted by starting here.
- If the showroom devices turn out to be iPads and Atelier later wants camera scanning, the WASM
  dependency is unavoidable — the native API will not appear.

**Open.** The `/sample-scanner` screen refers to a "Dataverse-vs-PWA backend call (§6.1)" as still
open. W4 answers it for this platform — the register lives in Postgres, not Dataverse. If D365 is
still intended to own sample tracking after cutover, W4 must be re-scoped before it is built.
