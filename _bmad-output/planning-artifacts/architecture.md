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

> **Superseded by ADR 002 on 2026-08-12** (`prd-august-12th.md` §4 X2). Kept verbatim, because its
> constraint did not go away — it was paid for. Read ADR 002 next.

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

---

# Architecture — "August 12th updates"

Companion to `prd-august-12th.md` and `epics-august-12th.md`. Everything above is the August 6th
round and stands unchanged; where the two rounds disagree, `prd-august-12th.md` §4 records which
decision won and on what date. Sections here are referenced by name from the Ralph loop prompts on
the same terms as the sections above — an executing agent reads only what its story names.

---

## Purchasing

**Location:** new `src/purchasing/` in atelier-api, behind new `src/routes/admin-purchasing.js`.
Six tables, W13 raising the first four and W14 the last two.

| Table | Holds |
|---|---|
| `purchase_orders` | one supplier, a number issued by a sequence, `status`, dates, who raised it |
| `purchase_order_lines` | colourway, `qty_ordered`, `unit_price numeric(12,4)` in the supplier's currency |
| `purchase_order_line_allocations` | which sales-order line a purchase-order line covers, **and how much of it** |
| `purchase_order_receipts` | append-only receipt rows with a signed `qty` and a consignment reference |
| `supplier_invoices` | one supplier's bill across a 2–4 week cycle: total, `freight_amount`, who entered it |
| `supplier_invoice_allocations` | invoice ↔ purchase order, `purchase_order_id` **UNIQUE** |

The invariants, each stated as the rule it has to be enforced as:

- **`supplier_id` is derived from the brand at create and is never accepted from a client.** A
  client-chosen supplier produces no CHECK violation and no error of any kind — it silently
  addresses the purchase order to the wrong house, and the first anyone hears of it is the wrong
  house shipping the goods. **A brand with a NULL `supplier_id` is a 422 naming the brand, and that
  fires on 26 of 41 houses on day one** because `backfill:suppliers` has linked only 15. Schedule
  that; do not discover it.
- **No integer-cents column exists anywhere in purchasing.** Cents is the storefront's money type,
  and a purchase is foreign, fractional and unconverted. `unit_price` is `numeric(12,4)` — exactly
  `price_list_items.wholesale_rate`'s type, which is where the number comes from. Mixing the two
  turns €48.0000 into 48 cents, and nothing in the schema objects.
- **Receipt state is derived, never stored, and `status` holds only what a person did.** Received,
  outstanding and the per-line backorder balance are computed at read time from the receipt rows.
  **`closed` is not `full`:** a purchase order closed short because the supplier discontinued the
  balance is a decision somebody made, not arithmetic, and storing a derived "fully received"
  beside it gives two answers to one question.
- **Over-receipt is legitimate and is never clamped.** Suppliers over-ship rolls. A receipt of 42
  against an order of 40 is a fact about the warehouse, and a clamp destroys it.
- **A receipt is never edited and never deleted; a mistake is a negative row.** Hence
  `CHECK (qty <> 0)`, not `CHECK (qty > 0)`. The ledger then reads as what happened, in order, and
  a reversal is visible instead of being an absence nobody can date.
- **The allocation carries a quantity, because a purchase-order line covering two sales orders is
  the ordinary case.** Without it a 40 m line cannot say 25 m is for SO-411 and 15 m for SO-418,
  and a short delivery has no basis on which to split. **`SUM(allocations.qty) <= qty_ordered` —
  `<=`, not `=`**, because the remainder is a deliberate stock buy.
- **That sum is enforced in the module with the purchase-order line locked `FOR UPDATE`, not by a
  constraint, because an aggregate cannot be a CHECK.** A CHECK sees one row; the rule is over a
  set. The lock is what makes it hold under two concurrent allocations, and it is the same posture
  `withOrderTxn` already takes on the order.
- **A sales-order line may be ordered exactly once, and the database says so** — a partial unique
  index on the allocation's `order_line_id`, never application code. The derivation is exactly what
  two staff run at once at 5pm, so the second run is a caught 23505 answered **409** naming the
  purchase order that already covers the line. Same posture as `sample_loans_open_unique`.
- **`order_lines` is `ON DELETE RESTRICT` from the allocation**, so the order delete gains a fourth
  blocker: an order already ordered from a supplier is no longer a mis-key anyone can delete. The
  lifecycle registry declares the probe, and `test/lifecycle-registry.test.js`'s
  `information_schema` agreement check **fails until it is added** — that is the tripwire working,
  not a broken test.
