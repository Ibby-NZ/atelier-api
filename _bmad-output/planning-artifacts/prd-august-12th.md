# PRD — Atelier platform, "August 12th updates"

**Date:** 2026-08-12
**Status:** draft for review
**Repos:** atelier-api, atelier-crm, atelier-storefront
**Integration branch:** `august-12th-updates` (all three repos)

---

## 1. Overview

A client review on 12 August walked the platform against how Atelier actually runs today — Dynamics
365, Excel, and a manual uploader. It produced 26 commitments. Most of them are not screens; they
are the parts of the business the platform has never modelled: a purchase order, a supplier
invoice, a price that used to be something else, a reserve, a freight cost.

Three of them are corrections rather than additions. Freight is computed as a percentage and the
client's own engine has never used a percentage. Duty is applied at 7% and 7% appears nowhere in
any band on any range. A price list re-import keeps codes that dropped off the list, for ever,
as live sellable prices.

And a large share of what was demonstrated — purchase orders, packing slips, the freight toggle,
the import wizard, the reporting dashboards, the cutting screen — runs on localStorage in demo
screens. This change set converts that surface into the system of record, and says out loud which
parts were never real.

This round also reverses two standing decisions and records one that was already reversed without
a document. See §4.

## 2. Goals

1. A sales order can be found, filtered, confirmed, printed without prices, and it tells the office
   it exists.
2. A purchase order is derived from the day's sales, receipted against, and cannot be raised twice
   for the same line.
3. One supplier invoice covers many purchase orders, and a purchase order is never billed twice.
4. An invoice reaches the client through Xero, from the CRM, without a second system mailing it.
5. Landed cost is computed from the client's own parameters, in dollars, and says what it is
   missing rather than substituting zero.
6. A price that changes leaves a record of what it was, when, and why — and a code that drops off
   a supplier's list is visible instead of silently live.
7. Reserves and cuttings are requests the platform records, not email.
8. A sample can be found, valued, chased and scanned from a phone.
9. The office imports its own price lists, without a developer and without a placeholder rate.

## 3. Non-goals

Carried forward, and each still out of scope for a stated reason.

- **Migrating live D365 operations.** Atelier runs on D365 until cutover; the staging import must
  stay re-runnable and no `legacy_*` table gains a column.
- **Historic product-grain sales reporting.** All four D365 transaction entities are header-only
  and there is no export path for detail rows. 7,002 invoice headers back to Nov 2019 give sales by
  value per customer, owner and period; product grain does not exist and must not be invented.
- **Exposing supplier cost data to any client-facing surface** — extended this round to purchase
  order lines, supplier invoices and freight rates.
- **A PDF renderer or a document entity.** The packing slip is a print window (§4, ADR 008).
- **A scheduler, worker or queue of any kind.** "Editable before send" and "sent automatically at
  2am" are contradictory; the client asked for the first, so a reminder is a staff action off a
  work queue. This is the simplification she asked for without knowing it, and it should be said
  back to her.

New this round, all three deliberately parked.

- **Product image upload (C13).** The client called it explicitly not urgent, and it is the largest
  infrastructure jump on the list: object storage, a bucket, a CDN origin, a lifecycle policy and a
  backup story, none of which exist in any repo. `products.hi_res_asset_url`, `colourways.image_url`
  and `collections.image_url` already accept a pasted URL at zero cost. **One exception:** the image
  on a *cutting* is functional rather than cosmetic — a fabric scrap cannot be identified without
  it — so it ships with W19 as a URL field on the cutting request.
- **Deep reporting dashboards (C24).** The commitment names no question, so it has no acceptance
  criteria, and an epic without acceptance criteria becomes an open-ended screen-building exercise
  that is never done. Parked until the client names three reports with their filters and their
  audience. Nine of the twelve standing reports are still indicative fixtures; those are a known
  backlog, not this.
- **The sample-register import (C26).** Unsizable. The client said "2 million" and then corrected
  toward "2,000 and something" — two orders of magnitude, and the difference between one importer
  and a different design. The entire eleven-entity D365 pull is 55,877 rows, which supports neither
  figure. Blocked on the samples export and a verified row count.

Deferred within an epic rather than out of scope: **Xero payment status** (there is no Xero
Payments webhook, so it is polled, and polling needs the worker above) and **Xero item sync**
(45,923 colourways at roughly 5,000 calls/day/tenant is about thirteen days of continuous API
traffic for a nicer Xero item report; `colourways.xero_item_code` ships so a later sync is a data
job, not a migration).

## 4. Supersessions — decisions reversed, with dates

Every row here reverses something a numbered artifact still asserts. The point of writing them down
is X5: a numbered requirement flipped silently once already, and by October nobody would be able to
say what was agreed.

