# Epics — "August 12th updates"

Eleven epics, one per workstream, in dependency order. The 1:1 mapping is load-bearing: each epic
becomes exactly one Ralph `prd.json`. **One exception:** W22's decoder spike is a research task with
no gates, so a loop with nothing to verify against is the wrong instrument — one supervised session.

Branch prefix `aug12/`. Integration branch `august-12th-updates` in all three repos.

Story sizing rule, unchanged: one story = one iteration = one context window. Hard ceiling **3 files
of new code + 1 test file**. **Migrations are always their own story.**

Every story's acceptance criteria end with the gates for the repos it touches. **The string
"Typecheck passes" must appear nowhere — there is no typecheck in any of these repos.** The real
gates are:

| Repo | Gates |
|---|---|
| atelier-api | `npm run lint && npm test` — vitest against a real local Postgres, `fileParallelism: false` |
| atelier-crm | `npm test && npm run build` — **no ESLint here**; `build` is the only compile check |
| atelier-storefront | `npm run lint && npm test` |
| Any converter change | `npm run convert:pricing && git diff --exit-code src/seed/data/price-lists.json` |

Migration stories additionally run `npm run migrate` twice and prove the second run is a no-op — the
programmatic runner returns an empty array.

## Wave schedule

```
Wave 1  W12 Order desk · W13 Purchase orders · W16 Freight (schema gated) · W17 Price history
        + W15's client-facing work, which is not a code story
Wave 2  W14 Supplier invoices · W15 Xero build · W19 Reserves + cuttings
Wave 3  W18 Self-service imports · W20 Samples round two · W22 Scanner
Wave 4  W21 Reporting codes
```

Rationale, and two supersessions of the approved schedule noted inline.

- Wave 1 runs four because the footprints are genuinely disjoint — proved in the ownership matrix
  below. **W12 is the only epic permitted to touch `orders` or `src/routes/admin-orders.js` this
  round.** W13 is entirely new tables under a new purchasing module: it reads the order read model
  and never edits it.
- **W17 replaces W15 in wave 1.** *(Supersedes the approved wave schedule; the architecture addendum
  wins.)* The addendum argues price history first — smallest, entirely internal, and every other
  area writes prices — and Xero last, because it is the only area whose design can be invalidated by
  facts nobody in this building holds. The split that takes both arguments: **W15's client-facing
  work starts in wave 1** — register the app, ask the Custom Connection question (F9), obtain a
  sandbox org — because that lead time is measured in weeks. Its **build** moves behind the spike
  answers. Purchasing stays in wave 1 on the blocking argument.