- **Purchase-order numbers come from a sequence, never `max+1`.** Two facts belong in the office's
  own documentation rather than in a support ticket: the sequence does not reset per year, and a
  rolled-back transaction leaves a gap. **A gap in a purchase-order number is not a missing
  purchase order.**
- **Derivation groups by brand, and one supplier selling two brands correctly produces two purchase
  orders.** That is not a bug to fix later; it is the whole reason consolidated supplier invoicing
  exists as a separate concept.
- **No purchasing route writes any inventory quantity.** `moveReservation` stays the sole writer of
  `qty_reserved`. A second writer breaks the reservation arithmetic silently, and W13, W19 and W20
  can each break it independently — which is why the one-writer assertion is a programme-level test
  and not an epic-level one.
- **A purchase order appears on exactly one supplier invoice**, enforced by `UNIQUE` on the join's
  `purchase_order_id`. A re-attach after a correction double-counts spend in every downstream
  report, with nothing in the data saying which row was the mistake. Attaching twice is a 409
  naming the invoice that holds it; attaching another supplier's purchase order is a 422.
- **The variance between an invoice total and the summed line cost is reported on screen and never
  written.** See ADR 006 — the invoice's `freight_amount` is the *actual* freight for a
  consignment, the rate table is a forward estimate, and merging them is the failure.
- **No purchasing field reaches a client-facing response**, asserted by extending
  `test/price-list-exposure.test.js` rather than by adding a second exposure test.

**Sample cost splits in two and only the standalone half ships in this round.**
`samples.unit_cost numeric(12,4)` nullable, with `CHECK (unit_cost IS NULL OR unit_cost >= 0)` —
deliberately not `> 0` the way `price_list_items` does it, because a free hanger is normal. **NULL
and 0 are different facts:** NULL is "nobody recorded a cost", 0 is "free, and we know it".
`Number(null)` is 0, so every read needs `value == null ? null : Number(value)` or a sample-value
report counts every unpriced hanger as a gift. The receipting path that would auto-create samples
from the bottom of a purchase order is blocked on a decision rather than on code — three hangers is
three physical objects, three rows and three barcodes, and neither the barcode-minting policy nor
the label printer exists (F17).

---

## Xero

**Location:** new `src/xero/` behind new `src/routes/admin-xero.js`. Two tables and a set of
id-mapping columns on tables that already exist.

| Table / column | Holds |
|---|---|
| `xero_connections` | tenant id, encrypted access and refresh tokens, expiries, `last_error`, who consented |
| `xero_sync_log` | one row per push attempt: entity, local id, `status`, the Xero id, the error |
| `orders.xero_invoice_id` | the Xero GUID — a **new** column, not a repurposing of `xero_invoice_ref` |
| `colourways.xero_item_code` | ships unused, so a later item sync is a data job (ADR 004) |
| contact mapping | on the trade account and on the user; backfilled from `legacy_accounts.xero_contact_id`, 853 of 866 |

**A Xero refresh token rotates on use. This is the bug that kills these integrations, and it is the
one rule in this section that must not be simplified away.** Two concurrent requests that both
refresh with the same token leave one holding a dead credential and the connection unrecoverable
without a human re-consenting. **A single pm2 process does not save you — Fastify is concurrent
inside one process**, and two admin screens open at once is the ordinary case, not the exotic one.

> The refresh runs inside a transaction that takes `SELECT … FOR UPDATE` on the connection row and
> **re-reads the token after acquiring the lock**. The loser of the race then finds a fresh, valid
> token and never calls Xero at all. This is the `withOrderTxn` idiom applied to a credential.

The rest, as rules:

- **Tokens are encrypted at rest** with `aes-256-gcm` under a dedicated `XERO_TOKEN_KEY`. Node's
  `crypto` does this in about fifteen lines with no dependency. The decisive local fact is not
  theoretical: this working tree holds a database archive and three SQL dumps under `incoming/`,
  and a database dump must not hand over the client's accounting system.
- **`xero_connections` is never exposed by any route.** Not an AdminJS resource, not in any read
  model, no `SELECT *` anywhere near it. Enforced by a source scan plus a response-body scan, not
  by everyone remembering.
