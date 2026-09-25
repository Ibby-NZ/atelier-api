# atelier-api — purchasing

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## Purchase orders (W13)

The buying desk: the day's open sales demand becomes purchase orders grouped by house, sent,
receipted against and closed. Four tables —
`migrations/1787544000000_purchase-orders.js` (header + `purchase_orders_number_seq`),
`1787630400000_purchase-order-lines.js` (lines + `purchase_order_line_allocations`),
`1787716800000_purchase-order-receipts.js` (the ledger) — behind
`src/routes/admin-purchase-orders.js`, all `requireRole('backoffice')` (director inherits).

- **`supplier_id` comes from the HOUSE, never trusted from a client.** Both write paths
  (`createPurchaseOrder`, `generatePurchaseOrders`) resolve it through `resolveBrandSupplier`.
  A house may have several suppliers (`brand_additional_suppliers`, migration 1791638400000 —
  Stroheim via Fabricut AND Jim Thompson), so `POST /admin/purchase-orders` takes an OPTIONAL
  `supplier_id`, CHECKED by `supplierForBrand` (src/suppliers/brand-suppliers.js): one of the
  house's suppliers or a 422; absent means the main one (`brands.supplier_id`). The check is the
  gate because nothing else could catch it: every supplier id is a valid supplier id, so an
  unchecked value produces a perfectly well-formed purchase order addressed to the WRONG HOUSE.
  plan/generate still group by brand and address the MAIN supplier.
- **A brand with a NULL `supplier_id` is a 422 naming the brand**, and it fires on most houses
  today because `backfill:suppliers` has linked a minority of them. Schedule that; do not discover
  it. Two flavours deliberately: a manual create and a `generate` that NAMED the house both 422,
  while an unfiltered `generate` reports the house in `blocked` and raises the rest — refusing the
  whole run because 26 of 41 houses are unlinked would make the derivation unusable while the
  backfill catches up.
- **No integer-cents column exists anywhere in purchasing.** Cents is the storefront's money type
  (`orders.total_cents`, `order_lines.unit_price_cents`) and it is right there, because a
  storefront sale is NZD, whole and already converted. A purchase is foreign, fractional and
  unconverted. `purchase_order_lines.unit_price` is `numeric(12,4)` — the same type as
  `price_list_items.wholesale_rate`, asserted against the LIVE column rather than a transcribed
  literal. Mixing them turns €48.0000 into 48 cents and nothing in the schema objects.
- **`unit_price` is NULLABLE, and that is the schema admitting what it cannot do.** Nothing here
  can derive a purchase price for a colourway: `price_list_items` is keyed
  `(supplier, category, code)` and a supplier colour code has no path to a colourway (root
  CLAUDE.md — the corpus is evidence, not a key). So a derived line lands unpriced and staff type
  it. `CHECK (unit_price IS NULL OR unit_price >= 0)` — `>=`, not `>` the way `price_list_items`
  does it, because a free replacement roll is real. **NULL and 0 are different facts** and
  `Number(null)` is 0, so every read goes through `value == null ? null : Number(value)`.
- **Supplier, currency, agent, incoterm and PO email are SNAPSHOTS taken at create, and `suppliers`
  is deliberately NOT joined in the read model.** A purchase order is a document addressed to a
  house at a moment; re-pointing a brand at a new distributor next year must not rewrite who last
  year's orders were addressed to. Same argument as `sample_loans.holder_name`. `supplier_id` stays
  beside them as the link a report rolls up on. The four editable snapshot fields
  (`po_email`, `agent`, `incoterm`, `currency`) carry the `users.email` argument: a wrong PO address
  means the order reaches nobody, and correcting the paper is not the same act as re-pointing the
  brand.
- **`status` holds what a person did, or what the bank did — `draft | ready_to_send |
  pending_payment | paid | awaiting_delivery | received | completed | cancelled` (24 Sep 2026;
  migration `1791724800000` renamed `sent` → `pending_payment` and `closed` → `completed`;
  `ready_to_send` joined 25 Sep 2026, migration `1791811260000`) — and `completed` is NOT `full`.**
  See "The purchase-order lifecycle" below for the moves. `paid` is reached by hand or by the Xero
  bill sync; it is never cancelled — money that has left is a credit note, a document nobody has
  stated. A purchase order completed short because the house discontinued the balance is a
  DECISION; `full` is arithmetic about a warehouse. Storing the second beside the first gives two
  answers to one question the first time they disagree, which is the ordinary case. The vocabulary
  is `purchase_orders_status_check`; the transitions are `src/purchasing/po-states.js`, because a
  CHECK sees one row and cannot see which state a row is moving FROM. `test/purchasing.test.js`
  parses the live constraint and asserts the two agree.
- **Receipt state is DERIVED, never stored.** There is no `qty_received` column and there must
  never be one — `test/purchasing.test.js` scans `information_schema` for
  `qty_received|receipt_state|is_received` across every purchasing table and asserts none exists.
  Received is `COALESCE(SUM(r.qty), 0)`, a correlated scalar subquery in the projection (the
  `loan_count` posture — an aggregate join needs a GROUP BY over every selected column and can
  multiply rows). A stored counter and an append-only ledger disagree the first time somebody
  corrects a receipt, and nothing in the data says which was the lie.