| Ref | Date | What stood | What now stands | Consequence |
|---|---|---|---|---|
| **X1** | 2026-08-12 | `prd.md` §3: *"Xero integration of any kind (standing constraint FR-8)."* | **Reversed.** Xero is in scope as W15 and was described in the meeting as part of phase one. | Four shipped subsystems made design choices *because* Xero could not be called; each is re-stated in the W15 block. **The citation was also stale:** FR-8 in `prd.md` §5 is *"`apiDelete` exists in the CRM API client, so a DELETE carries no body and no JSON content-type"* — a CRM API-client requirement that says nothing about Xero. The non-goal hung off a number naming a different requirement, and no reader could have checked it. |
| **X2** | 2026-08-12 | `architecture.md` **ADR 001** — sample scanning uses a Bluetooth keyboard-wedge scanner, explicitly **not** a camera app, because `BarcodeDetector` is absent on iOS and every iOS browser is WebKit underneath. `prd.md` §3 carries the matching non-goal: *"Building a sample scanner application. This round produces a recommendation only."* | **Superseded by ADR 002**, and the non-goal is reversed with it. A first-party phone scanner, no third-party service and no commercial SDK, built as W22. | ADR 001's constraint has not gone away, it has been paid for: the camera path needs a WebAssembly decoder bundled into the app. That is a library, not a service, so it satisfies the constraint. `SampleScanner.jsx`, `GET /admin/samples/by-barcode/:barcode` and the check-out/check-in verb routes all survive unchanged, and wedge input stays supported on the same screen because both paths hit the same endpoint. |
| **X3** | 2026-08-12 | Cutting tracking shelved on 15 Jul as *"not a priority; email forms suffice."* | **Un-shelved.** The client was not on the call that shelved it and calls it not shelvable. | Un-shelving does **not** unblock it. The CRM's `/cutting` header already records that the cutting *process* is owed from Charlotte, outstanding since 30 June. W19 ships the request record and states what it cannot decide. |
| **X4** | 2026-08-12 | Freight at 8%, on advice, live in the demo waterfall and recorded as *DELIVERED* on 15 Jul. | **Freight is a dollar amount per unit, decisively.** Dollar is the default; percentage survives only as a stored option. | Settled by two rows that need no statistics: `STOCK - INTERWEAVE` at duty 0 / clearance 0 / freight 2 gives 38.00 + 2 = 40.00, and `GARRETT LEATHER` at a wholesale rate of zero gives a landed cost of 11.00 = (0 + 10) × 1.10, where a percentage of zero is zero. The 8% is right on 632 of 19,159 rows — **3.3%**. Real freight as a share of duty-paid value has median 27%, p5 5%, p95 76%. Do not tune the percentage. |
| **X5** | **2026-08-11** | `prd.md` **FR-19**: *"Orders, order lines, webhook events, all `legacy_*` tables, trade applications and trade accounts are never hard-deletable."* | **Already reversed before the meeting.** Commit `4b6808a` made `order` deletable behind a guard, recorded only in `src/lifecycle/CLAUDE.md`. | The mitigation is sound; the record was not. No story, no ADR, no PRD amendment, and `sprint-status.yaml` still reads 100% done. FR-19 now carries a dated exception naming the guard's blocker set, and W13 adds a fourth blocker: an order line that has been ordered from a supplier is no longer a mis-key anyone can delete. |
| **ADR 005 grain** | 2026-08-12 | **ADR 005** keys freight on **supplier × category**, measured over 19,514 price-list rows: category carries almost all the variance, and `product_range` adds exactly nothing (74 groups become 74, the same 15 collide). | **Superseded by Addendum 2.** The client's own engine keys pricing parameters on **range**. | Both measurements are correct and they answer different questions — one measured letter distribution, the other is the actual rate table. `Name` is the join key: **48 of 58 rows hit `legacy_product_prices.range_name`, covering 19,256 of 19,327 priced rows (99.6%)**; 40 of 58 hit `price_list_items.product_range` covering 19,450 of 19,514. `Supplier` is **not** a key — 8 of 28 match a live supplier, `supplier_aliases` is empty and `short_code`/`d365_token` are NULL on all 40 rows. And **25 of 43 ranges use more than one freight letter** with a wide spread (Fabricut A=$30, B=$3, C=$5), so the real key is **range × letter**. The migration source and the target grain differ, which the approved plan did not anticipate. **Consequence: the freight rate migration does not run until the client resolves it** (§8). Everything else in W16 is unaffected. |
| ADR numbering | 2026-08-12 | The plan's artifact table gives **ADR 004** to the packing slip; the architecture addendum gives **ADR 004** to deferred Xero item sync. | The addendum wins on the collision. Packing slip becomes **ADR 008**. | ADR 002 scanner · ADR 003 reserve as an order kind · ADR 004 Xero item sync deferred · ADR 005 freight grain (superseded above) · ADR 006 actual freight never writes back to a rate · ADR 007 price-history capture is a database trigger · ADR 008 packing slip is a print window. |

## 5. Users

Unchanged from the 6 August set, with two notes.

- **Back office (`backoffice`)** — the primary user. Runs the catalogue, orders, stock, samples, and
  from this round the purchasing desk, the price-list imports and the freight rates.
- **Director (`director`)** — back office plus finance visibility and bulk legacy import. Xero
  connection and reconnection are director-only: a refresh token that expires needs a human with
  authority to re-consent.
- **Trade client (`trade`, approved)** — unchanged by this work. Nothing this round exposes cost,
  freight, duty, markup or supplier terms to a client-facing surface.
- **Anonymous visitor** — storefront only; untouched by this round.

## 6. Functional requirements

Numbered in reserved blocks continuing from FR-114, so late additions do not renumber.
**FR-270…FR-274 are unallocated slack**, deliberately.

### W12 Sales order desk — FR-115…FR-129

- **FR-115** Every order records the client's own reference and the client's own PO number. That is
  the number *they* issued, and nothing in the system captures it today.
- **FR-116** `GET /admin/orders` filters by client, by date range, by free-text reference and by
  customer PO number, in addition to today's `status` and `include_archived`.
- **FR-117** Filter names come from a frozen in-code whitelist; free-text values bind as parameters
  with the `ILIKE` metacharacters escaped. The reporting filter module is **not** reused — its slug
  parser is safe only because slugs are `[a-z0-9-]` by construction, which a typed reference is not.
- **FR-118** The orders list is paginated and reports a total. No admin list returns an unbounded
  result behind a 1000-row ceiling.
- **FR-119** Every path that creates an order — Stripe checkout, order request, manual back-office
  order — notifies the back office at the single configured address. There is no per-salesperson
  routing, and the restriction is the commitment's real content.