- **The local sync row commits BEFORE the Xero call, and a Xero failure never rolls the order
  back.** This deliberately inverts the Stripe webhook's all-in-one-transaction rule — see
  `src/webhooks/CLAUDE.md`, which is right for its own case — and it inverts for a stated reason:
  **Stripe's event is replayable by Stripe; a Xero invoice is not replayable by us.** An order with
  no invoice is recoverable by pushing again. An invoice with no order is a bill to a client for
  something the system cannot describe.
- **A `pending` sync row is never blind-retried — it queries Xero first.** The failure that costs
  real money is a call that succeeded at Xero and failed to record locally, after which a null
  invoice id reads as "not pushed" and the retry raises a second invoice against the same client.
- **A push is refused when the order already carries a Xero invoice id**, or a double-click bills
  the client twice.
- **`orders.xero_invoice_ref` keeps its meaning and is never repurposed as the id.** A staff-typed
  reference and a Xero GUID are different facts, and overloading the column loses the manual
  history on the first push.
- **The Xero contact is the trade account where one exists and the user otherwise.** Xero bills a
  company; billing the individual designer rather than the practice is wrong for a trade business.
- **The 60-day refresh-token cliff is an operational fact, not a bug.** A refresh token expires 60
  days after last use, and with no scheduler (below) nothing keeps it warm — an integration idle
  over a quiet December is dead in January, and only a director re-consenting fixes it.
  `GET /admin/xero/status` and a visible `last_error` are what turn a week of missing invoices into
  a five-minute reconnect.
- **The Xero client is injected at `buildApp`**, exactly as the Stripe and mail transports are, and
  a capture double proves no test ever reaches Xero.
- **No invoice email template is added.** Xero sends the invoice; two systems mailing the same
  invoice is the failure mode, and it is the client's own instruction.

**The first spike question is worth more than the rest of this section combined: is Atelier on a
Xero plan offering a Custom Connection?** Machine-to-machine, single-tenant, `client_credentials`
— no user consent, no rotating refresh token, no 60-day cliff. If the answer is yes, most of the
token store and the whole connect/callback surface disappear. Ask before building anything (F9).

---

## Scheduling — the runner that is not introduced

**No scheduler, cron, worker or queue is added by this round, and that is a design decision rather
than an omission.** Two requirements that sound compatible are not: *"editable before send"* and
*"sent automatically at 2am"* cannot both be true of the same message, and the client asked for the
first. So an overdue-sample reminder is a **staff action off a work queue** — the queue is a read,
the send is a click, and the template is editable in between.

This keeps a property the platform already has and should keep on purpose: there is no background
process to monitor, no dead-letter state to reason about, and nothing that fails silently at 2am
while everyone is asleep. Two consequences follow and are stated rather than discovered:

- **Xero payment status stays out of scope.** There is no Xero Payments webhook, so it is polled,
  and polling is the worker this section refuses. Recorded as blocked (FR-184), not as missing.
- **Nothing keeps the Xero refresh token warm**, which is what makes the 60-day cliff above an
  operational fact the status endpoint has to surface.

If a runner is ever introduced it arrives with its own ADR and its own operational story, and the
first thing it must not do is take over sending a message a human was promised the chance to edit.

---

## Freight and the pricing waterfall

**The grain is unresolved, and this section does not pretend otherwise.** Two measurements exist,
both correct, and they answer different questions. Reading either one as the answer to the other is
what would put a wrong rate into the ledger.

| Measurement | The question it answers | Result |
|---|---|---|
| Letter-collision analysis over all 19,514 rows of the committed `src/seed/data/price-lists.json` | *Does product category explain the A–E freight letters?* | Mostly yes. Invoicing supplier × category: 43 groups, **8 ambiguous**, and **7 of the 8 are `wallpaper`** (the eighth is Hamam accessory). Supplier as filed: 40 groups, 28 ambiguous. **`product_range` adds exactly nothing** — 74 groups become 74 and the same 15 collide. |
| The client's own parameter table, `Xero Range.xlsx`, 58 rows, staged as `legacy_tracking_options` | *What does the incumbent's engine actually key on?* | **Range.** `Name` hits `legacy_product_prices.range_name` on **48 of 58 rows covering 19,256 of 19,327 priced rows — 99.6%**, and `price_list_items.product_range` on 40 of 58 covering 19,450 of 19,514. **`Supplier` is not a key** — 8 of 28 match a live supplier, `supplier_aliases` is empty and `short_code`/`d365_token` are NULL on all 40 rows. It is a lookup rendered as a display name. |

