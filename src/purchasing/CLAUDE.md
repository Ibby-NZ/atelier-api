# atelier-api — purchasing

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## Purchase orders (W13)

The buying desk: the day's open sales demand becomes purchase orders grouped by house, sent,
receipted against and closed. Four tables —
`migrations/1787544000000_purchase-orders.js` (header + `purchase_orders_number_seq`),
`1787630400000_purchase-order-lines.js` (lines + `purchase_order_line_allocations`),
`1787716800000_purchase-order-receipts.js` (the ledger) — behind
`src/routes/admin-purchase-orders.js`, all `requireRole('backoffice')` (director inherits).

- **`supplier_id` is DERIVED from `brands.supplier_id` at create and is NEVER accepted from a
  client.** No route schema names it, no whitelist contains it, and both write paths
  (`createPurchaseOrder`, `generatePurchaseOrders`) read it off the brand through
  `resolveBrandSupplier`. There is nothing a CHECK could catch: every supplier id is a valid
  supplier id, so a client-chosen value produces a perfectly well-formed purchase order addressed
  to the WRONG HOUSE, and the first anyone hears of it is that house shipping the goods. Ajv's
  `removeAdditional` strips a `supplier_id` a caller sends, so the derivation is the gate rather
  than the schema — a test posts one and asserts the derived value wins.
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
- **`status` holds only what a person did — `draft | sent | closed | cancelled` — and `closed` is
  NOT `full`.** A purchase order closed short because the house discontinued the balance is a
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
  demand to buy against — and `shipped`/`declined` have already been settled. A local copy of
  either list is how the derivation and the reservation model start disagreeing about what is owed.
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

### Lifecycle

- **`purchase_order` is in the registry with two probes and `archivable: false`.** There is no
  `archived_at` column to match it (`test/lifecycle-registry.test.js` asserts the agreement):
  `cancelled` and `closed` already take a finished order off every list AND say why, which
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
- **"Purchasing writes no inventory quantity" is asserted twice**, the samples posture: a source
  scan over `src/purchasing/**`, `src/routes/admin-purchase-orders.js` and every
  `migrations/*purchase-order*` for `inventory` in a SQL position and for
  `qty_available`/`qty_reserved` in any position (comments stripped first, so a comment may still
  EXPLAIN why receipting is not a stock movement), plus a real end-to-end run — create, send,
  receipt in full, close — that asserts the stock row is byte-identical afterwards. `moveReservation`
  stays the sole writer, and a second one breaks the reservation arithmetic SILENTLY.

### Deliberately not built

- **Receipting does not feed stock.** That is a decision, not an omission — see the invariant above.
- **No `add_lines` / `remove_line_ids` on the PATCH.** A wholly wrong line means cancelling the
  order, which releases its allocations and lets the derivation raise it again; correcting a
  quantity or a price covers the rest. Add them when the office asks, not before.
- **No AdminJS resource** for any purchasing table, for the same reason `supplier_brand_terms` has
  none.