- **FR-120** The client's order confirmation is sent when the order is **created**, on every
  creation path — not when a staff member later confirms it.
- **FR-121** The confirm transition keeps a message of its own, distinct from the creation
  confirmation, so confirming does not re-send the same mail.
- **FR-122** A mail failure never fails or rolls back an order.
- **FR-123** A packing slip is produced from the order read model in a print window. No PDF
  renderer, no document entity, no new dependency.
- **FR-124** The packing slip carries **no money of any kind** — no unit price, line total,
  subtotal, freight, tax or currency.
- **FR-125** Every value interpolated into the packing slip is escaped.
- **FR-126** The packing slip's quantity is the ordered quantity. A received quantity is a
  purchasing concept and does not appear on a sales document.
- **FR-127** Client reference and customer PO number are editable through the existing admin order
  update whitelist, and clear to NULL rather than to an empty string.
- **FR-128** The CRM orders screen carries the search, filters and pagination the Dynamics mirror
  list already offers, and stops fetching the whole table.
- **FR-129** The same filter set drives the on-screen list and anything exported or printed from it.

### W13 Purchase orders — FR-130…FR-149

- **FR-130** A purchase order records one supplier, a number issued by a database sequence, and a
  status that holds only what a person did.
- **FR-131** Purchase money is `numeric(12,4)` in the supplier's currency. **No integer-cents column
  exists anywhere in purchasing** — cents is the storefront's money type, and a purchase is foreign,
  fractional and unconverted.
- **FR-132** A purchase order's supplier is derived from the brand at create and is never accepted
  from a client. A client-chosen value produces no constraint violation; it silently addresses the
  order to the wrong house.
- **FR-133** A brand with no supplier is a 422 naming the brand. This fires on 26 of 41 houses on
  day one, because the supplier backfill has linked only 15.
- **FR-134** Purchase orders are derived from confirmed sales-order lines grouped by **brand**. One
  supplier selling two brands correctly produces two purchase orders — which is the whole reason
  consolidated invoicing exists.
- **FR-135** A sales-order line may be ordered exactly once. A partial unique index on the
  allocation's order-line reference refuses the second derivation, and the caught violation answers
  **409** naming the purchase order that already covers it. This is enforced by the database, not by
  application code — the derivation is exactly what two staff run at once at 5pm.
- **FR-136** An allocation carries a quantity, because one purchase-order line covering two sales
  orders is the ordinary case. `SUM(qty) <= qty_ordered` — **`<=`, not `=`**, because the remainder
  is a deliberate stock buy.
- **FR-137** Sales-order lines are `ON DELETE RESTRICT` from the allocation, so order deletion gains
  a fourth blocker and the lifecycle registry declares it.
- **FR-138** Receipting appends rows. A receipt is never edited and never deleted.
- **FR-139** A mistake is corrected by a negative receipt row, so the quantity check is
  `CHECK (qty <> 0)`, not `> 0`.
- **FR-140** Over-receipt is legitimate and is never clamped — suppliers over-ship rolls.
- **FR-141** Received and outstanding quantities are derived at read time, never stored. `closed` is
  not `full`: a purchase order closed short because the supplier discontinued the balance is a
  decision, not arithmetic.
- **FR-142** **No purchasing route writes any inventory quantity.** `moveReservation` remains the
  sole writer of `qty_reserved`; a second writer breaks the reservation arithmetic silently.
- **FR-143** Purchase-order numbers come from a sequence, never `max+1`. The sequence does not reset
  per year, and a rolled-back transaction leaves a gap: **a gap in a purchase-order number is not a
  missing purchase order**, and the office's own documentation must say so.
- **FR-144** A receipt records a consignment reference, so a shipment's actual freight can later be
  grouped by consignment without a schema change.
- **FR-145** Purchase orders list and filter by supplier, brand, status and date range, paginated.
- **FR-146** A purchase order carries a per-line backorder balance derived from ordered minus
  received.
- **FR-147** Deleting a purchase order is refused once it carries receipts or allocations, and the
  refusal names each blocking relation and its count.
- **FR-148** No purchasing field reaches a client-facing response — asserted by extending the
  existing price-list exposure test rather than by a new one.
- **FR-149** The CRM drives the whole desk: derive from the day's confirmed orders, review, receipt
  short, and print — replacing the demo screens that look finished.

### W14 Consolidated supplier invoices — FR-150…FR-164

- **FR-150** A supplier invoice records one supplier's bill covering a 2–4 week cycle, in the
  supplier's invoicing currency.
- **FR-151** A purchase order appears on **exactly one** invoice, enforced by a UNIQUE constraint on
  the join. A re-attach after a correction would otherwise double-count spend in every downstream
  report, with nothing in the data saying which row was the mistake.
- **FR-152** Attaching an already-attached purchase order answers 409 naming the invoice that holds
  it.
- **FR-153** Attaching a purchase order belonging to a different supplier answers 422.
- **FR-154** The variance between the invoice total and the summed line cost is **reported on
  screen, never written**.
- **FR-155** An invoice may carry a freight amount — the *actual* freight for that consignment.
- **FR-156** **An actual freight cost never writes back to a rate, a price or a sell figure.** The
  rate table is a forward estimate and the actual is backward-looking; both are correct and they
  must never be merged. This is the client's own "it kept the information, didn't change anything".
- **FR-157** One invoice may cover purchase orders raised for two brands of one supplier.
- **FR-158** Where a supplier does not quote Atelier's purchase-order numbers, matching is by date
  and amount, so the invoice screen offers a search rather than assuming a join.
- **FR-159** Deleting an invoice is refused while purchase orders are attached; detaching is an
  explicit act that is recorded.