- **A purchase order's receipt state rolls up from its LINES, never from its totals.** 10 received
  against a 5 + 5 order sums to `full` while one line is over and the other is empty, which is the
  one thing the office needs to see. `rollUpReceiptState` is the roll-up and it is unit-tested with
  no database.
- **Over-receipt is legitimate and is NEVER clamped.** Suppliers over-ship rolls. There is no
  comparison against `qty_ordered` anywhere in `receipts.js`, no `maximum` on the route's `qty`,
  and `qty_outstanding` is legitimately NEGATIVE — clamping it at zero would destroy exactly the
  discrepancy the office has to take up with the house. Same posture as the stock report's
  `available`.
- **A receipt is never edited and never deleted; a mistake is reversed by a negative row.** Hence
  `CHECK (qty <> 0)`, not `> 0`. There is no PATCH and no DELETE route, and
  **`purchase_order_receipt` has no lifecycle registry entry — the ABSENCE is the protection**:
  `requireEntity` throws a plain Error for an unknown name, so a DELETE route cannot be registered
  against the table even by accident. Nothing to argue with beats a guard that returns a refusal.
- **`consignment_ref` lives on the RECEIPT, not on the purchase order** (FR-144). A freight invoice
  is against a shipment — one container holding lines from several purchase orders — so the
  reference belongs where the physical arrival is. On the header it would be a lie the moment a
  house split a delivery. Partial index, because most rows carry none.

### The two aggregate rules the database cannot hold

- **`SUM(allocations.qty) <= purchase_order_lines.qty_ordered`, enforced with the line locked
  `SELECT … FOR UPDATE`.** An aggregate cannot be a CHECK — a CHECK sees one row and this rule is
  over a set — so the lock is what makes it hold under two concurrent allocations, the same posture
  `withOrderTxn` takes on an order. **`<=`, not `=`:** the unallocated remainder is a deliberate
  stock buy, because buying a full roll to cover a 25 m order is how this trade works.
  **`insertAllocation` is the ONLY path that writes an allocation** — the derivation and the manual
  allocate route both go through it — and the same lock guards the OTHER way the sum breaks: a
  `qty_ordered` edited DOWNWARDS leaves the allocations untouched and the line quietly stops
  covering them. Both are tested.
- **A sales-order line may be ordered exactly once, and the DATABASE says so.**
  `purchase_order_line_allocations_open_unique` is a partial unique index on
  `order_line_id WHERE released_at IS NULL`. The candidate query's `NOT EXISTS` makes the DRY RUN
  honest and **is not the guard** — it reads rows another transaction is about to write. The
  derivation is exactly what two staff run at once at 5pm, so the second claim is a caught 23505
  answered **409 naming the purchase order that already covers the line**, the same posture as
  `sample_loans_open_unique`. The covering order is found by a QUERY, never by parsing
  `error.detail` — that string is a pg display format, not an interface.
- **The index is PARTIAL because cancelling releases.** `cancelPurchaseOrder` stamps `released_at`
  on every live allocation, which drops the row out of the index and puts that demand back on the
  next derivation. A plain unique on `order_line_id` would mean a line cancelled by mistake could
  never be ordered from anybody again. The release is a STAMP, not a delete: the row records that
  this sales order was once on that purchase order. **`close` does NOT release** — the goods that
  did arrive were bought against those sales orders, and handing the demand back would have the
  next derivation buy it a second time. Both halves are tested.

### The derivation

- **`POST /admin/purchase-orders/plan` is a dry run that writes nothing, and `/generate` runs the
  SAME function and then writes what it returned.** One planner means the screen and the act cannot
  disagree about what was grouped — the rule the reporting layer states for a table and its CSV. A
  test counts `purchase_orders` before and after a plan.
- **Candidates are `reserves(kind)` × `HELD_STATUSES`, both IMPORTED from
  `src/orders/order-states.js` and never retyped.** A card checkout is excluded BY CONSTRUCTION —
  it is not a reserving kind, because it arrived paid with stock already decremented, so it is not
  demand to buy against — and shipped/completed/cancelled/refunded have already been settled. A
  local copy of either list is how the derivation and the reservation model start disagreeing about
  what is owed. A quote still at `quote_requested` IS demand: the office may buy before quoting.
- **`order_ids` narrows a plan or a run to named sales orders** (24 Sep 2026, the order page's
  "Create purchase order"), beside or instead of `brand_ids`. After a `generate` carrying
  `order_ids` commits, `backOrderRaisedOrders` moves every sales order that got an allocation to
  `back_order` through `setOrderStatus` (audit row, `order_back_ordered` letter) — only when
  `canTransition(status, 'back_order')`; an order the machine will not move (paid, already on back
  order) keeps its status and comes back in `not_moved: [{ order_number, status }]`. The purchase
  orders stand either way. A bulk run (no `order_ids`) moves nothing.
- **Grouping is by BRAND, and one supplier selling two brands correctly produces TWO purchase
  orders.** That is not a bug to fix later; it is the entire reason consolidated supplier invoicing
  (W14) exists as a separate concept. Tested explicitly, with both houses under one supplier.