The first measured letter *distribution*; the second **is the rate table**. The client is not wrong
to have asked for supplier level and her reason is good — Colefax Group ships four houses
fortnightly, so its per-unit freight is structurally lower than a house they buy 5 m from. What the
approved plan did not anticipate is that **the migration source and the target grain differ**.

**The letters are not decodable from the parameter table, but they are recoverable from the
corpus.** One `Freight` number per range cannot decode five letters, and nothing in the export is
keyed by a freight letter the way the three duty columns are keyed by a duty letter. With clearance
and duty known, the arithmetic falls out:

```
freight$(range × letter) = Landed ÷ (1 + Clearance/100) − Price incl Duty
```

constant per (range × letter) on **19,197 of 19,201 rows**, every bucket agreeing at ≥99.5% and most
at 100%. **25 of 43 ranges use more than one letter and the spread is wide** — Fabricut is A=$30,
B=$3, C=$5 — so range alone is insufficient too: **the real key is range × letter.** The single `E`
row implies $70, and a class with one member cannot be generalised from at all (F2).

**The blocking question for Derek, and the reason no rate is written anywhere yet (F1): the
exported `Freight` column agrees with the letter-implied rate in only 30 of 43 ranges.** `HAMAM`'s
column is blank while its rows imply four distinct rates; `JWALL` says 30 while all 209 of its rows
imply 50. Either the column overrides the letters or the corpus values are stale snapshots — and
that decides whether the recovered table or the exported column is the migration source. The two
readings give different numbers on 13 of 43 ranges, including all six Fabricut houses and Pierre
Frey, so a repricing run that guesses moves prices nobody asked to move.

Until it is answered, the recovery is **a report that sits beside the ledger and is never written
into it** — the `src/suppliers/backfill-plan.js` posture that reports the `Jannelli Volpi` /
`Janelli Volpi` pair rather than collapsing it, and the same posture `duty_percent` already takes.
A placeholder written into the ledger is indistinguishable from a rate a supplier quoted.

### The seven inputs, and which of them have a home

| Step | Input | Source | Status |
|---|---|---|---|
| P1 | wholesale rate + currency | `price_list_items` | live |
| P1 | FX rate + margin | nothing — `src/seed/data/fx.js` is vendored demo data | **owed (A9)** |
| P2 | supplier discount | `supplier_brand_terms`, corroborated by the export's `Discount (%)` on 14,521 of 14,521 rows | live |
| P3 | duty % | the range's own A/B/C band × the price row's duty letter, from `legacy_tracking_options` | **sourced 12 Aug** (A10 closed) |
| P4 | **freight $/unit** | `supplier_freight_rates` | **W16, gated on F1** |
| P4 | clearance % | `legacy_tracking_options.clearance` — 10 on 56 ranges, 0 on the one domestic supplier | **sourced 12 Aug** |
| P5 | handling $/unit | nothing | owed |
| P6 | retail markup | `supplier_brand_terms.markup` — 6 rows, Fabricut only | **owed (F3)** |
| P7 | trade markup | `legacy_tracking_options.trade_markup` | **sourced 12 Aug** |

Four of seven now have a source; three do not. Two notes that stop a wrong reading of the table:
**duty has a source at the *parameter* grain and `price_list_items.duty_percent` still stays NULL**
— the letter is on the price row and the rate is on the range, both are needed, neither is
sufficient, and a row whose band is blank has no defined duty rather than zero duty. And **the
retail markup is not constant**: Retail ÷ Trade is 1.30 on 92% of rows but 1.35, 1.40, 1.50 or 1.80
on thirteen ranges, so it cannot be inferred and has to be asked for.

**The rule that makes the missing three survivable: the waterfall returns a partial result naming
its missing inputs, and never substitutes zero.**

```js
{ steps: [...], landed: null, missing: ['fx_rate', 'handling', 'retail_markup'] }
```

the `net_multiplier: null` + `invalid_reason` posture `listSupplierBrandTerms` already uses. A
landed cost that silently treats three missing inputs as zero looks authoritative and is wrong by a
factor. The same rule holds one level down: **a missing freight rate returns null with a named
reason**, because `Number(null)` is 0 and a zero freight rate reads as free shipping from Italy.
Blank means zero for the discount and for the duty letter — verified, all 4,638 rows in a
blank-discount range show a 1.000 ratio — but **blank means UNKNOWN for freight.** Do not write one
`COALESCE` for all of them.