- **FR-160** Invoices list and filter by supplier, status and date range.
- **FR-161** No supplier-invoice field reaches a client-facing response.
- **FR-162** Invoice amounts are `numeric(12,4)`, matching the purchasing side exactly.
- **FR-163** An invoice records who entered it and when.
- **FR-164** The CRM creates an invoice, attaches purchase orders to it, and shows the variance
  before anyone posts anything.

### W15 Xero — FR-165…FR-184

- **FR-165** The Xero client is injected at `buildApp`, exactly as the Stripe and mail transports
  are. **No test ever reaches Xero**, proved by a capture double.
- **FR-166** Xero tokens are encrypted at rest with `aes-256-gcm` under a dedicated key. The
  decisive local fact: this working tree holds a database archive and three SQL dumps, and a
  database dump must not hand over the client's accounting system.
- **FR-167** The connection row is never exposed by any route, read model or admin panel resource —
  asserted by a source scan and a response-body scan.
- **FR-168** A token refresh runs inside a transaction taking `SELECT … FOR UPDATE` on the
  connection row and **re-reads the token after acquiring the lock**. A Xero refresh token rotates
  on use, so two concurrent refreshes with the same token leave one holding a dead credential and
  the connection unrecoverable without a human re-consenting. The loser of the race finds a fresh
  valid token and never calls Xero at all.
- **FR-169** `GET /admin/xero/status` reports connection state, last successful sync and last error.
- **FR-170** A refresh token expiring after 60 days idle is reported as a reconnect prompt naming
  the cause, not as a generic failure. With no scheduler nothing keeps it warm, so an integration
  idle over a quiet December is dead in January, and only a director re-consenting fixes it.
- **FR-171** An invoice is pushed by `POST /admin/xero/invoices` taking an order id. There is no
  route under `/admin/orders/:id`, deliberately, so the Xero work never opens the order desk's file.
- **FR-172** A push is **refused** when the order already carries a Xero invoice id — otherwise a
  double-click bills the client twice.
- **FR-173** `orders.xero_invoice_ref` keeps its meaning as a staff-typed reference and is never
  repurposed as the Xero id. They are different facts and overloading loses the manual history on
  the first push.
- **FR-174** The invoice is mapped from the existing order read model — lines, quantities, prices
  and a recomputed subtotal. **No new invoice entity is created**; the order already carries all of
  it.
- **FR-175** The Xero contact is the trade account where one exists and the user otherwise. Xero
  bills a company, and billing the individual designer rather than the practice is wrong for a trade
  business.
- **FR-176** `legacy_accounts.xero_contact_id` is the backfill source for contact mapping — 853 of
  866 accounts carry one.
- **FR-177** Invoice lines carry a description and an amount and **no item code**.
  `colourways.xero_item_code` ships unused so a later item sync is a data job, not a migration.
- **FR-178** The local sync row commits **before** the Xero call, and a Xero failure never rolls the
  order back. This deliberately inverts the Stripe webhook's one-transaction rule, and inverts for a
  reason: Stripe's event is replayable by Stripe, a Xero invoice is not replayable by us. An order
  with no invoice is recoverable; an invoice with no order is not.
- **FR-179** A `pending` sync row is **never blind-retried** — it queries Xero first. The failure
  that costs real money is a call that succeeded at Xero and failed to record locally, after which a
  null invoice id reads as "not pushed" and a retry raises a second invoice.
- **FR-180** **No invoice email template is added.** Xero sends the invoice, and two systems mailing
  the same invoice is the failure mode.
- **FR-181** The account code and tax type per line class come from configuration, never from a
  literal in code — a wrong tax type is a wrong GST return.
- **FR-182** A currency the connected Xero organisation cannot accept fails with a stated reason
  before the call is made.
- **FR-183** The CRM pushes from the order screen and shows connection status and last error where a
  human will see them.
- **FR-184** Payment status from Xero is out of scope this round and is recorded as blocked: there
  is no Xero Payments webhook, so it is polled, and polling needs the scheduled worker §3 refuses.

### W16 Freight and landed cost — FR-185…FR-199

- **FR-185** The incumbent's pricing parameters are staged read-only, one row per (house × product
  line), keeping the source's own names and polarity. **Shipped** — `legacy_tracking_options`,
  migration `1787284800000`.
- **FR-186** **Freight is a dollar amount per unit.** A percentage mode may be stored as an option,
  but dollar is the default and nothing computes a percentage by default.
- **FR-187** The freight unit is the range's own pack type — per roll, per hide, per metre, per
  piece — and a rate states its unit. The priced corpus is P/M 8,574 · P/Y 5,753 · P/Roll 2,816 ·
  P/P 2,011, so applying a per-roll freight to a per-metre quantity overcharges by roughly the roll
  length.
- **FR-188** Landed cost is `(price incl duty + freight$) × (1 + clearance%)`. **Clearance is a
  percentage** despite carrying no `(%)` in the source's label, and it multiplies duty-paid value
  **plus** freight, not the goods alone.
- **FR-189** Duty is applied from the range's own band keyed on the price row's duty letter, and a
  blank letter is 0%. The duty letter is on the price row and the rate is on the range: both are
  needed, neither is sufficient, and a row whose band is blank has **no defined duty** rather than
  zero duty.
- **FR-190** A missing rate returns **null with a named reason**, never zero. `Number(null)` is 0,
  and a zero freight rate reads as free shipping from Italy.
- **FR-191** The waterfall returns a **partial result naming every missing input** —
  `{ steps, landed: null, missing: [...] }` — and never substitutes zero. A landed cost that
  silently treats four missing inputs as zero looks authoritative and is wrong by a factor.
- **FR-192** A rate carries `effective_from` and a new rate never overwrites the old one. That is
  what makes the ≥5% annual uplift auditable and what lets a 2024 landed cost be reconciled.