- **ONE transaction over the whole run**: either the derivation happened or it did not. A
  per-group transaction would leave a partial run behind after a collision and the office would
  have to read the ledger to work out which houses had already been ordered from.
- `src/purchasing/po-plan.js` is a pure planner in the `src/suppliers/backfill-plan.js` posture — no
  pool, no config, no I/O — and its output is deterministic (brands by name, lines by SKU,
  allocations by order-line id), which is what makes a dry run worth reading. A test plans the same
  candidates in two orders and compares the JSON.

### Numbering

- **`purchase_orders_number_seq`, never `max(po_number) + 1`.** Max-plus-one reads the whole table,
  serialises every insert behind that read, and races anyway — two staff generating at 5pm mint the
  same number. `PO-` + six zero-padded digits from 1000, spelled in
  `admin-purchase-orders.js` (`PO_NUMBER`) rather than as a column DEFAULT so there is one copy of
  the format — the `GENERATED_BARCODE` posture.
- **The sequence does not reset per year, and a rolled-back transaction leaves a gap. A GAP IN A
  PURCHASE-ORDER NUMBER IS NOT A MISSING PURCHASE ORDER**, and that sentence belongs in the
  office's own documentation rather than in a support ticket a year from now. A per-year reset
  would need the year in the key to stay unique, and `PO-000412` appearing twice in the ledger is
  worse than a number that keeps climbing.

### The Xero bill

- **`xero_bill_id` / `xero_bill_ref` / `xero_bill_status` / `xero_bill_paid_at`
  are a MIRROR of Xero, beside `status` and never in it.** Send raises the bill
  (`src/xero/CLAUDE.md`); the sync route copies Xero's own answer back, and a
  `PAID` answer ALSO moves `status` to `paid` where the machine allows it
  (`SOURCE_STATUSES.paid` — pending payment, awaiting delivery, received; never a draft). The mirror stays beside it so the Xero
  bill number and its own status are readable whatever the office did next.

### Lifecycle

- **`purchase_order` is in the registry with two probes and `archivable: false`.** There is no
  `archived_at` column to match it (`test/lifecycle-registry.test.js` asserts the agreement):
  `cancelled` and `completed` already take a finished order off every list AND say why, which
  `archived_at` cannot, and a second vocabulary for "take it off my screen" is how two lists start
  disagreeing about what is open. The lines CASCADE — they are the document's body — while a
  receipt and an allocation each refuse.