**Rate rows are append-only.** A rate carries `effective_from` and a new rate never overwrites the
old one; that is what makes the ≥5% annual uplift auditable and what lets a 2024 landed cost be
reconciled at all. **The rate table carries no brand reference** — recording that absence is the
requirement, because `supplier_brand_terms` is per-brand and someone will copy that shape by
reflex. And `price_list_items.freight_class` is **neither dropped, backfilled nor reinterpreted**:
it stays the raw letter from the supplier's own file, exactly as `duty_class` does, and remains the
only surviving evidence of what D365 charged. The letters vanish from every screen and every
calculation with no destructive migration.

**One more input the model has to carry: the unit.** The freight figure is per the range's own pack
type, and the priced corpus is P/M 8,574 · P/Y 5,753 · P/Roll 2,816 · P/P 2,011. A rate states its
unit, or applying a per-roll freight to a per-metre quantity overcharges by roughly the roll length.

### The demo waterfall's step order is wrong independently of its constants

This is a correctness finding, not a preference. `src/seed/data/pricing.js` — vendored into the API
for indicative seed prices, and copied in the CRM at `src/data/pricing.js` — computes

```
priceExDuty = supplierDiscounted × (1 + clearance) + freight     then duty, then handling
```

The incumbent's engine, verified against the corpus on 19,197 of 19,201 rows, is

```
landed = (price incl duty + freight$) × (1 + clearance%)
```

**Duty comes before freight, and clearance multiplies both.** The demo applies clearance before
freight and duty after both. That moves every row carrying any of the three, and it would still be
wrong after the 8% freight and the 7% duty placeholders were corrected — which is why W18 US-006
corrects the order and W18 US-005 **deletes** the 7% placeholder rather than setting it to 5. The
value 7 appears in no band on any of the 58 ranges, and the real exceptions are per range rather
than per class, so a single constant is wrong at any value.

---

## Price history

**Two tables with real foreign keys, not one polymorphic table:** `price_list_item_price_history`
and `product_price_history`. A polymorphic `entity` + `entity_id` key cannot be a foreign key, and
the D365 override layer already records in `src/legacy/CLAUDE.md` what keying on a string costs.
Two narrow tables cost one extra migration and buy referential integrity on the thing the feature
exists to protect.

- **The column that is `NOT NULL` is `source`, not `reason`**, with
  `CHECK (source <> 'manual' OR (reason IS NOT NULL AND btrim(reason) <> ''))`. The database
  enforces "a hand edit carries a note", and it cannot be bypassed by the AdminJS panel, by a route
  somebody adds next quarter, or by a psql session — which is what the client's instruction
  actually means. A manual edit without a note is a 422 naming the field.
- **An import's reason is its provenance.** `source = 'import'` with `source_file` and
  `date_effective`, and **that is the reason**: *"the 12 August Colefax file said so"* beats any
  sentence typed 19,500 times. Say that to the client rather than shipping a `NOT NULL` the
  importer fills with the string `'import'`.
- **Capture is a database trigger (ADR 007), not application code.** The importer writes in chunked
  `unnest` upserts, and `RETURNING` after `ON CONFLICT DO UPDATE` gives the new row, not the old —
  so a JS delta needs a second query and covers only the writers somebody remembered. `OLD` is free
  and catches every writer. plpgsql is already an idiom here (`d365_override_{numeric,boolean,timestamp}`).
- **`ON DELETE RESTRICT`, not CASCADE — and it costs something real.** With CASCADE, deleting a
  price-list item would destroy exactly the history this feature exists to preserve, silently, and
  the next re-import would recreate the row looking new. So `DELETE /admin/price-list-items/:id`
  **stops being freely available** for any item whose price has ever moved: the delete policy table
  above gains a blocker where it previously had none. Staff will notice, they will call it a
  regression, and it is correct.
- **`changed_at` and `date_effective` are two different axes and are never conflated.**
  `changed_at` is when our ledger changed; `date_effective` is what the supplier's paper said. A
  quote given on 3 March used the rate the ledger held on 3 March, whatever the paper was dated.
  **The as-at lookup resolves on `changed_at` and returns `date_effective` beside it** —
  `GET /admin/price-list-items/:id/rate?as_at=2023-06-01`, one indexed query. **That endpoint is
  the feature**; it is what makes the year-in-SKU practice droppable.