- **FR-193** Rates are editable by staff, in the CRM and through a CSV round trip, with no developer
  in the loop.
- **FR-194** The freight rate table carries **no brand reference**. Recording that absence is the
  requirement: the existing supplier terms table is per-brand and someone will copy that shape by
  reflex.
- **FR-195** `price_list_items.freight_class` is **neither dropped, backfilled nor reinterpreted.**
  It stays the raw letter from the supplier's own file, exactly as `duty_class` does, and remains
  the only surviving evidence of what D365 charged. The letters vanish from every screen and every
  calculation with no destructive migration.
- **FR-196** The freight letter → dollar table is **recovered from the price corpus by arithmetic**:
  `landed ÷ (1 + clearance/100) − price incl duty` is constant per (range × letter) on **19,197 of
  19,201 rows**. The recovery is a report that sits beside the ledger and is **never written into
  it** — the same posture `duty_percent` already takes, because a placeholder written there would be
  indistinguishable from a rate a supplier quoted.
- **FR-197** The recovery report names every disagreement between the recovered rate and the
  exported `Freight` column. The column equals some letter's rate in only **30 of 43 ranges**;
  `HAMAM`'s column is blank while its rows imply four distinct rates, and `JWALL` says 30 while all
  209 of its rows imply 50.
- **FR-198** **No freight rate is written anywhere until the client resolves the grain.** The
  approved model keys on supplier × category; the client's engine keys on range, and range alone is
  insufficient because 25 of 43 ranges use more than one letter. See §4 and §8.
- **FR-199** No landed cost, freight rate, clearance, duty, markup or any cost input reaches a
  client-facing response.

### W17 Price history and drop detection — FR-200…FR-219

- **FR-200** Price history lives in **two tables with real foreign keys**, one per priced entity —
  not one polymorphic table. A polymorphic key cannot be a foreign key, and the D365 override layer
  already records what keying on a string costs.
- **FR-201** Capture is a **database trigger**, so every writer is covered — the importer's chunked
  upserts, the admin panel, a route somebody adds later, and a hand-run `psql` session. An
  application-side delta covers only the writers somebody remembered, and `RETURNING` after
  `ON CONFLICT DO UPDATE` gives the new row, not the old.
- **FR-202** A test issues a bare SQL `UPDATE` on a raw connection and asserts a history row
  appeared. That assertion is the only thing that makes "every writer" true rather than aspirational.
- **FR-203** `source` is `NOT NULL`; **`reason` is required only when the source is a manual edit**,
  enforced by a database CHECK. The database enforces "a hand edit carries a note", and it cannot be
  bypassed by a panel, a new route or a psql session.
- **FR-204** A manual price edit without a note is a **422** naming the field.
- **FR-205** An import writes `source = 'import'` with its source file and effective date, and
  **that is its reason**. "The 12 August Colefax file said so" beats any sentence typed 19,500 times.
- **FR-206** `changed_at` and `date_effective` are different axes and are never conflated:
  `changed_at` is when our ledger changed, `date_effective` is what the supplier's paper said.
- **FR-207** `GET /admin/price-list-items/:id/rate?as_at=<date>` resolves on `changed_at`, returns
  `date_effective` beside it, and is one indexed query. **That endpoint is the feature** — it is
  what makes the year-in-SKU practice droppable.
- **FR-208** History is `ON DELETE RESTRICT`. With CASCADE, deleting a price-list item would
  silently destroy exactly the history this feature exists to preserve, and the next re-import would
  recreate the row looking new. Deleting an item whose price has ever moved stops being freely
  available; staff will notice, and it is correct.
- **FR-209** A back-dated load carries `source = 'migration'`, is permitted to the loader and is
  **forbidden to every route**.
- **FR-210** The item screen shows every recorded change with its date, source, effective date and
  note.
- **FR-211** The importer records, on every row it touches, when it was last seen in an import and
  which file it was seen in — two more entries in the importer's existing `SET` list, no extra
  statement.
- **FR-212** Drop detection is scoped by **`(supplier, category)`**, never by source file: filenames
  carry the year and change annually, so a file-to-file comparison has no stable key. Per supplier
  alone is also wrong — a house that sends only its wallpaper list in March would mark its entire
  fabric range discontinued.
- **FR-213** **An import never flags anything.** The import records what it saw; marking a code
  discontinued is an explicit staff act.
- **FR-214** The confirmation screen states coverage before it acts — *"this file covered 412 of the
  2,516 codes we hold for Boussac fabric — marking 2,104 discontinued"* stops the partial-file
  mistake by itself. No percentage threshold is coded.
- **FR-215** Two states: **suspect** is derived and renders amber; **discontinued** is stored and
  renders red. Without the first a partial file silently produces nothing; without the second there
  is no way to dismiss a wrong suspicion.
- **FR-216** A supplier re-listing a code **clears** the discontinued mark — that is the strongest
  possible statement that it is not discontinued.
- **FR-217** Discontinued is not archived. Supplier stopped selling it, versus staff took it out of
  the list. A discontinued item blocks nothing; it is information.
- **FR-218** The re-import's freshest-wins contract is stated **per column**, and whether a file
  built to an older template may clear a newer template's fields is a recorded product decision
  rather than an accident of the upsert. Today every non-key column is set to `EXCLUDED`, which is
  uniform and defensible and is not what a reader expects.
- **FR-219** The state vocabulary behind the red flag is the **client's** decision — supplier
  stopped it, we stopped stocking it, do not sell, and whether remaining stock may still be ordered.
  The rendering is ten minutes; the vocabulary is not ours to choose.

### W18 Staff self-service imports — FR-220…FR-234

- **FR-220** The price-list import wizard writes through the API. It stops being an in-memory
  localStorage store.