- **The ORDER delete gains a fourth blocker.** `purchase_order_line_allocations.order_line_id` is
  RESTRICT, so an order already ordered from a supplier is no longer a mis-key anyone can delete.
  The probe reaches it through `order_lines` (the `product` entry's grandchild shape) and counts
  RELEASED allocations too — a cancelled purchase order still records that this order was once
  bought against. Without the probe the delete would still be refused, but as a bare 23503 reading
  "related records", AFTER `beforeDelete` had handed the reservation back inside the same
  transaction.
- **Five RESTRICT edges, five probes, five `CONSTRAINT_BLOCKERS` entries.** `brand` and `supplier`
  gain a `purchase_orders` probe, `colourway` and `product` gain `purchase_order_lines`. The
  supplier probe is NOT redundant with the brand one: a purchase order snapshots the house it was
  addressed to and outlives the brand link being changed, so a supplier can carry purchase orders
  while pointing at no live house.

### Finance gating

- **Cost figures go through `loadReportAccess(pool, request.user)` — never
  `reportAccess(request.user)`.** `src/auth/guards.js` loads `request.user` through
  `PUBLIC_USER_COLUMNS`, which carries no `can_view_finance`, so reading it off the request yields
  `undefined` and answers false to everyone, for ever. It is a primary-key lookup keyed on the id
  the SESSION resolved.
- **A masked figure is DELETED from the payload, not nulled** — `unit_price`, the derived
  `line_cost` and the order's `total_cost` are simply not built. A key that survives with an empty
  value still tells the reader which figures exist. The QUANTITIES stay: a showroom needs to know
  what is outstanding without seeing what it cost.
- **`total_cost` is `null` while any line is unpriced**, with `unpriced_lines` beside it. A total
  over a partly-priced order reads as the cost of the whole thing while describing part of it — the
  "a figure that cannot be added is ABSENT" rule the reporting layer already applies.
- The trade-portal guard sweep lives in `test/price-list-exposure.test.js` (extended, not
  duplicated): every purchasing route refuses an approved trade session. `unit_price` is what
  Atelier PAYS a maison — the same disclosure `wholesale_rate` is, arrived at by a different route.

### Sample lines (C18)

- **A sample on a purchase order is a LINE (`is_sample`), not a table** —
  `migrations/1789185600000_purchase-order-sample-lines.js`. A hanger is ordered, priced and
  receipted on the same paper as the cloth; what makes it different is what it is NOT: **a sample
  line never allocates sales demand.** `insertAllocation` (the one path that writes an allocation)
  refuses it, the PATCH refuses flipping a goods line that already covers demand into a sample, and
  the derivation cannot produce one by construction — the planner's lines come from open demand and
  a sample is added by hand. All three doors are tested in `test/purchasing-samples.test.js`.
- **`sample_barcode` is a reference BY VALUE, deliberately not an FK to `samples.barcode`.** The tag
  is often registered after the hanger arrives, and an FK would refuse the purchase-order line until
  the office had registered a sample they do not hold. A dangling barcode is an ordinary working
  state. `CHECK (is_sample OR sample_barcode IS NULL)` is one-directional on purpose: a barcode on a
  goods line is a keying error the schema can catch; a sample line with no barcode is normal (the
  value then flows nowhere and the manual field on the sample is the fallback). The 23514 is mapped
  to a 422 naming the fix.
- **Receipting a sample line flows its value into the register by barcode**, inside the receipt's
  own transaction (`receipts.js`): `unit_price` → `samples.unit_cost`, the order's snapshot
  `currency` → `cost_currency`. The NULL-vs-0 rule travels intact — a priced 0 FLOWS (the zero-cost
  free hanger is a recorded fact), a NULL price flows NOTHING (no-cost stays NULL, and never
  overwrites a value the office keyed by hand). **Only an existing register row is updated**; an
  unmatched barcode comes back in the response's `sample_register.unmatched` so staff register the
  tag and key the value manually — never minted into a row nobody described. The flow is
  deliberately NOT finance-gated: the price was keyed by an ungated purchasing write, the receipt
  carries it across without showing it to anyone, and gating would silently drop a value the office
  recorded.
- **No price column was added** — `unit_price` already carries the sample's price with the same
  NULL-vs-0 semantics as `samples.unit_cost`, which is exactly what lets the receipt copy one into
  the other without translating anything.

### `purchase_orders` is not `legacy_purchase_orders`

- **Different tables; neither feeds the other.** The staging mirror is what D365 held; this is what
  Atelier is buying now. The `legacy_` prefix is RESERVED — three suites assert the count of live
  `legacy_%` tables equals `Object.keys(LEGACY_TABLES).length` — so these four names stay
  unprefixed and must never enter `LEGACY_TABLES`. A test pins it in both directions.

### Test posture

- `test/purchasing-states.test.js` runs with **no database at all**: that is the proof `po-states.js`
  and `po-plan.js` are portable enough for the CRM to mirror (W13-US-009), not a convenience.
- **Fixture cleanup order is `purchase_order_receipts` → `purchase_orders` → `orders` → `brands` →
  `suppliers`.** Receipts are RESTRICT from the lines, the allocations are RESTRICT from
  `order_lines`, and `order_lines.colourway_id` is RESTRICT from the colourways — one wrong step
  and the cleanup itself 23503s in the next `beforeEach`.
- **A goods receipt moves stock — `qty_available` only, through `receiveStock` in
  `src/inventory/admin-inventory.js`** (24 Sep 2026, the client: "purchase order should also update
  the stock once received"; until then receipting fed no stock, by decision). It runs inside the
  receipt's own transaction: a receipt adds its quantity, a reversal (negative receipt) takes it
  back, and a reversal that would take the shelf below zero is a **422 that books no receipt** —
  correct the count on the Stock screen first. A **sample line moves nothing** (samples are not
  stock). **`qty_reserved` is never touched**: an order waiting on the goods reserved them when it
  was placed, so arrival raises what is on hand and leaves what is spoken for alone —
  `moveReservation` stays the sole writer of `qty_reserved`, because a second one breaks the
  reservation arithmetic SILENTLY. A colourway that has never been stocked gets its row on its
  first receipt, **starting `qty_reserved` at the demand its open reserving orders already hold**:
  the order desk reads every held line as reserving once a row exists, so a row born at 0 would let
  the first shipment drive the figure negative. The receipt answers with `stock` (the row after the
  move; null for a sample line). **This domain still writes no stock SQL of its own** — a source
  scan over `src/purchasing/**`, `src/routes/admin-purchase-orders.js`, the supplier-invoice route
  and every `migrations/*purchase-order*` bans `inventory` in a SQL position and
  `qty_available`/`qty_reserved` in any position (comments stripped first), so the movement cannot
  drift out of the inventory module. Tested end to end in `test/purchasing.test.js` (receipt,
  reversal, the below-zero refusal, the never-stocked row) and for samples in
  `test/purchasing-samples.test.js`.

## The purchase-order lifecycle, bulk orders and pricing (24 Sep 2026)

The client: purchase orders should have the statuses "Draft, Send PO (should create a bill against
that supplier in Xero), Pending Payment, Paid, Waiting on Delivery, Received, Cancelled, Completed",
with emails to the supplier, an email function like the sales order's, a Bulk order that sends one
supplier several purchase orders in one letter and is received back per sales order, and prices from
the wholesale rate less supplier discounts, with freight.

- **One route for every move: `POST /admin/purchase-orders/:id/status { status }`** replaced
  `/send`, `/pay`, `/close` and `/cancel`. `setPurchaseOrderStatus` runs the machine
  (`ALLOWED_TRANSITIONS`, 409) and, on `cancelled`, releases the allocations. The moves:
  `draft → pending_payment` (**Send PO**), `pending_payment → paid | awaiting_delivery | received |
  cancelled`, `paid → awaiting_delivery | received | completed`, `awaiting_delivery → paid | received
  | completed`, `received → paid | completed`. Goods may arrive before the house is paid (a supplier
  on account), hence `received → paid`. Cancelled only before money has left. One stamp per state:
  `sent_at` (pending payment), `paid_at`, `awaiting_delivery_at`, `received_at`, `closed_at`
  (completed), `cancelled_at`.
- **Send PO raises the Xero bill and writes to the house**, exactly as `send` did: the bill push
  never fails the move (`xero_bill.reason`), and the letter re-reads the finance view. **The letters**:
  Send PO → `purchase_order_sent` (+ the office copy), `paid` → `purchase_order_paid` (release the
  goods), `completed` → `purchase_order_closed` **only when a line is still outstanding** (nothing to
  stop otherwise), `cancelled` → `purchase_order_cancelled`. Awaiting delivery and received write to
  nobody. **Every letter to the house also goes to the purchase order's own Emails list**
  (`purchase_orders.notify_emails`, PATCHed whole like the sales order's, same pattern and cap from
  `src/orders/notify-emails.js`). Those letters carry prices, so **only a staffer who can see costs
  may change the list** — anyone else gets 403 (`updatePurchaseOrder`), else the list would be a way
  round finance masking. (`po_email`, on the purchase order and the supplier, predates this and is
  not guarded.)
- **Received is automatic too**: after a receipt, a purchase order whose roll-up is `full`/`over`
  moves to `received` where the machine allows it (the receipt route). A reversal moves nothing back;
  the receipt state beside the status still tells the truth.
- **`POST /admin/purchase-orders/:id/email { letter: 'details'|'status' }`** is the Emails panel —
  the sales order's rule: the letter IS the act, so 503 with no delivering mailer, 409 on a draft
  (Send PO is what first sends it), 422 at a status with no letter, 502 when every address failed;
  answers `{ template, sent, failed }`. To the house and the Emails list.
- **Bulk orders** (`src/purchasing/bulk-orders.js`, table `purchase_order_bulks`, number
  `BULK-000001` from its own sequence; `purchase_orders.bulk_order_id` RESTRICT): a GROUPING and a
  SEND, not a second kind of purchase order. `POST /admin/purchase-orders/bulk { purchase_order_ids }`
  takes DRAFTS of ONE supplier (409 for a non-draft, 422 for mixed suppliers, 404 for an unknown
  id), moves them all to `pending_payment` in ONE transaction, then raises each member's Xero bill
  and sends ONE letter (`purchase_order_bulk_sent`: every member's lines under its own PO number) to
  the house, every member's Emails list and the office. `GET /admin/purchase-orders/bulk` is the
  history; `GET …/bulk/:id` is the bulk with every member (lines, allocations, received) — which is
  what the CRM's receive screen splits back per sales order. Receiving stays per purchase-order line.
- **Confirming a client's stock is a sales-order action**: `POST /admin/orders/:id/stock-arrived
  { note? }` (src/routes/admin-orders.js) moves a `back_order` order to `processing` with the note on
  its timeline and sends `order_stock_arrived` to the client, the rep, the list and the standing
  copy; at any other status it moves nothing and still writes. The CRM offers it per sales order once
  every line it waits on has arrived.
- **A goods line is priced from the catalogue** (`src/purchasing/po-pricing.js`) unless a price is
  typed: `unit_price` = the design's `products.wholesale_rate` (supplier currency; the coming
  wholesale import fills it, the product page edits it) less the supplier's discount for the house
  (terms chain, product tier, supplier default) — the waterfall's `export_price` step — and
  `freight_per_unit` (NZ$, new column) = the house's freight rate — the `freight_amount` step.
  Blank is not zero: no wholesale rate or no discount stated leaves the line unpriced; a pricing
  refusal (4xx) leaves it unpriced rather than blocking the purchase order. Both are SNAPSHOTS at
  insert. The finance view carries `freight_per_unit`, `freight_cost` per line and `total_freight`
  (NZ$, absent while any goods line has no estimate), beside `total_cost` and never added to it.
- **The list takes a status SET** (`status` anyOf string|array, bound `= ANY`), for the dashboard's
  Inbound tile: goods on their way in = `pending_payment`, `paid`, `awaiting_delivery`.

## Ready to send, the PDF and the statement (25 Sep 2026)

The client: "Supplier invoice page and sections should be removed, ask for invoice should be merged
with bulk purchase orders. We should add a preview ability for purchase orders before sending it
(generate statement button creates PDF and attaches that pdf and sends it as an email, place this
generate statement button next to send bulk order button). Add a status to purchase orders called
Ready to Send after draft status (so that admin knows they can add it to other purchase orders for
bulk order for that supplier)."

- **`ready_to_send` sits between draft and pending payment and sends nothing.** Moves:
  `draft → ready_to_send | pending_payment | cancelled`, `ready_to_send → draft | pending_payment |
  cancelled`. Its stamp is `ready_at`; the move back to draft writes no stamp (`draft` has none —
  `moveStatus` skips a null stamp) and keeps the last `ready_at`. `UNSENT_PURCHASE_ORDER_STATUSES`
  (draft, ready_to_send) is what the Emails route 409s on. A ready order is still editable
  (`EDITABLE_STATUSES` is everything but cancelled), and Send PO still works straight from a draft.
- **A bulk order takes `ready_to_send` members ONLY** (`BULKABLE_PURCHASE_ORDER_STATUS`): a draft is
  a 409 naming it and saying to mark it Ready to send; anything already sent is the old 409.
- **One PDF renderer, `src/purchasing/po-pdf.js`, PURE (pdfkit only).** `order` is the purchase
  order itself (one, or a bulk order's members under its BULK number); `statement` asks for one
  invoice (a summary with each order's total, then each order's lines). The route's `letterPdf`
  attaches the `order` PDF to Send PO's letter, the Emails panel's `details` letter and the bulk
  letter (house copies AND the office copy) — **a render failure never stops a send**: it is logged
  and the letter goes without it. **Prices are drawn only when the rows carry them**: the masked
  read model DELETES the money keys, so their absence leaves the price columns off and prints a line
  saying so; `null` still prints "Not priced". Totals across orders refuse an unpriced order or two
  currencies (`documentTotal`). Dates are the NZ calendar day (`nzDate`), never an ISO slice.
- **`POST /admin/purchase-orders/pdf { purchase_order_ids, document? }` is the preview** the CRM
  shows before every send: `application/pdf`, `Content-Disposition: inline; filename=…`, writes
  nothing, drawn with the CALLER's finance grant (the house's copy is always the finance view). One
  supplier per document (422 naming the mix), 404 for an unknown id.
- **The statement moved: `POST /admin/purchase-orders/statement { purchase_order_ids, notes? }`**
  (`requestConsolidatedInvoice` in `src/purchasing/invoice-statements.js`; the old
  `POST /admin/supplier-invoices/statement` is gone). It derives the supplier from the purchase
  orders (no `supplier_id` in the body), sends `supplier_invoice_request` with the statement PDF to
  every order's PO email + Emails list (the bulk letter's rule, `documentRecipients`; the supplier
  record's PO email only when no order names anybody), copies the office with the same PDF, and
  logs the contact. Refusals, all BEFORE anything is sent and all run by the statement PREVIEW too:
  404 unknown, 422 mixed houses, 422 cancelled, **422 draft ("mark it Ready to send")**, 409 already
  on a supplier invoice, 422 nobody to send to, **503 unless `mailer.delivers`**, 502 when every
  address failed. It answers `{ statement: { sent, failed, filename, purchase_order_count,
  purchase_orders, contact_log_entry, … } }` — no money. Guarded by
  `test/purchase-order-statement.test.js` (which replaced `test/supplier-invoice-statement.test.js`)
  and, with no database, `test/purchasing-pdf.test.js`.
- **The supplier-invoice tables and routes STAY** (bills already keyed are records, and a purchase
  order on one still 409s a statement); only the CRM stopped drawing them.

## Consolidated supplier invoices (W14)

**One supplier sends ONE invoice covering MANY purchase orders, every two to four weeks.** That
sentence is the whole epic. W13 groups purchase orders by **brand** and one supplier sells several
brands, so there are always more purchase orders than invoices — a bill covering purchase orders
raised for two houses of one supplier is the ORDINARY case, not an edge one. Two tables —
`migrations/1787803200000_supplier-invoices.js` (the header),
`1787889600000_supplier-invoice-allocations.js` (the join) — behind
`src/routes/admin-supplier-invoices.js`, all `requireRole('backoffice')` (director inherits), with
`src/purchasing/supplier-invoices.js` holding every rule.

- **`purchase_order_id` is UNIQUE on the join, and it is a PLAIN unique rather than the partial one
  `purchase_order_line_allocations` carries.** A purchase order appears on exactly one invoice. A
  re-attach after a correction leaves two rows claiming one purchase order, every downstream report
  double-counts that spend, and **nothing in the data says which row was the mistake** — both are
  plausible and the error surfaces as a wrong total months later. It is not partial because there is
  no released-then-re-claimed life here: a `detached_at` predicate is exactly the shape that lets two
  live rows exist for one purchase order. **Detach is therefore a hard DELETE of the row**, and what
  makes it "an explicit act that is recorded" (FR-159) is that it is a route of its own
  (`DELETE /admin/supplier-invoices/:id/allocations/:poId`) rather than a side effect of saving a
  form. Trade-off stated plainly: this table cannot answer "which invoice was this on before?".
- **`supplier_id` IS accepted from the caller here, and that is not a contradiction of the purchase
  order's derivation.** A purchase order is addressed to the house Atelier picked by choosing a
  BRAND, so its supplier is a derivation with a right answer the client cannot see. An invoice
  ARRIVES from a house; the house is the primary fact on the paper and there is nothing to derive it
  from. What replaces the derivation is the next bullet.
- **An invoice's supplier must equal every allocated purchase order's supplier, enforced in the
  module as a 422 NAMING THE PURCHASE ORDER and both houses.** Expressing it in SQL needs a
  composite `(id, supplier_id)` unique on both parents plus two chained composite foreign keys and a
  denormalised `supplier_id` on the join — three columns and two constraints to say one sentence,
  and the copy then has its own way of being wrong. `supplier_id` is also absent from
  `SUPPLIER_INVOICE_UPDATE_COLUMNS` and must stay absent: moving an invoice to another house would
  leave every already-attached purchase order belonging to the old one, retroactively and silently,
  through a field that looks like a typo fix.
- **`SUM(allocations.amount)` is deliberately NOT constrained against `total_amount`, and no CHECK
  may ever be added.** The unreconciled difference IS the product — the screen exists to show a
  person how much of a €48,000 bill they have accounted for so far — so a constraint would refuse
  exactly the half-done state the feature is for. It could not be written anyway: a CHECK sees one
  row and this is an aggregate over a set. `unallocated_amount` is derived at read time and stored
  nowhere, and `status = 'matched'` is a JUDGEMENT a person makes, never arithmetic anything
  computes. A test parses every live CHECK on both tables and asserts none of them mentions the sum.
- **Two different differences live on the read model and they answer different questions.**
  `unallocated_amount` = total less what has been apportioned so far — how far through the
  reconciliation the office is. `variance` = total less what those purchase orders SAID they would
  cost (FR-154) — the commercial question, did the house bill what it quoted. Reported on screen,
  written nowhere. `variance` is `null` while any attached purchase order carries an unpriced line
  (`unpriced_purchase_orders` says how many), the "a figure that cannot be added is ABSENT" rule one
  grain up from W13's `total_cost`; a variance against a partial cost reads as a discrepancy that is
  really a missing price.
- **The variance is measured against the FULL invoice total, freight and duty INCLUDED, and that is
  a deliberate refusal rather than an oversight.** Freight and duty are RECORDED AND NEVER
  APPORTIONED (ADR 006): they are the ACTUAL charges for a consignment where `shipping_rates` is a
  forward estimate for a customer, both are correct, and merging them is the failure. The rule for
  pushing a non-line charge down onto a purchase-order line or a range is **owed by the client**, so
  a variance quietly computed against `total - freight - duty` would be this API inventing that rule
  and hiding it inside a subtraction. The two amounts travel beside the variance so a person can do
  it themselves. `fx_rate` is likewise recorded RAW and is multiplied by nothing — the FX basis
  (invoice date? payment date? the rate the bank gave?) is still open (A9).
- **A purchase-order cost is computed as `SUM(round(qty_ordered * unit_price, 2))`, which is
  `toLine`'s arithmetic expressed at this grain.** The invoice screen and the purchase-order screen
  must not disagree by a rounding rule about what one purchase order cost. `SUM` skips NULLs, so the
  `count(*) FILTER (WHERE unit_price IS NULL)` beside it is what stops a partly-priced order
  reporting a partial figure as the whole.
- **`amount` on the join is NULLABLE, the `unit_price` posture.** A consolidated invoice frequently
  does not break its total down per purchase order — it may not even quote Atelier's purchase-order
  numbers — so "attached, but nobody has said how much of the total is this one" is a real and
  common state. NULL is that; 0 is "charged at nil, and we know it"; `Number(null)` is 0, so
  `unstated_allocations` counts the rows contributing nothing rather than letting them be invisible.
- **`(supplier_id, lower(btrim(invoice_number)))` is unique, never `invoice_number` alone.** An
  invoice number is unique to the house that issued it — two maisons both numbering from 1001 is
  ordinary, and a global unique would refuse the second one's paperwork outright. It is
  `lower(btrim(…))` because the number is TYPED BY A HUMAN off a piece of paper (`  inv-2291 ` and
  `INV-2291` are the same bill keyed twice), the `supplier_aliases` posture. The 409 names the row
  ON FILE and its date, found by a query — echoing the caller's own spelling back reads as though
  the two are unrelated bills.
- **`invoice_date` is a `date` and leaves through `::text`.** pg's default parser turns a `date`
  into a JS Date at LOCAL midnight, which serialises as `2026-07-31T12:00:00.000Z` under an NZ
  session for an invoice dated the 1st of August — the paper says one day and the screen says
  another. A calendar day carries no instant. The date filters are consequently INCLUSIVE on `to`
  (`<= $n::date`), which is the opposite of the next-day-exclusive rule the `timestamptz` filters
  follow, and each is correct for its own column type.
- **`status` is on the PATCH while attach and detach are verbs, and that is one rule rather than an
  exception to it.** "Verbs, not status PATCHes" is about a move that writes two tables or writes a
  state and the stamp that dates it. `status` here writes one column of one row and dates nothing;
  attaching writes the join and carries its own refusals and its own attribution. There is no
  state-machine module beside `po-states.js` either: `matched` and `disputed` have no illegal
  moves between them, and a spine would be a rule to fight rather than a rule to keep.
- **`/unbilled` is a SEARCH, not a join (FR-158).** It is an open question whether a supplier's
  consolidated invoice quotes Atelier's purchase-order numbers at all; where it does not, matching
  is by DATE AND AMOUNT off the paper. So `q` (our own number) is one filter among several rather
  than the model, `amount_min`/`amount_max` are two plain bounds rather than a "tolerance" (a
  tolerance is a policy — absolute? percentage? of which figure? — nobody has settled), and
  **nothing here solves the subset-sum**: which COMBINATION of purchase orders adds to the invoice
  total is combinatorial and nobody asked for it. Cancelled purchase orders are excluded — an order
  the office says never happened is not something a house bills for, and leaving them in is
  permanent noise. **An amount search is finance end to end and answers 403 with a reason** to a
  login without the grant, the `maskReport` posture: "no rows" and "you may not see this" are
  indistinguishable on a screen and only the second is actionable.
- **The dependency between the two purchasing modules runs ONE WAY.** `supplier-invoices.js` imports
  nothing from `admin-purchase-orders.js`; the purchase-order read model imports
  `loadInvoiceStateByPurchaseOrderId` from it, so a purchase order carries `supplier_invoice` (null
  until it is billed) without the two forming a cycle. Same rule `receipts.js` states in the other
  direction.
- **Finance gating is the W13 gate, unchanged**: `loadReportAccess(pool, request.user)`, never
  `reportAccess(request.user)`. Every money key is DELETED from the payload rather than nulled;
  `allocation_count`, the houses each line is for and the invoice's identity all stay, so the bill
  is still navigable by a showroom login. `test/price-list-exposure.test.js` is extended (not
  duplicated) — a supplier invoice is a STRONGER disclosure than `unit_price`, being what a maison
  actually charged across a whole cycle with the freight and duty on top.

### The statement (Sept 2026)

**Moved on 25 Sep 2026 to `POST /admin/purchase-orders/statement`, sent as a PDF — see "Ready to
send, the PDF and the statement" above, which supersedes the route, the body and the refusals
below.** The rules that carried over unchanged:

`POST /admin/supplier-invoices/statement` asked a house for ONE invoice covering several purchase
orders — the letter the office typed by hand until then. `src/purchasing/invoice-statements.js` holds
it.

- **It writes no invoice, and must not.** A bill that has not arrived has no number, date or total,
  and those are facts only the house can state — a row invented for it would put a figure in the
  ledger no paper supports. What IS written is one `supplier_contact_log` entry (method `email`,
  `staff_user_id` from the SESSION), which is what the supplier list's Last-contact column reads.
- **It is refused WHOLE, never narrowed.** The refusals are the attach's own, in the same words: a
  **409** naming the bill that already covers one of the ticked orders, a **422** naming one raised
  for another house. A letter that went out with an order silently dropped from it is worse than one
  that did not go, because nothing on screen says so.
- **A cancelled order IS refused here, and that is not a contradiction of the attach accepting
  one.** Attaching a cancelled purchase order records what a house actually billed (the variance
  then says so); ASKING a house to bill an order Atelier withdrew is the office making the mistake
  itself.
- **No address on file is a 422, not a no-op.** The purchase-order moves treat a null `po_email` as
  "the office phones that house instead" and still move; here the letter IS the act, so there is
  nothing left to succeed at. An unconfigured mailer is a **503** for the same reason.
- **The letter carries costs and is not finance-masked** (the `notifyPurchaseOrderSent` rule: the
  house quoted them). The RESPONSE carries no money at all — it is read by whichever staffer pressed
  the button, and that reader may have no finance grant — so this module needs no finance flag.

### Lifecycle (W14)

- **`supplier_invoice` is in the registry with one probe and `archivable: false`** — no `archived_at`
  column, matching `purchase_order`, because `matched` and `disputed` already take a bill off the
  working list AND say why. Deleting one is refused while purchase orders are attached (FR-159); the
  way out is to detach, which is a decision about those purchase orders rather than a step in tidying
  an invoice away. **`supplier_invoice_allocation` has NO entry and must not get one** — absence is
  what makes a DELETE route against the join impossible to register.
- **Three new RESTRICT edges, three probes, three `CONSTRAINT_BLOCKERS` entries.** The purchase-order
  delete gains a THIRD blocker (an invoiced purchase order is on somebody's ledger) and `supplier`
  gains a `supplier_invoices` probe — **not redundant with its purchase-orders probe**, because an
  invoice can be keyed against a house before anything has been ordered from it.

### Deliberately not built (W14)

- **Nothing derives a landed cost.** See the freight/duty bullet: the apportionment rule is owed by
  the client, and this round records the information without changing anything — which is the
  client's own description of what they want.
- **No refusal for attaching a CANCELLED purchase order.** A house wrongly billing for an order that
  was cancelled is exactly the discrepancy the variance exists to surface, and refusing the attach
  would leave the office with a bill they cannot record. It is excluded from `/unbilled` (it is not
  something to go looking for) and accepted if somebody attaches it deliberately.
- **No credit notes.** `amount >= 0` and `total_amount >= 0`; a credit against a bill is a different
  document with its own rules and nobody has stated them.

### Deliberately not built

- **No `add_lines` / `remove_line_ids` on the PATCH.** A wholly wrong line means cancelling the
  order, which releases its allocations and lets the derivation raise it again; correcting a
  quantity or a price covers the rest. Add them when the office asks, not before.
- **No AdminJS resource** for any purchasing table, for the same reason `supplier_brand_terms` has
  none.