- **A back-dated load carries `source = 'migration'`, is permitted to the loader and is forbidden
  to every route.** The trigger starts recording the day it ships and the client needs 2023, so on
  day one the ledger answers nothing about the past. The only candidate source is the **all-states
  D365 re-pull** named under the licence deadline — the same export the freight uplift audit needs.
  Two independent findings landing on one export request is the strongest signal in this document.

Drop detection is a sibling and not a history row: `last_seen_in_import`, `last_seen_source_file`
and `discontinued_at` are **evidence columns on `price_list_items`**, scoped `(supplier, category)`,
recorded by the importer's existing `SET` list. What a code's price *was* belongs in the ledger;
whether a supplier still lists it does not. FR-211…FR-219 carry the rest.

---

## ADR 002 — Sample scanning moves to a first-party phone scanner

**Date:** 2026-08-12 · **Status:** accepted · **Supersedes:** ADR 001 (`prd-august-12th.md` §4 X2)

**Context.** ADR 001 decided a Bluetooth keyboard-wedge scanner on the strength of one constraint:
`BarcodeDetector` is not implemented on iOS, Safari does not provide it, and every iOS browser is
WebKit underneath, so a browser-camera scanner fails on every iPhone and iPad — silently, because
the constructor is simply absent. On the 12 August call the client was told the opposite: *"I'm
developing a system for you guys to be able to scan it on your phone."* The client's current tool
is Power Platform, which works only because D365 is Microsoft, and the standing instruction is no
third-party scanning service.

**Decision.** Build the scanner as part of the platform, in the Orca Scan mould, with **no
third-party dependency**: a PWA over `getUserMedia` with a **WebAssembly barcode decoder bundled
into the app**, authenticating with the existing session cookie and calling the existing routes.
No Orca Scan, no commercial SDK, no Power Platform.

**Consequences.**
- **ADR 001's constraint has not gone away — it has been paid for.** The WASM decoder is a real
  dependency and a real bundle cost. It is a library rather than a service, which is what satisfies
  the constraint the client set, and it loads only on the scanner route.
- **No endpoint is added for scanning.** `GET /admin/samples/by-barcode/:barcode`, the check-out and
  check-in verb routes and `SampleScanner.jsx` all survive unchanged; both the camera path and a
  wedge hit the same endpoint.
- **Wedge input stays supported on the same screen**, and costs nothing to keep. It gives the
  showroom counter a faster option than holding up a phone, and it is the degradation path when
  camera permission is refused.
- A failed or low-confidence decode says so and is never completed by guessing.
- The rules live in a plain `scanner.js` beside the screen, because there is no jsdom in the CRM and
  component tests are impossible.

**Open.** Whether the showroom devices are iPads (F16), which decides how hard the decoder has to
work; and the label printer (F17), which is implied by auto-generated barcodes and specified
nowhere. W22 is sequenced behind W20's barcode generator for that reason.

---

## ADR 003 — A reserve is a fifth `orders.kind`, not a new table

**Date:** 2026-08-12 · **Status:** accepted

**Context.** Cutting and reserve tracking was shelved on 15 July and un-shelved on 12 August by a
client who was not on the call that shelved it (§4 X3). `legacy_reserves` holds 969 read-only
staging rows and the CRM's `/reserves` is a Dynamics mirror. The obvious shape is a `reserves`
table with its own quantities and its own lifecycle.

**Decision.** Widen the `orders.kind` CHECK to a fifth value. A reserve is an order with a kind,
raised, declined and converted through the existing state machine.

**Rules that produce that decision.**
- **`moveReservation` is the single writer of `qty_reserved`, and a second writer breaks silently.**
  Not loudly — silently. There is no constraint that catches two subsystems both adjusting a
  reservation, and the first symptom is stock that cannot be sold with nothing reserving it.
- **The state machine already does the work**: it holds the reservation, releases it on decline and
  converts it on ship. A new table would re-implement all three, and would have to be kept in step
  with the original for ever.
- **Widening a CHECK inherits everything keyed on kind** — the lifecycle registry, the reports, the
  order filters and the CRM's `KIND_LABELS`. The `manual` kind set exactly this precedent in commit
  `4b6808a`.
- Two tables would be a bigger diff **and** a correctness regression. That combination is rare
  enough to be worth naming when it appears.