- **FR-221** A dry run reports exactly what would change and writes nothing.
- **FR-222** **The 7% duty placeholder is deleted, not corrected.** The value 7 appears in no band
  on any of the 58 ranges. The real rate is **5% on duty class A** — 54 of 58 ranges — with three
  per-range exceptions: one bedding line at 10% across all bands, one domestic supplier at 0%
  across all bands, and one range whose bands genuinely differ from each other. Bands B and C are
  real parameters that no row in either corpus has ever exercised.
- **FR-223** A blank or lettered duty cell yields **no duty value at all**. `duty_percent` stays
  NULL until a real file carries a real number; the parameter export is a *parameter* source, not a
  file, and nothing writes it into the ledger.
- **FR-224** Any waterfall preview applies the steps in the incumbent's order — discount, FX, duty,
  then freight, then clearance over the sum. The demo applies clearance before freight and duty
  after both, which produces a different number on every row that has any of them.
- **FR-225** An import failure is loud, names `file:line`, and writes nothing.
- **FR-226** A file whose header row matches no registered template is refused, with every accepted
  header listed. The header row **is** the version.
- **FR-227** The committed converter output stays byte-identical: the self-service path is a second
  way in, not a replacement, and `npm run convert:pricing` followed by a clean diff remains a gate.
- **FR-228** Back office may import and edit price lists without a developer. Only design changes
  and destructive actions stay locked.
- **FR-229** An import run is recorded with who ran it, when, which file, and the row counts it
  produced.
- **FR-230** Category values outside the stored vocabulary are reported per row rather than dropped.
  `Leather`, `Samples and Displays` and `Throws/Blankets` fall outside it today and 96 rows cannot
  be imported at all.
- **FR-231** An import is one transaction, and re-running it changes nothing.
- **FR-232** A row with a wholesale rate of zero is price-on-application and is reported, never
  written as a price of zero.
- **FR-233** The FX rate and margin used by any preview are labelled as vendored demo data until a
  real source exists; nothing presents them as a live rate.
- **FR-234** The CRM shows the run history with each run's report, so a staff member can see what
  their own import did.

### W19 Reserves and cuttings — FR-235…FR-249

- **FR-235** **A reserve is a fifth order kind, not a new table.** The order state machine already
  holds reservations, already releases on decline and already converts on ship. Widening the CHECK
  inherits the state machine, the lifecycle registry, the reports and the CRM's kind labels — the
  `manual` kind set exactly this precedent. Two new tables would be a bigger diff *and* a
  correctness regression.
- **FR-236** `moveReservation` remains the single writer of `qty_reserved`. A reserve that holds
  stock holds it through that path and through nothing else.
- **FR-237** Whether a reserve **holds stock or is a soft note** is the client's decision and is
  recorded as blocking the epic's shape (§8). Until it is answered the reserve kind is created
  without touching stock, and the difference is one call site, not a redesign.
- **FR-238** A declined reserve releases exactly as a declined order does, through the same path.
- **FR-239** A reserve converts to an order without re-reserving the same stock twice.
- **FR-240** **A cutting is a sample, not stock.** It takes the sample-order shape and holds no
  reservation.
- **FR-241** No cutting or reserve route reads or writes an inventory quantity outside the single
  writer above.
- **FR-242** `legacy_cuttings.comments` is **never read, copied or served** — 1,757 of 1,886 rows
  hold third parties' names, emails, phones and home addresses. Migrating cuttings is a PII
  decision, not a table copy.
- **FR-243** Legacy cuttings are not migrated. A cutting is raised in the new system.
- **FR-244** A cutting carries an image URL, because a fabric scrap cannot be identified without
  one. This is C13's single functional exception and costs no storage infrastructure.
- **FR-245** A cutting records who asked, what for, when it is due back and whether it came back.
- **FR-246** Reserves and cuttings list, filter and paginate on the same whitelist pattern as every
  other admin list.
- **FR-247** Deleting a reserve or a cutting follows the shared lifecycle rules and names its
  blockers.
- **FR-248** The epic ships the request record and **states what it cannot decide**: the written
  cutting and reserve process is owed from Charlotte and has been since 30 June.
- **FR-249** The CRM's `/reserves` and `/cutting` screens write for real, replacing a Dynamics
  mirror and a preview that writes nothing.

### W20 Samples round two — FR-250…FR-269

- **FR-250** The outstanding report reads **across the whole register**, not per sample. Today loans
  are listed one sample at a time, which is the actual gap.
- **FR-251** Loans to trade clients are first class. The trade-account column, the check-out path
  that accepts it, the due-back date and the derived overdue filter **already exist and are not
  rebuilt**.
- **FR-252** Overdue stays derived at read time, never stored.
- **FR-253** **A reminder is a staff action off a work queue.** No scheduler, cron, worker or queue
  is introduced anywhere in the platform.
- **FR-254** A reminder is composed from a template and is **editable before send**.
- **FR-255** A template row falls back to the code template, so a deleted row can never break a send.
- **FR-256** A sent reminder records what was sent, to whom, by whom and when.
- **FR-257** Barcodes are generated from a database sequence on request.
- **FR-258** A duplicate barcode remains a database refusal mapped to 409. Duplicate prevention is
  already correct and is not re-implemented in application code.
- **FR-259** The barcode **format** and the label printer are stated open questions. No format is
  invented, and generating barcodes with nothing to print them on is named as the part that actually
  blocks the showroom.
- **FR-260** A sample carries a nullable unit cost with `CHECK (unit_cost IS NULL OR unit_cost >= 0)`
  — deliberately not `> 0`, because a free hanger is normal.
- **FR-261** **NULL and 0 are different facts**: NULL is "nobody recorded a cost", 0 is "free, and we
  know it". Free hangers must never be conflated with unpriced ones.