- **W16 and W17 can now run concurrently.** *(Supersedes the approved plan's "W17 cannot run
  alongside W16: both add a column to `AdminPriceListItems.jsx`".)* Addendum 2 dissolves that
  collision: freight is keyed on **range**, not on the price-list item, and `freight_class` stays
  raw provenance with the letters vanishing from every screen. W16's only CRM surface is a panel on
  `AdminSuppliers.jsx`. W16's schema is gated regardless (F1), which removes the last shared file.
- W14 is entirely blocked by W13 and cannot start earlier. W15's build, W19 and W20 each need a wave
  of settling first.
- W21 is last because it depends on the delivered supplier roll-up landing through W16's parameter
  read model, and because it is capped by a 52% resolution rate nothing in this round improves.

| Epic | Covers | Repos | Stories | Size |
|---|---|---|---|---|
| **W12** Sales order desk | C1, C9, C10, C11 | api + crm | 8 | M |
| **W13** Purchase orders | C2 | api + crm | 10 | **L** |
| **W16** Freight and landed cost | C19, C20, C21, C23 | api + crm | **10** | M/L |
| **W17** Price history and drop detection | C6, C7, C8 | api + crm | 9 | M/L |
| **W14** Consolidated supplier invoices | C3 | api + crm | 6 | M |
| **W15** Xero | C4 | api + crm | 9 | **L** |
| **W19** Reserves and cuttings | C12 | api + crm | 8 | M/L |
| **W18** Staff self-service imports | C25 | api + crm | **8** | M |
| **W20** Samples round two | C14, C15, C16, C18 | api + crm | 10 | **L** |
| **W22** First-party phone scanner | C17 | api + crm | 6 | M/L |
| **W21** Reporting codes | C22 | api + crm | 7 | M |
| | | | **91** | |

91 stories against the approved plan's 88 and last round's 69. **Do not commit all eleven.** Commit
waves 1 and 2 — seven epics, 60 stories — and re-plan the rest on what the client's answers turn up.

Three departures from the plan's story counts, each stated where it lands: W16 is 10 rather than 8
(one story already done, one story that did not exist when the plan was written), and W18 is 8
rather than 7 (the duty placeholder is now a bug with evidence, so it is a story rather than a note).

---

## Epic W12 — Sales order desk (`aug12/w12-order-desk`) · api + crm · 8 stories

**Goal:** an order can be found, tells the office it exists, tells the client it exists, and prints
without prices.
**Requires:** nothing. **Blocks:** nothing. The only epic permitted to touch `orders` this round.

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `orders.client_reference` and `orders.customer_po_number`, both nullable text | api |
| US-002 | `src/orders/order-filters.js` — pure whitelist, ILIKE escaping, clause builder, unit-tested with no database | api |
| US-003 | `GET /admin/orders` consumes the filter module and paginates with a total | api |
| US-004 | Back-office alert on every order-creation path — checkout, order request, manual order | api |
| US-005 | Client confirmation moves to creation; the confirm transition keeps a message of its own | api |
| US-006 | Reference and PO number in the admin order update whitelist, clearing to NULL | api |
| US-007 | Packing slip: the CRM print-window utility ported, driven by order lines | crm |
| US-008 | `AdminOrders` — search bar, filters, pagination | crm |

**Key acceptance criteria.** US-002 **must not reuse `src/reports/filters.js`**: its `parseSlug` is
safe only because slugs are `[a-z0-9-]` by construction, and a free-text reference has to bind as an
escaped `ILIKE`. A test proves a reference containing `%` and `_` matches literally.

US-004: `mailer.backofficeEmail` is already the single `admin@` address, and the commitment's real
content is the **restriction** — not per salesperson — which the current design already satisfies
and which someone would otherwise "improve" into a routing table. One line, plus the checkout path
that today mails the customer only. A mailer failure never fails the order.

US-005 is a real change, not a no-op: the confirmation template today fires on the admin `confirm`
transition. Moving it means both the checkout and the manual-order paths gain a send, and confirm
needs its own copy or a confirmed order re-sends the creation mail.

US-007 is a **port, not a build**. `atelier-crm/src/utils/packingSlip.js` is 64 lines, zero
dependencies, already escapes, already omits every money column, already tested. The only new part
is a mapper from order lines (`qty`) instead of purchase-order lines (`received`). ADR 008: print
window, no PDF renderer, no document entity — the codebase carries several deliberate "PDF is
deliberately not produced" refusals and this does not reverse them. A test asserts no money field
name appears in the rendered output.

---

## Epic W13 — Purchase orders (`aug12/w13-purchasing`) · api + crm · 10 stories

**Goal:** the day's confirmed sales become purchase orders, grouped by brand, receipted against.
**Requires:** nothing. **Blocks:** W14 entirely, W20's cost derivation, W21's spend report.

This is the widest gap between what the client believes exists and what does — the demo
`/purchase-orders` screens look finished.

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `purchase_orders` + the PO-number sequence | api |
| US-002 | Migration: `purchase_order_lines` and the allocation table, with the partial unique index on the order-line reference | api |
| US-003 | Migration: `purchase_order_receipts`, `CHECK (qty <> 0)`, consignment reference | api |
| US-004 | Read models: derived received / outstanding / backorder balance | api |
| US-005 | Derivation from confirmed sales-order lines grouped by brand; supplier derived from the brand | api |
| US-006 | Purchase-order CRUD routes and list filters | api |
| US-007 | Receipting route — append-only, over-receipt permitted | api |
| US-008 | Lifecycle registry entry, the fourth order blocker, delete refusals, cost-exposure test extension | api |
| US-009 | `AdminPurchaseOrders` — list, derive, review | crm |
| US-010 | Receipting screen and purchase-order print | crm |

**Key acceptance criteria.** US-002: the anti-double-order guard is a **partial unique index, not
application code**. The derivation is exactly what two staff run at once at 5pm, so the second run
must be a caught 23505 → 409 naming the existing purchase order, the same posture as
`sample_loans_open_unique`. A test runs two derivations concurrently and asserts one purchase order
and one 409. The allocation carries a quantity and `SUM(qty) <= qty_ordered` — `<=`, not `=`,
because the remainder is a deliberate stock buy; without a quantity a 40 m line cannot say 25 m is
for one order and 15 m for another, and a short delivery has no basis on which to split.

US-005: grouping by **brand** will correctly produce two purchase orders to one supplier when that
supplier sells two brands — that is the whole reason W14 exists, and it is not a bug to fix.
`supplier_id` is derived from the brand at create and **never accepted from a client**: a
client-chosen value produces no CHECK violation, it silently addresses the order to the wrong house.
A brand with a NULL supplier is a 422, and **that fires on 26 of 41 houses on day one** because the
supplier backfill has linked only 15. Schedule that, do not discover it.

US-007: **receipting writes no inventory row in this epic.** `moveReservation` is the sole owner of
`qty_reserved` and a second writer breaks the reservation arithmetic silently — this is the single
invariant W13, W19 and W20 can each break independently. Receipt state is derived, never stored, and
`status` holds only what a person did: `closed` ≠ `full`. A receipt is never edited or deleted; a
mistake is a negative row.

US-001: **no integer-cents column anywhere in purchasing.** Cents is the storefront's money type; a
purchase is foreign, fractional and unconverted. `unit_price` is `numeric(12,4)` — exactly
`price_list_items.wholesale_rate`'s type, which is where the number comes from. Mixing them turns
€48.0000 into 48 cents. Numbering is a sequence, never `max+1`; the sequence does not reset per year
and a rolled-back transaction leaves a gap, so the office's documentation must say that **a gap in a
purchase-order number is not a missing purchase order**.

US-008: `order_lines` is RESTRICT from the allocation, so the order delete gains a fourth blocker.
`test/lifecycle-registry.test.js`'s `information_schema` agreement check **fails until the probe is
added** — that is the tripwire working, not a broken test.

---

## Epic W16 — Freight and landed cost (`aug12/w16-freight`) · api + crm · 10 stories

**Goal:** landed cost is computed from the client's own parameters, in dollars, and names what it is
missing.
**Requires:** nothing. **Blocks:** nothing. **Its schema is gated on F1.**

Four commitments are one workstream, which is the client telling you where the pain is. It is also
the one place the system is actively *wrong* rather than merely absent.

**10 stories, not the plan's 8.** US-001 already landed, and US-003 did not exist when the plan was
written — the parameter export arrived on 12 August and made the freight letters recoverable by
arithmetic for the first time.

| # | Story | Repos |
|---|---|---|
| US-001 | **DONE** — the pricing parameters staged as `legacy_tracking_options` | api |
| US-002 | Parameter read model over the staged rows: range → duty bands, clearance, freight, discount, trade markup | api |
| US-003 | Freight-letter recovery planner — pure, reports, never writes | api |
| US-004 | **BLOCKED (F1)** — migration: the freight rate table | api |
| US-005 | Freight rate resolver — null with a named reason, never zero | api |
| US-006 | `src/pricing/waterfall.js` — partial result naming every missing input | api |
| US-007 | Landed-cost preview route + cost-exposure test extension | api |
| US-008 | Rate CRUD routes, `effective_from` append-only | api |
| US-009 | Rate CSV round trip: export, edit, validate, apply | api |
| US-010 | Freight panel on `AdminSuppliers` | crm |

**US-001 is done.** Migration `1787284800000_legacy-tracking-options.js`, entity
`fulmxero_trackingoption` in `scripts/lib/d365-entities.js`, wiring in `src/seed/legacy-entities.js`
and `src/seed/legacy-import.js`. Landed on `aug12/w16-freight-parameters`. It is the twelfth staging
table and the first that is a **parameter set** rather than a transaction or a catalogue row — one
row per (house × product line) Atelier prices differently, both saved views landing together. The
columns keep the source's names and polarity deliberately, because two of them are mislabelled at
the source: `clearance` is a **percentage** despite being the only percentage column without a `(%)`
suffix, and `freight` is **dollars per unit** and never was a percentage. Renaming either would be
the staging layer stating an interpretation. Note for whoever runs the suites: a twelfth `legacy_*`
table turns three green suites red on the migration alone until their table-count assertions are
updated in the same commit.

**US-004 is BLOCKED and the epic says so.** *(Supersedes ADR 005; Addendum 2 wins.)* ADR 005 keys
freight on **supplier × category**. The client's own engine keys pricing parameters on **range**:
`Name` hits `legacy_product_prices.range_name` on **48 of 58 rows covering 99.6% of priced rows**,
while `Supplier` matches a live supplier on only **8 of 28** — it is a lookup rendered as a display
name, with `supplier_aliases` empty and `short_code`/`d365_token` NULL on all 40 rows. And **25 of
43 ranges use more than one freight letter** with a wide spread, so range alone is insufficient too:
the real key is **range × letter**. The client is not wrong to have asked for supplier level and her
reason is good — one supplier ships four houses fortnightly — but **the migration source and the
target grain differ**, which the approved plan did not anticipate.

The blocking question for Derek (F1): the exported `Freight` column agrees with the letter-implied
rate in only **30 of 43 ranges**. One range's column is blank while its rows imply four distinct
rates; another says 30 while all 209 of its rows imply 50. Either the column overrides the letters
or the corpus values are stale — and that decides whether the recovered table or the exported column
is the migration source. **No rate is written anywhere until it is answered.** Everything else in
this epic is unaffected and proceeds.

**Key acceptance criteria.** US-003 is a pure planner in the `src/suppliers/backfill-plan.js`
posture: **it reports, it never guesses and it never writes.** `landed ÷ (1 + clearance/100) −
price incl duty` is constant per (range × letter) on **19,197 of 19,201 rows**, so the letter →
dollar table is recoverable by arithmetic from the corpus. The report names every bucket, its row
count, and every disagreement with the exported column. It lands beside the ledger, never in it —
the same posture `duty_percent` already takes, because a placeholder written into the ledger would
be indistinguishable from a rate a supplier quoted.

US-005: a missing rate returns **null with a reason**. `Number(null)` is 0, and a zero freight rate
reads as free shipping from Italy. Blank means zero for discount and for the duty letter — verified,
all 4,638 rows in a blank-discount range show a 1.000 ratio — but **blank means UNKNOWN for
freight**. Do not write one COALESCE for all of them.

US-006: the waterfall returns `{ steps, landed: null, missing: [...] }`, the `net_multiplier: null`
+ `invalid_reason` posture already used by the supplier terms module. A landed cost that silently
treats four missing inputs as zero looks authoritative and is wrong by a factor. Freight is the
second of seven inputs to get a home; FX rate and margin, the clearance fee as a stored column,
handling per unit and the retail markup are all still owed. Step order is
`(price incl duty + freight$) × (1 + clearance%)` — the demo file applies clearance before freight
and duty after both, which is a different number on every row.

US-004, when it unblocks: **no `brand_id` on the freight table.** Recording that absence is the
point of the story, because `supplier_brand_terms` is per-brand and someone will copy that shape by
reflex. A new `effective_from` row never overwrites the old one, which is what makes the ≥5% annual
uplift auditable. `price_list_items.freight_class` is **neither dropped, backfilled nor
reinterpreted** — it stays the raw letter from the supplier's own file and remains the only
surviving evidence of what D365 charged, which is what makes a 2024 landed cost reconcilable.

US-007 extends `test/price-list-exposure.test.js` rather than adding a second exposure test.

---

## Epic W17 — Price history and drop detection (`aug12/w17-price-history`) · api + crm · 9 stories

**Goal:** a price that changes leaves a record, and a code that drops off a list stops being
silently live.
**Requires:** nothing. Runs beside W16 — the collision the approved plan named has dissolved.

C7 is usually read as an enhancement. It is not: a code that drops off a new price list is never
detected, never archived and never flagged, and stays a live sellable price for ever.

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: the two history tables, real FKs, `source` NOT NULL, the manual-reason CHECK | api |
| US-002 | Migration: the plpgsql capture triggers, with a loud comment | api |
| US-003 | Trigger coverage test — a bare SQL `UPDATE` on a raw connection produces a history row | api |
| US-004 | Manual edit demands a reason: 422 without it, `source = 'manual'` written | api |
| US-005 | Importer writes `source = 'import'` with `source_file` and `date_effective` | api |
| US-006 | As-at rate lookup resolving on `changed_at` | api |
| US-007 | Migration: `last_seen_in_import`, `last_seen_source_file`, `discontinued_at` on `price_list_items` | api |
| US-008 | Drop detection scoped `(supplier, category)`: coverage report, suspect derived, discontinued marked by an explicit act | api |
| US-009 | CRM: history tab, coverage confirmation, discontinued red / suspect amber | crm |

**Key acceptance criteria.** US-001: **two tables with real foreign keys, not one polymorphic
table.** *(Supersedes the single-table sketch in the approved plan's W17 section; the architecture
addendum wins.)* A polymorphic key cannot be a foreign key, and the D365 override layer already
records what keying on a string costs. `ON DELETE RESTRICT`, not CASCADE — with CASCADE, deleting a
price-list item would silently destroy exactly the history this feature exists to preserve, and the
next re-import would recreate the row looking new. Consequence:
`DELETE /admin/price-list-items/:id` stops being freely available for any item whose price has ever
moved. Staff will notice; it is correct.

US-001: **the column that is NOT NULL is `source`, not `reason`.**
`CHECK (source <> 'manual' OR (reason IS NOT NULL AND btrim(reason) <> ''))`. The database enforces
"a hand edit carries a note" and it cannot be bypassed by the AdminJS panel, a route somebody adds
later, or a psql session — which is what the mandatory-note commitment actually means. A typed
reason per row is impossible across a 19,500-row import, so an import carries `source = 'import'`
plus `source_file` and `date_effective` and **that is its reason**. Say that to the client rather
than shipping a `NOT NULL` the importer fills with `'import'`.

US-002 and US-003: **capture is a database trigger (ADR 007), not application code.** The importer
writes in chunked `unnest` upserts and `RETURNING` after `ON CONFLICT DO UPDATE` gives the new row,
not the old — so a JS delta needs a second query and covers only the writers somebody remembered.
`OLD` is free and catches every writer. plpgsql is already an idiom here. The cost is invisibility,
so the migration comment is loud and **US-003 is the only thing making "every writer" true rather
than aspirational.**

US-006: `changed_at` and `date_effective` are different axes and must never be conflated —
`changed_at` is when our ledger changed, `date_effective` is what the supplier's paper said. A quote
given on 3 March used the rate the ledger held on 3 March. The as-at lookup resolves on `changed_at`
and returns `date_effective` beside it, one indexed query. **That endpoint is the feature**; it is
what makes the year-in-SKU practice droppable. And it is worth nothing on day one — the trigger
starts recording the day it ships and the client needs 2023. Loading history is a
`source = 'migration'` backfill with back-dated `changed_at`, permitted to the loader and forbidden
to any route, and its only candidate source is the all-states D365 re-pull named under the licence
deadline.

US-008: **drop detection scopes by `(supplier, category)`, not by `source_file`.** *(Supersedes the
approved plan; the architecture addendum wins.)* Filenames carry the year — `BOUSSAC FABRIC PL
2026.csv` — and change annually, so file-to-file comparison has no stable key. Per supplier alone is
also wrong: a house that sends only its wallpaper list in March would mark its entire fabric range
discontinued. Record evidence and derive the flag: two more entries in the importer's existing `SET`
list, no extra statement. **Detection is never automatic** — the import records what it saw and
flags nothing; marking is an explicit staff act. The confirmation screen states coverage before it
acts — *"this file covered 412 of the 2,516 codes we hold for Boussac fabric — marking 2,104
discontinued"* — which stops the partial-file mistake by itself; no percentage threshold is coded.
A supplier re-listing a code **clears** the mark.

US-009: **two states.** *Suspect* is derived and renders amber, *discontinued* is stored and renders
red. Without the first, a partial file silently produces nothing; without the second, there is no
way to dismiss a wrong suspicion. `discontinued_at` ≠ `archived_at` — supplier stopped selling it,
versus staff took it out of the list. A discontinued item blocks nothing; it is information. The
styling is ten minutes; **the state vocabulary is a client decision** and the screen ships with the
two states above rather than guessing at four.

---

## Epic W14 — Consolidated supplier invoices (`aug12/w14-supplier-invoices`) · api + crm · 6 stories

**Goal:** one supplier invoice covers many purchase orders across a 2–4 week billing cycle.
**Requires:** W13 merged — entirely.

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `supplier_invoices` | api |
| US-002 | Migration: the join table, `purchase_order_id` **UNIQUE** | api |
| US-003 | Invoice read model including the derived variance | api |
| US-004 | Invoice CRUD, attach and detach, with the 409 and the supplier-mismatch 422 | api |
| US-005 | List filters, date/amount matching search, cost-exposure test extension | api |
| US-006 | `AdminSupplierInvoices` — create, attach, see the variance | crm |

**Key acceptance criteria.** US-002: `purchase_order_id` is **UNIQUE** on the join. A purchase order
appears on exactly one invoice, or a re-attach after a correction double-counts spend in every
downstream report with nothing in the data saying which row was the mistake. A test attaches twice
and asserts a 409 naming the holding invoice.

US-003: variance between the invoice total and the summed line cost is **reported on screen, never
written**. The invoice's `freight_amount` holds the *actual* freight for the consignment, and
**ADR 006: an actual freight cost never writes back to a rate, a price or a sell figure** — that is
precisely the client's "it kept the information, didn't change anything". The rate table is a
forward estimate; the actual is backward-looking. Both are correct and merging them is the failure.

US-005: money is `numeric(12,4)` in the supplier's invoicing currency, matching purchasing exactly.
Where the supplier does not quote Atelier's purchase-order numbers (F1-adjacent, still open),
matching is by date and amount, so the screen offers a **search rather than a join**. The schema
assumes a purchase order may not be split across two invoices; if the client says otherwise the
UNIQUE becomes the story to re-open.

---

## Epic W15 — Xero (`aug12/w15-xero`) · api + crm · 9 stories

**Goal:** push a sales invoice to Xero from the CRM; Xero sends it to the client.
**Requires:** US-001's answers before US-002 starts. The client-facing half starts in wave 1.

Split it in the plan and in the quote. **Xero-out** is a mapper from the existing order read model
plus a write-back, and needs no new invoice entity — the order already carries lines, quantities,
prices and a recomputed subtotal. **Xero-in** (payment status) is a different problem: there is no
Xero Payments webhook, so it is polled, which needs the scheduled worker this platform does not have
and this round does not introduce.

| # | Story | Repos |
|---|---|---|
| US-001 | Spike (not under Ralph): Custom Connection availability, org choice, multi-currency, account code and tax type per line class, who emails the invoice | docs |
| US-002 | Migration: `xero_connections`, the invoice-id column, the sync log, `colourways.xero_item_code` | api |
| US-003 | Token store — `aes-256-gcm` at rest; refresh under `FOR UPDATE` with a re-read | api |
| US-004 | Injected Xero client and the capture double | api |
| US-005 | Connect / callback routes and `GET /admin/xero/status` | api |
| US-006 | Contact resolution — trade account then user; `legacy_accounts.xero_contact_id` backfill | api |
| US-007 | Invoice mapper from the order read model | api |
| US-008 | `POST /admin/xero/invoices` — the non-null refusal, commit before call, no blind retry | api |
| US-009 | CRM: push from the order screen, status panel, last error | crm |

**Key acceptance criteria.** US-001 is worth more than the rest combined: **is Atelier on a Xero
plan offering a Custom Connection?** Machine-to-machine, single-tenant, `client_credentials` — no
user consent, no rotating refresh token, no 60-day cliff. If yes, most of US-003 and US-005
disappear. **Ask before building anything.**

US-003: **a Xero refresh token rotates on use.** Two concurrent requests refreshing with the same
token leave one holding a dead credential and the connection unrecoverable without a human
re-consenting. A single pm2 process does not save you — Fastify is concurrent inside one process.
The refresh runs inside a transaction taking `SELECT … FOR UPDATE` on the connection row and
**re-reads the token after acquiring the lock**, so the loser of the race finds a fresh valid token
and never calls Xero at all. This is the `withOrderTxn` idiom applied to a credential. Tokens are
encrypted at rest with `aes-256-gcm` under a new key — Node's `crypto` does this in about 15 lines,
no dependency — and the decisive local fact is that this working tree holds a database archive and
three SQL dumps. `xero_connections` is **never exposed by any route**: not an AdminJS resource, not
in any read model, no `SELECT *`, enforced by a source scan plus a response-body scan.

US-005: the 60-day cliff is an operational fact, not a bug. A refresh token expires 60 days after
last use, and with no scheduler nothing keeps it warm — an integration idle over a quiet December is
dead in January, and only a director re-consenting fixes it. A status endpoint and a visible last
error are what turn a week of missing invoices into a five-minute reconnect.

US-008: **the local write commits BEFORE the Xero call, and a Xero failure never rolls the order
back.** This deliberately inverts the Stripe webhook's all-in-one-transaction rule, and inverts for
a reason: Stripe's event is replayable by Stripe, a Xero invoice is not replayable by us. An order
with no invoice is recoverable; an invoice with no order is not. A `pending` sync row is **never
blind-retried** — it queries Xero first, because the failure that costs real money is a call that
succeeded at Xero and failed to record locally, after which a null invoice id reads as "not pushed"
and a retry raises a second invoice. The push **refuses to overwrite a non-null invoice id** or a
double-click bills the client twice.

US-007: `orders.xero_invoice_ref` stays a staff-typed reference and is **never repurposed as the
id** — overloading loses the manual history on the first push. The Xero contact is the trade account
where one exists and the user otherwise: Xero bills a company, and billing the individual designer
rather than the practice is wrong for a trade business. **ADR 004 — item sync is deferred, the
mapping column is not.** The sellable grain is the colourway, and once the colour files land that is
45,923 colourways; at roughly 5,000 calls/day/tenant that is about thirteen days of continuous API
traffic for a nicer Xero item report. Phase 1 pushes a description and an amount and no item code.

**No invoice template goes into `src/email/templates.js`** — the client's own words are that Xero
sends it, and two systems mailing the same invoice is the failure mode. **Xero is never called in
tests**; the client is injected at `buildApp` like the Stripe and mail transports, and a capture
double proves it.

---

## Epic W19 — Reserves and cuttings (`aug12/w19-reserves-cuttings`) · api + crm · 8 stories

**Goal:** reserves and cuttings are requests the platform records.
**Requires:** nothing in code. **Process-blocked on F11** — the written process is owed from
Charlotte since 30 June, and un-shelving does not unblock it.

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: widen the `orders.kind` CHECK to a fifth kind | api |
| US-002 | Reserve create / list / decline / convert through the existing state machine | api |
| US-003 | Migration: cutting requests in the sample-order shape, with an image URL | api |
| US-004 | Cutting request module and routes; no inventory write | api |
| US-005 | Lifecycle registry entries and delete/archive policy for both | api |
| US-006 | PII test: `legacy_cuttings.comments` is never read, and no migration copies it | api |
| US-007 | CRM `/reserves` — a request screen replacing the mirror-only view | crm |
| US-008 | CRM `/cutting` — writing for real, with the image field | crm |

**Key acceptance criteria.** US-001, **ADR 003: a reserve is a fifth `orders.kind`, not a new
table.** The order state machine already holds `qty_reserved`, already releases on decline and
already converts on ship; `moveReservation` is its single writer and a second one breaks silently.
Widening the CHECK inherits the state machine, the lifecycle registry, the reports and the CRM's
`KIND_LABELS` — the `manual` kind precedent did exactly this. Two tables would be a bigger diff
*and* a correctness regression.

US-002: whether a reserve **holds stock or is a soft note** is F7 and decides the epic's shape. Until
it is answered the reserve kind is created without touching stock, and the difference is one call
site rather than a redesign. Nothing outside `src/orders/admin-orders.js` writes `qty_reserved` —
the programme-level test asserting exactly one writer is the tripwire, and this epic is one of three
that can break it.

US-003 and US-004: **a cutting is a sample, not stock.** It takes the `sample_orders` shape, holds
no reservation, and **copies nothing out of `legacy_cuttings.comments`** — 1,757 of 1,886 rows hold
third parties' names, emails, phones and home addresses. Migrating cuttings is a PII decision, not a
table copy, and FR-49 plus an existing test already forbid it. US-006 makes that explicit for this
epic, which is the one most likely to break it.

US-008: the image on a cutting is **functional, not cosmetic** — you cannot identify a fabric scrap
without it — and it is the single carve-out from C13's parking. It is a URL column, exactly like
`hi_res_asset_url` and `colourways.image_url`, so it costs no object storage, no bucket, no CDN
origin and no lifecycle policy.

---

## Epic W18 — Staff self-service imports (`aug12/w18-self-service-import`) · api + crm · 8 stories

**Goal:** the office imports and edits its own price lists, without a developer and without a
placeholder rate.
**Requires:** W17's importer columns merged (US-005 and US-007 there touch the same `SET` list).

**8 stories, not the plan's 7.** The duty placeholder was a note in the approved plan. It is now a
bug with evidence, so it is US-005.

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `import_runs` — who, when, which file, row counts | api |
| US-002 | Dry-run endpoint: reports what would change, writes nothing | api |
| US-003 | Apply: one transaction, idempotent, loud failure naming `file:line` | api |
| US-004 | Unmappable category values reported per row rather than dropped | api |
| US-005 | **Delete the 7% duty placeholder** | crm |
| US-006 | Correct the waterfall preview's step order to the incumbent's engine | crm |
| US-007 | Port the import wizard off `importStore.js` onto the API | crm |
| US-008 | Import run history screen | crm |

**Key acceptance criteria.** US-005: **the placeholder is deleted, not corrected to 5.**
`atelier-crm/src/utils/importer.js:12` holds `const DUTY_PLACEHOLDER = 0.07`, applied on three
separate paths — blank duty, a lettered duty code, and an unreadable value — each emitting a warning
citing A10. `src/data/pricing.js:29` carries the same `duty: 0.07` in the vendored waterfall (and
so does its copy at `src/seed/data/pricing.js:29` in the API, which the seed uses for indicative
prices). **A10 is now closed and the evidence says 7% is wrong, not stale.** The value 7 appears in
no band on any of the 58 ranges. The real rate is **5% on duty class A** — 54 of 58 ranges — with
three per-range exceptions: one bedding line at 10% across all three bands, one domestic supplier at
0% across all three, and one range whose bands genuinely differ from each other (5 / 10 / 5). Bands
B and C are real parameters that **not one row in either corpus** has ever exercised, so they are
storable and unvalidated.

Deleting rather than correcting is the point: the exceptions are **per range, not per class**, so a
single constant is wrong at any value. A blank or lettered duty cell must yield **no duty value at
all** — the duty letter is on the price row and the rate is on the range, both are needed and
neither is sufficient, and a row with letter `A` in a range whose band A is blank has no defined
duty. `price_list_items.duty_percent` stays NULL until a real file carries a real number; the
parameter export is a *parameter* source, not a file. `importer.test.js`'s two assertions expecting
`0.07` are updated in the same story — that is the third file, and it is the test file the ceiling
allows.

US-006: the demo waterfall computes
`priceExDuty = supplierDiscounted × (1 + clearance) + freight`, then duty, then handling. The
incumbent's engine, verified on 19,197 of 19,201 rows, is
`landed = (price incl duty + freight$) × (1 + clearance%)`. Duty comes **before** freight and
clearance multiplies **both**. The ordering is wrong independently of the 8% and the 7%, and it
moves every row that carries any of them.

US-002 and US-003: a dry run writes nothing and a failure is loud, names `file:line` and writes
nothing — the converter's own posture. A file whose header matches no registered template is refused
with every accepted header listed, because **the header row is the version**. US-004: `Leather`,
`Samples and Displays` and `Throws/Blankets` fall outside the current category CHECK and **96 rows
cannot be imported today** — they are reported per row with the value seen, not silently dropped.

**`npm run convert:pricing && git diff --exit-code src/seed/data/price-lists.json` must still pass
after this epic.** The self-service path is a second way in, not a replacement.

---

## Epic W20 — Samples round two (`aug12/w20-samples-two`) · api + crm · 10 stories

**Goal:** outstanding samples are chased, valued and barcoded.
**Requires:** nothing hard. The value derivation from receipting is parked behind W13 and F17.

Most of C14's data half is **already built and must not be rebuilt**:
`sample_loans.trade_account_id` exists, `checkOutSample` already accepts it, `due_back_at` exists,
overdue is already derived and already filterable. The real gaps are an *outstanding* read across
the whole register and the reminders.

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `samples.unit_cost` nullable with `>= 0` | api |
| US-002 | Migration: the barcode sequence | api |
| US-003 | Migration: `email_templates` | api |
| US-004 | Outstanding-loans read across the register, filtered and paginated | api |
| US-005 | Barcode generation endpoint; duplicates stay a database refusal | api |
| US-006 | Template store with a fallback to the code template | api |
| US-007 | Reminder compose and send, recorded | api |
| US-008 | Sample value read/write with the null-vs-zero coercion; cost never client-facing | api |
| US-009 | CRM: outstanding report, reminder work queue, compose-before-send | crm |
| US-010 | CRM register: generate a barcode, record a value | crm |

**Key acceptance criteria.** US-007 and US-009: **no scheduler is built, and that is deliberate.**
"Editable before send" and "sent automatically at 2am" are contradictory; the client asked for the
first, so the reminder is a staff action off a work queue. That keeps the platform's property of
having **no cron, no worker and no queue** — worth saying back to her as the simplification she
asked for without knowing it. US-006: a template row falls back to the code template, so a deleted
row can never break a send.

US-001 and US-008: `CHECK (unit_cost IS NULL OR unit_cost >= 0)`, **deliberately not `> 0`** the way
`price_list_items` does it, because a free hanger is normal. **NULL and 0 are different facts** —
NULL is "nobody recorded a cost", 0 is "free, and we know it". `Number(null)` is 0, so every read
needs `value == null ? null : Number(value)` or a sample-value report counts every unpriced hanger
as a gift. Cost never reaches a client-facing response.

US-002 and US-005: `samples.barcode` is already `NOT NULL UNIQUE` and duplicates are already refused
by the database (23505 → 409). **Duplicate prevention is already correct and is not
re-implemented** — this is a sequence and a generate button. The barcode *format* and the label
printer are F17 and are stated, not invented: generating barcodes with nothing to print them on is
the part that actually blocks the showroom, and it is why W22 is sequenced behind this epic.

**Parked, not counted:** deriving a sample's value from purchase-order receipting. It is blocked on
a decision rather than on code — three hangers is three physical objects, three rows and three
barcodes, and nobody has stated the barcode-minting policy or specified a label printer (F17). It
drops cleanly if W13 slips, which is why the manual value ships alone.

---

## Epic W22 — First-party phone scanner (`aug12/w22-scanner`) · api + crm · 6 stories

**Goal:** a scan from a phone writes to the CRM, with no third-party dependency.
**Requires:** W20's barcode generator. **Per ADR 002, which supersedes ADR 001.**

| # | Story | Repos |
|---|---|---|
| US-001 | Decoder spike (**not under Ralph**): choose a WASM decoder, measure the bundle, state the conditions | docs |
| US-002 | Scanner route over `getUserMedia`, decoder loaded on that route only | crm |
| US-003 | Decode → by-barcode lookup → result panel | crm |
| US-004 | Check-out and check-in from a scan, through the existing verb routes | crm |
| US-005 | Wedge input on the same screen; camera-refusal degradation | crm |
| US-006 | Pure `scanner.js` rules module with unit tests | crm |

**Key acceptance criteria.** ADR 001's constraint has not gone away: **`BarcodeDetector` does not
exist on iOS and every iOS browser is WebKit underneath**, so the browser-native API fails on every
iPhone and iPad — silently, because the constructor is simply absent. A first-party camera scanner
therefore needs a **WebAssembly decoder bundled into the app**. That is a real dependency and a real
bundle cost, but it is a library, not a third-party service, so it satisfies the constraint the
client set. No Orca Scan, no commercial SDK, no Power Platform.

**What is already built survives unchanged and is not rebuilt:**
`GET /admin/samples/by-barcode/:barcode`, the check-out/check-in verb routes, and `SampleScanner.jsx`
which already drives them. **No endpoint is added for scanning.** Both the camera path and a wedge
scanner hit the same endpoint, so keeping wedge support costs nothing and gives the showroom counter
a faster option than holding up a phone.

US-006 exists because **there is no jsdom in the CRM, so component tests are impossible.** House
convention: the rules go in a plain `.js` beside the screen and that is unit-tested; the `.jsx` stays
dumb.

Still open: whether the showroom devices are iPads (F16), which decides how hard the decoder has to
work, and the label printer (F17), which is implied by auto-generated barcodes and specified nowhere.

---

## Epic W21 — Reporting codes (`aug12/w21-reporting-codes`) · api + crm · 7 stories

**Goal:** reports account for supplier brand codes and range codes.
**Requires:** W16 US-002 (the parameter read model is the roll-up source).

| # | Story | Repos |
|---|---|---|
| US-001 | Migration: `products.product_range` and `brands.brand_code` | api |
| US-002 | Backfill planner — unambiguous only; ambiguous and unmatched reported | api |
| US-003 | Supplier roll-up from the staged parameters, alias by alias | api |
| US-004 | Report filter whitelist gains brand code and range | api |
| US-005 | Coverage statement on every report using them | api |
| US-006 | Stock-source labelling while the two stock figures disagree | api |
| US-007 | CRM report filters | crm |

**Key acceptance criteria.** US-002 backfills from `price_list_items` **only where the match is
unambiguous** — ambiguous and unmatched rows are reported, never guessed, the
`src/suppliers/backfill-plan.js` posture that reports the `Jannelli Volpi` / `Janelli Volpi` pair
rather than collapsing it. Capped by the pre-existing 52% stock-item resolution rate, which nothing
this round improves, so US-005's coverage statement is not decoration.

US-003: the supplier → brand roll-up is now **stated by the client rather than inferred** — 28
invoicing entities over 55 houses, from her own data, superseding the 62-token empirical roll-up.
That is the input `backfill:suppliers` needs for the 26 of 41 unlinked houses. Only 8 of those 28
match a live supplier by name or slug, and most of the other 20 are visibly the legal-entity form of
a house we already hold (`Fabricut Inc` / Fabricut, `Pierre Frey Paris` / Pierre Frey,
`Liberty London` / Liberty). **They are corrections to make in the CRM, one alias at a time, not a
fuzzy rule to write.**

**Range is a reporting label, not a cost axis** — measured: supplier × category × range gives 74
groups where supplier × category gives 74, and the same 15 collide. That is what removes range from
W16 entirely and puts it here.

`CFJC` is **not interpreted** (F18): two brand codes run together, which reporting concatenates and
nothing stores, or one combined reporting line for two houses, which is a group column on `brands`
and not a code. **No column is added for it until the client answers** — guessing produces a
dimension that means different things to different rows.

US-006: `legacy_stock_items.stock_on_hand` is 5,332.8 against
`legacy_item_locations.total_stock_on_hand` at 14,157.9 — **2.65×**. Every stock number is
untrustworthy until that closes, and it needs the code-column re-export to be diagnosable at all.
Finance masking is unchanged and applies to every new dimension.

---

## File ownership across concurrent epics

Ownership is exclusive within a wave. Anything not listed is unowned and must not be touched.

### Wave 1 — W12, W13, W16, W17

| | W12 Order desk | W13 Purchasing | W16 Freight | W17 Price history |
|---|---|---|---|---|
| api migrations | `*order-references*` | `*purchase-orders*`, `*purchase-order-lines*`, `*purchase-order-receipts*` | `*freight-rates*` (**gated**) | `*price-history*`, `*price-history-triggers*`, `*price-list-drop-detection*` |
| api routes | `admin-orders.js`, `orders.js` | new `admin-purchasing.js` | new `admin-freight.js` | `admin-price-lists.js` |
| api modules | `src/orders/` | new `src/purchasing/` | `src/pricing/`, `src/legacy/` read model | `src/seed/price-lists.js`, new `src/pricing/history.js` |
| api email | `src/email/` (send sites only, no new template file) | none | none | none |
| crm screens | `AdminOrders.jsx`, `src/utils/packingSlip.js` | new `AdminPurchaseOrders.jsx` | `AdminSuppliers.jsx` | `AdminPriceListItems.jsx` |
| storefront | none | none | none | none |

Three notes that resolve collisions here rather than at merge time.

1. **`src/pricing/` is shared by W16 and W17.** W16 owns `waterfall.js` and `freight.js`; W17 owns
   `history.js`. Neither imports the other in this wave.
2. **`AdminPriceListItems.jsx` has exactly one owner, W17.** The approved plan expected W16 to add a
   column there too; Addendum 2 removed the need — freight is keyed on range, not on the price-list
   item, and the freight letters vanish from every screen rather than gaining one.
3. **W13 reads the order read model and never edits it.** Any change needed in `src/orders/` lands
   as a W12 story, guarded by W13's tests — the same resolution `admin-brands.js` got last round.

### Wave 2 — W14, W15, W19

| | W14 Supplier invoices | W15 Xero | W19 Reserves + cuttings |
|---|---|---|---|
| api migrations | `*supplier-invoices*` | `*xero-connections*`, `*xero-item-code*` | `*reserve-order-kind*`, `*cutting-requests*` |
| api routes | `admin-purchasing.js` (invoice section) | new `admin-xero.js` | `admin-orders.js` (kind only), new `admin-cuttings.js` |
| api modules | `src/purchasing/invoices.js` | new `src/xero/` | `src/orders/`, `src/samples/` |
| crm screens | new `AdminSupplierInvoices.jsx` | `AdminOrders.jsx` (push button only) | `Reserves.jsx`, `Cutting.jsx` |

`POST /admin/xero/invoices` takes an order id rather than living at
`POST /admin/orders/:id/xero-invoice` **precisely so W15 never opens W19's file**. W19's touch on
`admin-orders.js` is the kind vocabulary and nothing else; W15's touch on `AdminOrders.jsx` is one
button and its status line.

### Wave 3 — W18, W20, W22

| | W18 Self-service import | W20 Samples two | W22 Scanner |
|---|---|---|---|
| api migrations | `*import-runs*` | `*sample-cost*`, `*sample-barcode-sequence*`, `*email-templates*` | none |
| api routes | new `admin-imports.js` | `admin-samples.js` | none |
| api modules | `src/seed/price-lists.js`, `src/products/` | `src/samples/`, `src/email/` | none |
| crm screens | `PriceListImport.jsx`, `src/utils/importer.js`, `src/data/importStore.js`, `src/data/pricing.js` | `AdminSamples.jsx`, new reminder screens | `SampleScanner.jsx`, new `scanner.js` |

W20 owns `src/email/` in this wave (the template store); W18 owns every import file in the CRM
including the vendored waterfall constants. W22 adds no API surface at all.

Wave 4 runs W21 alone.

---

## Programme-level checks

Each fails loudly if the corresponding invariant broke. They are not per-epic and are not optional.

- **Reservation arithmetic has exactly one writer.** A test asserting no code path outside
  `src/orders/admin-orders.js` writes `qty_reserved`. W13, W19 and W20 can each break this
  independently.
- **`npm run convert:pricing && git diff --exit-code src/seed/data/price-lists.json`** still passes
  after W18.
- **Migration re-run is a no-op.** W13, W14, W15, W17, W19 and W20 each add tables.
- **No `legacy_*` table gains a column.** Extend the per-migration assertion to every new migration.
  W16 US-001 already added the twelfth `legacy_*` table, so table-count assertions move with it.
- **`legacy_cuttings.comments` is never read.** W19 is the epic most likely to break it.
- **Cost data never reaches a client-facing response.** The existing price-list exposure test,
  extended to purchase-order line costs, supplier invoices and freight rates.
- **Xero is never called in tests.** The client is injected at `buildApp`; a capture double proves it.
- **End to end, manually:** raise a sales order in the CRM → confirm it → derive a purchase order →
  receipt it short → check the backorder balance → attach the purchase order to a supplier invoice →
  push the sales invoice to a Xero demo org → print the packing slip and confirm no price appears on
  it.