**Consequences.**
- Reserves appear in every kind-aware list and report by default, so each one has to say whether it
  wants them. That is a known cost of the `manual` precedent and is cheaper than a second writer.
- **Whether a reserve holds stock or is a soft note is the client's decision (F7)** and it decides
  the epic's shape. Until it is answered the reserve kind is created without touching stock, and
  the difference is **one call site**, not a redesign.
- **A cutting is not a reserve.** It is a sample: it takes the `sample_orders` shape, holds no
  reservation, and copies **nothing** out of `legacy_cuttings.comments` — 1,757 of 1,886 rows hold
  third parties' names, emails, phones and home addresses. Migrating cuttings is a PII decision,
  not a table copy, and FR-49 plus an existing test already forbid it.

---

## ADR 004 — Xero item sync is deferred; the mapping column is not

**Date:** 2026-08-12 · **Status:** accepted

**Context.** A tidy Xero integration syncs items so invoice lines carry an `ItemCode` and Xero's own
product reporting works. The sellable grain here is the colourway, and once the colour files land
that is **45,923 colourways**. Xero's limit is roughly 5,000 calls per day per tenant.

**Decision.** Phase 1 pushes invoice lines with a description and an amount and **no `ItemCode`**.
`colourways.xero_item_code` ships in the same migration, unused.

**Consequences.**
- The arithmetic is the argument: 45,923 items at ~5,000 calls/day is about **thirteen days of
  continuous API traffic** for a nicer Xero item report, before a single invoice is pushed.
- Xero-side product reporting stays coarse. Atelier's own reporting is unaffected — it reads the
  order read model, which has the colourway.
- **Shipping the column now is what makes a later sync a data job rather than a migration**, and
  costs one nullable text column today.
- Nothing reads the column in this round, and a test asserts it is never sent.

---

## ADR 005 — Freight rate grain

**Date:** 2026-08-12 · **Status:** **proposed and BLOCKED on F1.** No migration is written and no
rate is stored until the client answers. *(Supersedes the supplier × category decision recorded in
the approved plan; see `prd-august-12th.md` §4, row "ADR 005 grain".)*

**Context.** Freight has to move from a raw uninterpreted A–E letter to a rate somebody can edit.
Where the rate hangs — supplier, supplier × category, or range — is the whole design, and two
sources disagree about it. The approved plan asserted **supplier × category** as decided; the
parameter export that arrived on 12 August shows the client's own engine keys on **range**. Both
underlying measurements are sound; the assertion built on the first of them is not.

**The two measurements, and what each one answers**, are in the Freight section above and are not
repeated here. In one line each: the letter-collision analysis says **category explains almost all
the variance in the letters** (43 groups by invoicing supplier × category, 8 ambiguous, 7 of the 8
`wallpaper`, and `product_range` adds nothing); the parameter table says **the rate table is keyed
on range** (`Name` covering 99.6% of priced rows, `Supplier` matching 8 of 28). And **25 of 43
ranges use more than one freight letter** with a wide spread, so range alone is not sufficient
either — the corpus's real key is **range × letter**.

**Decision (proposed, not accepted).** A `supplier_freight_rates` table keyed
`(supplier_id, category, effective_from)` with `mode CHECK IN ('percent','dollar')`, dollar the
default, **no `brand_id`**, and a documented mapping from the client's range-keyed parameters onto
it. **This is exactly the part that is blocked**: the mapping is only writable once F1 says whether
the exported `Freight` column overrides the letters or the corpus values are stale.

**What resolves it.** One question to Derek (F1): *the `Freight` column agrees with the
letter-implied rate in only 30 of 43 ranges — does the column override the letters, or are the
corpus values stale?* His answer picks the migration source. A second, smaller answer is then
needed on whether the client wants the rate she asked for (supplier × category, which she argued
for well) or the rate her incumbent charges (range × letter) — and if those differ, which one is
being migrated and which is being decided fresh. **No rate is written anywhere until both are
answered.** Everything else in W16 — the parameter read model, the recovery report, the resolver,
the waterfall, the preview route — is unaffected and proceeds.

**Consequences of leaving it open.**
- W16 ships a mechanism with no rates in it, which is honest and is not useless: the recovery report
  is what the client reads in order to answer.
- The two readings give different numbers on **13 of 43 ranges**, including all six Fabricut houses
  and Pierre Frey. A repricing run that guesses moves prices nobody asked to move, and does it
  quietly.