- **FR-262** Every read of a sample cost coerces `value == null ? null : Number(value)`, or a
  sample-value report counts every unpriced hanger as a gift.
- **FR-263** Sample value is entered by hand. Deriving it from purchase-order receipting is a
  separate, later requirement that drops cleanly if purchasing slips.
- **FR-264** Sample cost never reaches a client-facing response.
- **FR-265** No sample route touches an inventory quantity. Samples are not stock.
- **FR-266** The register lists, filters and paginates — the general filter promise, applied here.
- **FR-267** The reminder work queue lists every overdue loan with its holder, its due date and how
  long it is overdue.
- **FR-268** The CRM carries the outstanding report and the compose-before-send screen.
- **FR-269** The CRM generates a barcode and records a value from the register screen.

### W21 Reporting codes — FR-275…FR-289

- **FR-275** Products carry a range and brands carry a brand code, as reporting dimensions.
- **FR-276** The backfill matches **only where unambiguous**. Ambiguous and unmatched rows are
  reported, never guessed — the posture that reports the `Jannelli Volpi` / `Janelli Volpi` pair
  rather than collapsing it.
- **FR-277** **Range is a reporting label, not a cost axis**, and appears in no pricing calculation.
- **FR-278** Reports filter by brand code and by range on the existing whitelist.
- **FR-279** Every report using these dimensions states its coverage. The pre-existing 52%
  stock-item resolution rate caps what they can answer.
- **FR-280** `CFJC` is **not interpreted** until the client says what it is — two brand codes run
  together, which reporting concatenates and nothing stores, or one combined reporting line for two
  houses, which is a group column on brands and not a code. Guessing produces a dimension that means
  different things to different rows.
- **FR-281** The supplier → brand roll-up comes from the client's own delivered data — 28 invoicing
  entities over 55 houses — and supersedes the empirical item-code roll-up.
- **FR-282** A supplier alias is added one at a time from the CRM. `Fabricut Inc` / Fabricut and
  `Pierre Frey Paris` / Pierre Frey are corrections to make, **not a fuzzy rule to write**.
- **FR-283** A range with no parameter row is reported rather than defaulted. `BOUSSAC` has 64
  priced rows and 43 stock items and no parameter row at all.
- **FR-284** A parameter export filtered to active rows is treated as filtered. `Active` on every
  row proves nothing about whether inactive rows exist.
- **FR-285** Stock figures state their source while `legacy_stock_items.stock_on_hand` (5,332.8) and
  `legacy_item_locations.total_stock_on_hand` (14,157.9) disagree by 2.65×.
- **FR-286** Finance masking is unchanged and applies to every new dimension: a caller without
  finance access receives no finance key anywhere in the payload, deleted rather than nulled.
- **FR-287** Report exports share one query builder with the on-screen table, so the two can never
  disagree.
- **FR-288** The 5-metre surcharge is **not built** at either grain. It is defined at both — 6 of 58
  ranges at $20/$25, and 992 stock items at $12/$20/$15/$10 with about 50 of them negative — and 935
  of the 992 items belong to a range with no range-level rule. Half-specified scope with a
  contradiction in it is an open question, not a story.
- **FR-289** The CRM's report filters expose the new dimensions with their coverage statement.

### W22 First-party phone scanner — FR-290…FR-299

- **FR-290** The scanner is part of the platform: no third-party scanning service, no Power
  Platform, no commercial SDK. The scan goes straight to the CRM.
- **FR-291** The camera path decodes with a **bundled WebAssembly decoder**. `BarcodeDetector` does
  not exist on iOS and every iOS browser is WebKit underneath, so the browser-native API fails on
  every iPhone and iPad — silently, because the constructor is simply absent.
- **FR-292** The scanner authenticates with the existing session cookie. No second auth mechanism is
  introduced.
- **FR-293** It calls the **existing** by-barcode lookup and the existing check-out / check-in verb
  routes. No endpoint is added for scanning.
- **FR-294** Wedge input stays supported on the same screen, and gives the showroom counter a faster
  option than holding up a phone.
- **FR-295** A failed decode says so. A partial or low-confidence read is never completed by
  guessing.
- **FR-296** An unknown barcode returns the existing deterministic 404, and the screen offers to
  register it rather than dead-ending.
- **FR-297** The screen shows the last scan and its result, so an operator can see a check-out
  succeeded without navigating away.
- **FR-298** A refused camera permission degrades to wedge input, not to a blank screen.
- **FR-299** The decoder's bundle cost is measured and stated, and it loads only on the scanner
  route.

## 7. Success metrics

- A sales order raised in the CRM can be found by client, date, reference or the client's PO number,
  confirmed, and printed as a packing slip with no money on it.
- A purchase order derived twice by two people at 5pm produces one purchase order and one 409.
- Every purchase order appears on exactly one supplier invoice, and the variance between invoice and
  lines is visible without being stored.
- An invoice pushed twice produces one Xero invoice.
- A landed cost either resolves from the client's own parameters or names every input it is missing.
  It never returns a number built on a zero it invented.
- Every price change since the trigger shipped is answerable as at a date, and a manual change
  cannot be made without a note — including from a psql session.
- A price list re-imported for one supplier and category states its coverage before anything is
  marked discontinued.
- No cost, freight, duty or markup field appears in any client-facing response, asserted by test.
- All gates green in all three repos; no story merged without a review record.

## 8. Open questions — owed by the client

Eleven of the fifteen Part-A items are still open six weeks after they were requested, and 26
commitments have now been layered on a scope that was never priceable. The first row is the only one
that blocks a migration.

| Ref | Question | Owner | Consequence while open |
|---|---|---|---|
| **F1** | **Does the exported `Freight` column override the freight letters, or are the corpus values stale snapshots?** The column equals some letter's rate in only 30 of 43 ranges; one range's column is blank while its rows imply four rates, another says 30 while all 209 of its rows imply 50. | **Derek** | **W16's rate migration does not run.** The two readings give different numbers on 13 of 43 ranges, and a repricing run that reads the column moves prices on those ranges — including all six Fabricut houses and Pierre Frey — without anyone having asked for a price change. |
| F2 | What do freight classes A–E *mean* — air/sea, roll/cut/sample? And what is `E`, which has exactly one member implying $70? | Liz / Derek | A class with one member cannot be generalised from at all. |
| F3 | The retail markup, per range. Not in the delivered parameter file. | Liz | Retail ÷ trade is 1.30 on 92% of rows but 1.35, 1.40, 1.50 or 1.80 on thirteen ranges; the waterfall's last input stays owed. |
| F4 | The 5-metre surcharge — range-level (6 ranges, $20/$25) or item-level (992 items, $12/$20/$15/$10, ~50 negative)? Both exist and they disagree; 935 of the 992 items belong to a range with no rule. | Liz | FR-288: neither half is built. |
| F5 | `BOUSSAC` — 64 priced rows, 43 stock items, no parameter row. Retired in D365, or excluded by the view? | Liz | One supplier has no freight rate and it is a data entry, not a modelling problem. |
| F6 | Are duty bands B and C live or vestigial? Not one row in either corpus carries `B` or `C`. | Charlotte | They are stored; nothing validates them and nobody should assume the corpus proves them right. |
| F7 | Does a reserve **hold stock**, or is it a soft note? | Liz | W19's entire shape (FR-237). |
| F8 | "Bulk sales orders" — batch entry, or one order across several clients? | Liz | W13's derivation story. |
| F9 | Is Atelier on a Xero plan offering a **Custom Connection**? | Liz / Abdullah | Worth more than the rest of the Xero spike combined: machine-to-machine, single-tenant, no user consent, no rotating refresh token, no 60-day cliff. Ask before building anything. |
| F10 | Xero org — demo or live — and who owns product and contact truth. Is the multi-currency add-on enabled? Account code and tax type per line class? Who emails the invoice? | Liz / Abdullah | Without multi-currency a EUR/USD/GBP supplier bill cannot be raised at all. A wrong tax type is a wrong GST return. |
| F11 | Written cutting and reserve process | **Charlotte, since 30 June** | X3: un-shelving does not unblock it. |
| F12 | Definitive product-field list | Charlotte, since 15 July | W17's field vocabulary; the pricing template stays additive and header-versioned. |
| F13 | A1 cost authority, A2 what counts as a sale, A3 opening balances, A5 FY start month | Liz + accountant, since 7 July | Reporting scope, invoice matching, import authority. |
| F14 | A15 packing-slip template and the docket-sleeve confirmation | Liz, Jenette, since 7 July | W12's layout only — the slip ships either way. |
| F15 | The current overdue-sample reminder letter | Liz | W20's base template; the code fallback ships without it. |
| F16 | Showroom device confirmation — are they iPads? | Jenette, since 6 Aug | W22's decoder difficulty. |
| F17 | The barcode-minting policy and the label printer | Liz / Jenette | Three hangers is three physical objects, three rows and three barcodes. Blocks the receipting-derived sample story, not the register. |
| F18 | What is `CFJC` — two brand codes concatenated, or one combined reporting line? | Liz | FR-280. |
| F19 | The discount tier question, re-opened. Closed on 9 July as two tiers at −10%/−5%; the invoices say **three tiers at 5% / 8% / 10%**, chosen **per transaction**, striking off trade sell price and **not** stacking with the supplier chain. | Liz | Every margin figure is exposed until it is re-opened. The question was closed on the wrong answer. |
| F20 | Sizing for the sample register — 2,000 rows or 2,000,000? | Liz | C26 stays out of scope (§3). |
| F21 | An unfiltered re-export of the parameter view, and the account number on its supplier column | Liz | The supplier lookup exports as a display name and matches 8 of 28 live suppliers; `Name` covers 99.6% and is the key we use instead. |
| F22 | Names for the 25 ranges with no house row | Liz / Charlotte | The same list the colour import is already blocked on. **One decision unblocks both.** |
| F23 | Does `supplier_brand_terms.markup` store `0.85` or `1.85`? The delivered parameter file says **85**. | Internal, decide before importing | The column is `numeric(6,4)` with `CHECK (markup IS NULL OR markup > 0)`, so **both readings pass the CHECK and one of them is wrong by a factor of two**. 57 markups are available where the dev database holds 0 rows; only 33 of 58 range names resolve to a house, so 25 have nowhere to land until F22 is answered. |

### The licence deadline, restated

The legacy D365 environment is on a one-month extension expiring **around the end of August**. Five
export asks are still outstanding, and after it they stop being blocked and start being permanently
unanswerable. **Confirm the actual expiry date this week.**

| Export still owed | What dies with the licence |
|---|---|
| Stock Items + Item Locations re-exported **with a code column** | 48% of stock items cannot be linked to a price row at all. Cheapest ask on the list — the same related-column mechanism two existing views already use. |
| **All-states** Product Prices (the current view is pre-filtered to Active on all 19,327 rows) | The only possible historic baseline for FR-207's as-at lookup and for any year-on-year freight comparison. Without them, price history answers nothing about the past for twelve months after it ships. **Two independent findings land on this one request** — the price-history backfill and the freight uplift audit — which is the strongest signal in this document. |
| The **samples / sample-tracker** register | C26 has no source and the barcode sizing stays a guess. |
| The Range/Type entity | **Delivered 12 Aug.** Struck from this list — see §4. |