- `price_list_items.freight_class` stays raw provenance either way, so no answer to F1 requires a
  destructive migration.

---

## ADR 006 — A forward estimate and a per-shipment actual are two numbers, and they never merge

**Date:** 2026-08-12 · **Status:** accepted

**Context.** The client described a feature from her previous system: *"DHL was $200 and we ordered
10, so we would put 20 per metre — it kept the information, didn't change anything."* Read quickly,
that sounds like the freight rate table. It is not. Allocating a shipment's **actual** freight
across its lines is backward-looking; a rate table is a **forward estimate** used to price goods
before anything ships.

**Decision.** Model both, and never let either write to the other. Three seams carry the actual:
`purchase_order_receipts` groups by consignment reference, `supplier_invoices.freight_amount` holds
the invoiced figure, and the per-line allocation of it is derived at read time.

**Consequences.**
- **An actual freight cost never writes back to a rate, a price or a sell figure.** That is
  precisely the client's own *"didn't change anything"*, and it is the rule to quote when someone
  proposes "self-tuning" the rate table from real invoices.
- Variance between an invoice and its lines is **reported on screen, never stored** — a stored
  variance is a third number that goes stale.
- The consignment reference on the receipt is what makes this possible without a schema change
  later, which is why it lands in W13 even though nothing reads it until W14.
- **Whether the actual may ever become a costing input is A1 (F13) in concrete form** — the cost
  authority question. If the client eventually says yes, it arrives as a new column and a new
  decision, never as an `UPDATE` of a rate row.

---

## ADR 007 — Price history is captured by a database trigger

**Date:** 2026-08-12 · **Status:** accepted

**Context.** Every price write has to leave a record. The obvious place is the application: compute
the delta in the module that does the update and insert the history row beside it.

**Decision.** A plpgsql `BEFORE UPDATE` trigger on each priced table writes the history row from
`OLD`.

**Rules that produce that decision.**
- **The importer writes in chunked `unnest` upserts, and `RETURNING` after `ON CONFLICT DO UPDATE`
  gives the new row, not the old.** An application-side delta therefore needs a second query per
  chunk purely to learn what it is about to overwrite.
- **An application-side capture covers only the writers somebody remembered.** `OLD` is free and
  catches every writer — the importer, the admin panel, a route added next quarter, and a hand-run
  psql session.
- plpgsql is already an idiom in this repo (`d365_override_{numeric,boolean,timestamp}`), so this
  adds no new technology.

**Consequences.**
- **The cost is invisibility.** A reader of the module sees no history write, so the migration
  comment is loud and the CLAUDE.md for the area says it.
- **One test issues a bare SQL `UPDATE` on a raw connection and asserts a history row appeared.**
  That assertion is the only thing that makes "every writer is covered" true rather than
  aspirational, and it is the test to keep when someone trims the suite.
- The trigger records from the day it ships. Anything earlier is a `source = 'migration'` backfill,
  permitted to the loader and forbidden to every route.

---

## ADR 008 — The packing slip is a print window, with no PDF renderer

**Date:** 2026-08-12 · **Status:** accepted

**Context.** The client asked for a packing slip as a third document off the sales order, with
prices stripped. There is no PDF library, no document entity and no object storage in any repo, and
the codebase carries several deliberate *"PDF is deliberately not produced"* refusals. The demo
already has a working slip: `atelier-crm/src/utils/packingSlip.js`, 64 lines, zero dependencies,
already escaping every interpolated value, already omitting every money column, already tested.

**Decision.** Port that utility and drive it from the order read model. A browser print window is
the output. No PDF renderer, no document entity, no new dependency.

**Consequences.**
- **This is a port, not a build.** The only new part is a mapper from order lines (`qty`) instead of
  purchase-order lines (`received`), which is also the rule that **the slip's quantity is the
  ordered quantity** — a received quantity is a purchasing concept and does not belong on a sales
  document.
- **The slip carries no money of any kind** — no unit price, line total, subtotal, freight, tax or
  currency — and a test asserts no money field name appears in the rendered output.
- Nothing archives what was printed. A slip is reproducible from the order at any time, which is
  what makes the absence of a document entity acceptable rather than merely convenient.
- The existing PDF refusals stand; this does not reverse them.
- **The layout is owed (F14)** — the client's own template and the docket-sleeve confirmation. The
  slip ships either way, because layout is a template change and not a design change.
