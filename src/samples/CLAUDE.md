# atelier-api — samples register

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## Samples

The physical sample register. `showrooms` + `samples` land in
`migrations/1786680000000_samples-register.js`; the loan and order lifecycles follow in their own
migrations.

- **The tables live OUTSIDE the `legacy_*` namespace, deliberately** — `importLegacyEntity` upserts
  every mapped column to EXCLUDED, so state written onto a staging row is destroyed by the next
  `npm run import:legacy`. Same reason `trade_accounts` sits outside it. `test/samples-schema.test.js`
  asserts the reverse too: every live `legacy_*` column is declared in `LEGACY_TABLES`
  (`src/seed/legacy-import.js`) plus `imported_at`, so a column added to a staging table by any
  workstream fails here. The one pre-existing exception is
  `legacy_sales_orders.owning_business_unit`, staged by the migration and never imported.
- **Nothing is copied out of `legacy_cuttings.comments`.** 1,757 of its 1,886 rows carry one and
  they hold staff names, handling instructions and, in current rows, third parties' names, emails,
  phones and home addresses. `samples.notes` is staff-typed and nothing else, and a test asserts
  neither samples table carries a `comments` column at all.
- **Samples are not stock.** A sample is a physical object on a shelf, never a sellable quantity:
  no column mirrors an inventory figure and no sample code path may read or write one, because the
  order state machine's reservation arithmetic breaks silently rather than loudly when a second
  writer appears. Enforced two ways — an `information_schema` check that no samples column matches
  `/qty_available|qty_reserved/`, and a source scan over every file this domain owns
  (`migrations/*samples*`, `src/samples/**`, `src/routes/admin-samples.js`) for those two tokens
  plus `/(?:INTO|FROM|JOIN|UPDATE)\s+inventory\b/i`. The scan bans the table in a **SQL position**
  only, so a comment may still explain why samples are not inventory, and it asserts its own file
  list is non-empty — a scan matching nothing passes every per-file check vacuously.
- **`barcode` is NOT NULL and unique.** `GET /admin/samples/by-barcode/:barcode` has to give one
  deterministic answer, 200 or 404, never a filtered list; a nullable barcode would let the unique
  index tolerate any number of unlabelled samples and turn that lookup into a guess. A duplicate is
  detected by the database (23505 on `samples_barcode_key` → 409), never by a pre-check that races.
  Still NOT NULL after W20-US-002 — the server supplies one when the caller does not, it never
  stores a blank.
- **The three FKs differ on purpose.** `colourway_id` is **RESTRICT and nullable** — restricted
  because a sample is physical evidence the design exists and deleting the catalogue row underneath
  it leaves a labelled object nobody can identify; nullable because plenty of samples predate the
  catalogue or come from a house Atelier does not stock, and `label` is what identifies those.
  `supplier_id` and `showroom_id` are **SET NULL**: who sent a sample is history, and closing a
  showroom must not destroy the samples that stood in it.
- **`status` and `archived_at` are different questions and both are needed.** `retired` is a
  statement about the physical object (worn out, sent back); archiving is the reversible removal of
  the ROW that every live CRM list offers, and the samples list's `include_archived` filter reads
  it. `status` is CHECK-constrained to `in_library|out|missing|retired`; the inline `check:` in
  `createTable` is emitted unnamed and Postgres auto-names it `samples_status_check`.
- **`sample_type` is free text, and that is a decision.** Nobody has ratified a vocabulary for what
  a sample IS (hanger, cutting, book, memo), and a guessed CHECK would refuse the office's own word
  for it the first time they typed it. Same posture as `duty_class` being stored raw.
- **Fixture cleanup order is `samples` → `brands` → `suppliers` → `showrooms`.**
  `samples.colourway_id` is RESTRICT, so it stops a brand cascade dead and the *cleanup itself*
  raises 23503 in the next test's `beforeEach` — the same trap `order_lines.colourway_id` sets.
- **The delete registry IS wired up** (this note once said otherwise — later stories and the
  post-merge review closed it): `src/lifecycle/registry.js` carries `sample`, `sample_order` and
  `showroom` entries, the `product` and `colourway` entries probe `samples` AND `sample_orders`
  (through the colourway join for product, direct for colourway — the order_lines shape), and
  `CONSTRAINT_BLOCKERS` in `src/lifecycle/delete.js` names all four RESTRICT edges
  (`samples_colourway_id_fkey`, `sample_orders_colourway_id_fkey`,
  `sample_orders_showroom_id_fkey`, `sample_loans_sample_id_fkey`) so even a lost-race 23503 says
  "samples", never "related records".

### `sample_loans` (`migrations/1786766400000_samples-loans.js`)

- **One open loan per sample is a PARTIAL UNIQUE INDEX, not application code.**
  `sample_loans_open_unique` covers `sample_id WHERE returned_at IS NULL`. The scanner is a
  concurrent device: two staff scanning one barcode out at once would otherwise open two loans and
  the register would name the wrong holder from then on, with nothing in the data to say which row
  was the lie. A pre-check cannot close that window — it reads a row another transaction is about
  to write — so "already out" is a **caught 23505 on this constraint**, mapped to 409 by
  `rethrowConflict` (exported from `src/catalogue/admin-brands.js`, whose unknown-constraint path
  degrades the message and never the status). Guarded by a two-client contention test in
  `test/samples-loans.test.js`.
- **The index must stay PARTIAL.** Check-in sets `returned_at`, which drops the row out of the
  index and lets the next check-out succeed; a plain unique on `sample_id` would allow one loan per
  sample for all time. The two halves are asserted separately (a second open loan is refused; three
  closed loans on one sample are fine).
- **`sample_id` is RESTRICT: history is a record, not an owned child.** CASCADE would let deleting
  a sample destroy every movement it was ever part of — precisely the question the register exists
  to answer — and do it silently. This is the FK under architecture.md's "a sample with loans is a
  409".
- **`holder_name` is a snapshot and is NOT NULL; `trade_account_id` is nullable and SET NULL.**
  The link is the CURRENT state of a business relationship and the loan is history:
  `trade_accounts.legacy_customer_name` is itself re-snapshotted when staff re-link an account, the
  login↔company grant is unlinked by back office as a matter of course, and plenty of borrowers are
  not trade clients at all (an architect, a stylist, Atelier's own staff). The name is never joined
  for. `trade_account_id` is not in architecture.md's column list — it is what makes the AC
  "history survives a trade account being unlinked or renamed" mean anything.
- **There is NO `archived_at` here, unlike every other live table**, and no `is_overdue`. A loan is
  append-only history and no CRM list may offer to remove one; `returned_at IS NULL` is the whole of
  "still out", and overdue is `returned_at IS NULL AND due_back_at < now()` derived at read time —
  a stored boolean is wrong from the first minute nobody runs the job that would maintain it.
  `sample_loans_overdue_idx` (`due_back_at WHERE returned_at IS NULL`) is what makes deriving it
  cheap, and a test asserts no column matches `/overdue|is_out|archived_at/`.
- **`due_back_at` is nullable**: plenty of samples go out with no date agreed, and defaulting one
  would make them overdue on a deadline nobody set. `out_at` defaults to `now()` but is its own
  column rather than `created_at`, so a movement recorded after the fact can carry the day it
  happened.
- **Fixture cleanup order gains a step: `sample_loans` → `samples` → `brands` → `suppliers` →
  `showrooms`**, plus `trade_accounts` by `legacy_customer_name` prefix. `sample_id` is RESTRICT, so
  deleting a sample 23503s inside cleanup while a loan points at it. A `trade_accounts` fixture
  needs a literal uuid for `legacy_account_guid` and a `legacy_customer_name`.

### `sample_orders` (`migrations/1786852800000_samples-orders.js`)

- **The showroom-stocking lifecycle, independent of the loan register.** A loan is a sample Atelier
  already owns leaving the library; a sample order is material that does not exist here yet being
  requested from a house. Nothing joins them — an order that reaches `received` may or may not ever
  become a barcoded `samples` row, and that is the office's decision, not the schema's.
- **`status` is CHECK-constrained to
  `requested|ordered|in_transit|received|displayed|cancelled`, default `requested`** (inline
  `check:`, so Postgres names it `sample_orders_status_check`). The vocabulary belongs in the
  schema because every list is a status tab and free text would make the CRM's tabs a guess.
- **The state MACHINE is deliberately NOT in the schema.** A CHECK sees one row at a time and
  cannot see which state a row is moving FROM, so it can hold the vocabulary and never the
  transitions; `ALLOWED_TRANSITIONS` + `requireStatus` live in the module the CRM mirrors. Nor is
  there a CHECK tying `status = 'cancelled'` to `cancelled_at IS NOT NULL` — a back-dated
  correction has to stay possible.
- **Each transition has its OWN timestamp column**, and that is the table's reason to exist:
  `requested_at` (NOT NULL, default `now()`) plus nullable `ordered_at`, `in_transit_at`,
  `received_at`, `displayed_at`, `cancelled_at`. `status` answers "where is it now"; the stamps
  answer "when did it move", which is what a showroom chasing a house actually asks ("ordered three
  weeks ago, still not shipped"). A single `status_changed_at` is overwritten by the next move and
  loses every earlier one. A NULL stamp reads as "has not been there" without consulting `status`,
  so no reader needs a CASE over the status to date a transition. `requested_at` is defaulted
  rather than derived from `created_at`, the same posture as `sample_loans.out_at`, so an order
  recorded after the fact carries the day it was raised.
- **`showroom_id` is NOT NULL + RESTRICT here while `samples.showroom_id` is SET NULL, and the
  asymmetry is the point.** A sample with no home is still a sample on a shelf; an order with no
  destination is a request nobody can fulfil, so it may not be created without a showroom and the
  showroom may not be deleted out from under it. `colourway_id` is RESTRICT and NULLABLE exactly as
  on `samples` (plenty of requests name material the catalogue does not hold — often *why* it is
  being ordered — and `label` identifies those); `supplier_id` is SET NULL, because who it was
  ordered from is history that must survive the supplier record being tidied away.
- **There is no quantity column, deliberately.** The row is one requested item, nothing derives a
  figure from it, and a count on a samples table is the first thing a later reader mistakes for
  stock. Three hangers is three rows or a note until somebody ratifies a line grain.
- **`archived_at` IS here**, unlike `sample_loans`: the delete policy refuses a hard delete of any
  order past `requested`/`cancelled`, so archiving is the only way a finished order leaves the CRM
  list. `sample_orders_archived_at_live_idx` is partial on the live rows, like every other
  archivable table here.
- **Fixture cleanup order gains a third shape.** `sample_orders` goes before `showrooms` (RESTRICT)
  AND before `brands` (its `colourway_id` is RESTRICT, so it stops a brand cascade dead just as
  `samples.colourway_id` does). A suite touching both lifecycles deletes `sample_orders` +
  `sample_loans` → `samples` → `brands` → `suppliers` → `showrooms`. Because `showroom_id` is NOT
  NULL, every fixture order hangs off a showroom and the whole table cleans with
  `WHERE showroom_id IN (SELECT id FROM showrooms WHERE name LIKE $1)` — no prefix column of its
  own is needed.
- **A prefix cleanup must match every name the suite WRITES.** `test/samples-loans.test.js` renamed
  a `trade_accounts` fixture to `${PREFIX} Name Ltd` while cleaning on `${PREFIX}-%`, so the row
  survived the run and its literal `legacy_account_guid` 23505'd on the next one — the suite passed
  exactly once per database. The pattern is anchored on `${PREFIX}%` now. Any fixture carrying a
  literal unique value (a uuid, a guid) has this failure mode.

### Read models (`src/samples/admin-samples.js`)

- **The register's back-office reads: `listSamples`, `getSample`, `getSampleByBarcode`,
  `listSampleLoans`.** Shape follows `src/suppliers/admin-suppliers.js` — the module exports
  `DEFAULT_PAGE`/`DEFAULT_LIMIT` (50)/`MAX_LIMIT` (200) and returns `{ samples, total }`; the route
  builds the `{ samples, meta: { total, page, limit } }` envelope and spends `MAX_LIMIT` as its
  schema `maximum`, so an over-large limit is a 400 rather than a silent clamp (the module still
  clamps, because it is also called directly).
- **Overdue is ONE expression constant used by the projection AND the filter**:
  `COALESCE(ol.due_back_at < now(), false)`, with the `returned_at IS NULL` half carried by the
  open-loan join predicate. Two spellings of it is how a list and its badge start disagreeing. The
  `COALESCE` is load-bearing rather than defensive: `due_back_at` is nullable and a comparison
  against NULL yields NULL, which pg hands back as JS `null` (so `overdue === false` never matches)
  and which makes `WHERE NOT <expr>` drop the row instead of keeping it.
- **The open loan is a plain `LEFT JOIN`, licensed by `sample_loans_open_unique`.** At most one open
  loan per sample means the join cannot multiply a row, which is what lets the COUNT query share
  `SAMPLE_FROM` — and it must share it, because the `overdue` filter names the joined alias. A
  lateral with `LIMIT 1` would also work and would hide the fact that the invariant is what makes it
  correct. `loan_count` is a correlated scalar subquery in the projection for the same reason: an
  aggregate join would need a GROUP BY over every selected column and would put the count into the
  count query, where it is dead weight.
- **Every row carries its parents by NAME** (`colourway_name`, `colourway_sku`, `product_name`,
  `brand_name`, `supplier_name`, `showroom_name`), not just their ids — nothing on a sample row says
  which design or showroom the object in your hand belongs to, which is the whole point of a
  register. Same reason `listAdminColourways` carries the design and the house. All five joins are
  LEFT: a sample with no catalogue link is normal, not broken.
- **`overdue` is a TRI-STATE filter**: absent leaves the list alone, `true` is the chase list,
  `false` is "not late back" — out on time OR on the shelf. It is not "on the shelf"; that is
  `status`.
- **`status` and `include_archived` are different questions and a screen needs both.** A `retired`
  sample is a LIVE row and appears in the default list; archiving is the reversible removal of the
  row. Collapsing the two is the obvious wrong simplification, so a test asserts it.
- **`q` searches the tag, the shelf and the design** (barcode, label, sample_type, location,
  colourway name/SKU, product name), with `%`/`_`/`\` escaped and `ESCAPE '\'` in the SQL so a
  barcode containing a wildcard matches one row. It deliberately does NOT search `holder_name`:
  "what has Kedgley got out" is a question about loans, and a loan list is its own read model.
- **`getSampleByBarcode` is an EXACT match on the unique column** — one row or null, never a prefix
  and never a pattern, which is what makes the scanner's answer 200-or-404 rather than a filtered
  list. Neither by-id nor by-barcode filters `archived_at`, like every other by-id admin read here;
  for the scanner that is load-bearing, since a scanned object exists whatever the CRM list is
  currently showing.
- **`SAMPLE_STATUSES` is exported so a route spends it as a schema enum instead of keeping its own
  copy**, and `test/samples-read-models.test.js` parses the live `samples_status_check` and asserts
  the two are the same set — the `DISCOUNT_METHOD_ENUM` posture with the drift test built in.
- **"Samples are not stock" is asserted twice.** The static source scan in
  `test/samples-schema.test.js` globs `src/samples/**`; the runtime counterpart here drives every
  read model against a four-line recording stub pool (`{ query }` only) and asserts no statement
  they issue names `qty_available`/`qty_reserved` or puts `inventory` in a SQL position.
- **A derived value is only proved derived by moving its input.** The overdue test reads once, moves
  the LOAN's `due_back_at` into the past, reads again, and asserts the value flipped while the
  SAMPLE's `updated_at` did not — a stored flag cannot satisfy that pair, whereas a single read
  passes against one.

### Routes (`src/routes/admin-samples.js`)

- **`GET|POST /admin/samples`, `GET /admin/samples/by-barcode/:barcode`,
  `GET|PATCH|DELETE /admin/samples/:id`, `POST /admin/samples/:id/archive|restore`** — all
  `requireRole('backoffice')` (director inherits). The register says where a physical object is and
  who has it: staff information, with no viewer below them. The guard test is parameterised over
  the whole surface, so a route added later without one fails. Registered in `src/app.js` as
  `adminSampleRoutes`; a further samples route belongs inside that existing plugin — **with one
  deliberate exception, `src/routes/admin-sample-loans.js`** (W20-US-004/US-007), which is out on
  its own because this file had reached the 800-line ceiling AND because it is the only samples
  surface that takes the `mailer`. Same guard, same domain, one more `api.register` line.
- **Every payload in a parameterised 401/403 sweep must be VALID.** Fastify validates before it
  runs a preHandler, so a guard test posting a malformed body asserts a 400 and passes even if the
  guard has been deleted.
- **`by-barcode` is an EXACT match answering 200 or 404, never a filtered list**, and it is a
  separate path segment from `/admin/samples/:id` so the two cannot collide (`:id` is an integer by
  schema, the barcode sits one segment further down). Three failure modes are tested rather than
  assumed: a barcode one character short must 404 rather than resolve to its neighbour, a `%` in
  the scanned value must not behave as a LIKE pattern, and an ARCHIVED sample must still be found —
  a scanned object exists whatever the CRM list is currently showing.
- **`out` is refused by the create and the PATCH alike, and this is what keeps the check-out story
  meaningful.** It is the one status that ASSERTS an open loan exists, and only check-out writes
  both tables in the transaction that makes that true; a status PATCH able to say `out` would let a
  screen mark a sample out with no loan behind it, which is exactly what architecture.md means by
  "check-out and check-in are verb routes, not a status PATCH". `WRITABLE_SAMPLE_STATUSES` is
  DERIVED from `SAMPLE_STATUSES` by filter, never re-typed, so widening the CHECK widens it too;
  the route spends it as a schema enum (400) and `admin-samples.js` re-checks it (422) because the
  module is also called directly. The verb routes must therefore write `status` themselves inside
  `withSampleTxn` — they cannot go through `updateSample`. `missing` and `retired` stay freely
  writable: those are statements staff make about the object, not about a loan.
- **A duplicate barcode is the database's 23505 on `samples_barcode_key`, never a pre-check.** The
  scanner is a concurrent device, so a read-then-insert pre-check is exactly the race that would
  let two tags through; a test fires two creates at one barcode with `Promise.all` and asserts the
  pair of codes is `[201, 409]`.
- **`barcode` IS editable by PATCH.** It is a printed tag that can be mistyped and nothing
  references it — `sample_loans.sample_id` points at the row's id — so a correction is safe, and a
  collision is the same 409 the create answers with. Same reasoning as `colourways.sku`.
- **`barcode` is OPTIONAL on create, and omitting it IS the generate action** (W20-US-002,
  `migrations/1787371200000_sample-barcode-sequence.js`). `ATL-S-` + at least six digits
  (zero-padded up to six) off `samples_barcode_seq`, which **starts at 1000**: the hand-typed corpus is `ATL-0049-217` (three
  digits, highest 217), `samples` was empty and `legacy_cuttings` has no barcode column, so a minted
  tag cannot collide with a typed one *by construction* — the middle segment is the literal `S`,
  never digits. A **SEQUENCE, never `max(barcode) + 1`**, which serialises every insert and races
  anyway. It is a `COALESCE` arm inside the existing INSERT, not a preceding SELECT: Postgres skips
  a COALESCE argument it does not need, so **a supplied barcode wins AND spends no number**, and the
  mint cannot outlive a failed insert. There is deliberately **no mint endpoint and no retry loop** —
  a number handed out before the row exists is a number the office has to remember again, which is
  the whole complaint, and a generated barcode that collides (sequence moved behind the corpus) is
  the same 23505 → 409 a typed one gets. `''` and `null` are 400s at the route, so only an ABSENT
  key generates. A suite creating generated samples must clean up **by `label`** — the barcode is
  the server's, and `ATL-S-%` is nobody's namespace to delete from. **Six digits is a FLOOR, not a
  fixed width** (C16): lpad truncates past its target, so a fixed-width pad would fold every value
  from 1,000,000 back into the spent six-digit space and 409 for ever; the mint pads with
  `GREATEST(length(n::text), 6)` instead, so values ≤ 999999 read as before and a seventh digit
  comes through whole. Past a million tags lexical order stops matching chronological order
  (`ATL-S-1000000` sorts before `ATL-S-9xxxxx`) — cosmetic only, uniqueness is the guarantee.
- **A 23503 on any of the three FKs is a 422, not a 404.** The id arrived in a BODY as a business
  fact about the sample, exactly like an unknown `brand_id` on a product create, so it is the body
  that is wrong and not the URL. Keyed on the constraint name
  (`samples_{colourway,supplier,showroom}_id_fkey`); an unknown one degrades the message, never the
  status.
- **Every write returns through `getSample`.** A create, a patch, an archive and a plain read hand
  the CRM one shape — parents by name, the open loan, the loan count, the derived `overdue` and the
  loan history — so the screens need one renderer rather than two. It costs a round trip and the
  screens re-read after every write anyway.
- **`sample` is in the lifecycle registry: table `samples`, `archivable: true`, one probe on
  `sample_loans`.** `sample_loans.sample_id` is RESTRICT so the database would refuse anyway; the
  probe still wins, because it reports HOW MANY movements are in the way and runs before anything
  is destroyed. A CLOSED loan blocks exactly as hard as an open one — history is the register's
  reason to exist — and that is tested separately, because "block only while something is out" is
  the obvious wrong simplification. `'sample'` is a code literal at the call site, never `:entity`
  from the URL.
- **Still owed, and deliberately not done here:** `src/lifecycle/delete.js`'s `CONSTRAINT_BLOCKERS`
  has no `sample_loans_sample_id_fkey` entry (only a lost race falls through to the generic
  "related records"), and neither the `product` nor the `colourway` entry probes `samples`, so
  deleting a design does not yet see the samples cut from it. There is also **no showroom CRUD
  anywhere**: `showrooms` has a table and an `archived_at` but no routes and no registry entry,
  which the CRM's showrooms screen will need.

### Check-out and check-in (`src/samples/sample-loans.js`)

- **`POST /admin/samples/:id/check-out` and `POST /admin/samples/:id/check-in` are VERBS, not a
  status PATCH**, and the reason is that each writes TWO tables and only means anything if both
  writes land together: check-out opens a `sample_loans` row AND moves `samples.status` to `out`,
  check-in closes the loan AND moves it back to `in_library`. They live in the `adminSampleRoutes`
  plugin `src/app.js` already registers, so a further samples route needs no second registration.
- **They write `status` with their own SQL and must keep doing so.** `updateSample` refuses `out`
  (`WRITABLE_SAMPLE_STATUSES`), which is the whole point — this transaction is the only place the
  assertion "it is out" can be made true — so routing the status write through it would 422 the
  movement.
- **`withSampleTxn(pool, id, fn)` mirrors `withOrderTxn`** (`src/orders/admin-orders.js:207`):
  BEGIN, `SELECT id, status FROM samples WHERE id = $1 FOR UPDATE` (404 when the id is unknown),
  run `fn(client, sample)`, COMMIT, then re-read through `getSample` on the POOL — so a movement
  hands the CRM exactly the shape a plain read does. **`FOR UPDATE`, never `FOR NO KEY UPDATE`:**
  the INSERT inside the same transaction takes `FOR KEY SHARE` on the sample it references, and
  `FOR KEY SHARE` conflicts with `FOR UPDATE` and with nothing weaker, so the weaker mode would let
  two movements on one sample run side by side. Same rule `src/lifecycle/delete.js` states for
  check-then-delete.
- **Neither 409 is a pre-check, and they get there by different routes.** "Already out" is the
  caught 23505 on `sample_loans_open_unique` — a read-then-insert reads a row another transaction
  is about to write, and the scanner is a concurrent device. "Not out" is the closing
  `UPDATE sample_loans … WHERE sample_id = $1 AND returned_at IS NULL` reporting
  `rowCount === 0`: the write answers the question it was asked, which is only safe because the
  transaction already holds the sample locked.
- **A status-code test cannot prove "never a pre-check"** — a pre-check returns the same 409 on
  every uncontended request. `test/samples-checkout.test.js` asserts it over the STATEMENTS
  instead, against a four-line recording stub pool: no statement before the deciding write names
  `sample_loans` at all. The same stub pins the transaction shape and is the only way to reach a
  failure AFTER the first write (make it throw on the second, assert `ROLLBACK` and no `COMMIT`) —
  the window a two-statement handler outside a transaction leaves open.
- **No guard refuses a `missing`, `retired` or ARCHIVED sample a check-out**, deliberately. Those
  are statements staff made about the object, and a missing sample somebody has just scanned out
  has by definition been found; refusing would make the register argue with the person holding the
  thing. Check-in returns the sample to `in_library` unconditionally — a damaged return is a
  follow-up PATCH to `retired`, which is freely writable.
- **`holder_name` is required; `due_back_at` is not.** Plenty of samples go out with no date
  agreed and inventing one would make them overdue on a deadline nobody set. `out_at` and
  `returned_at` are optional and default to `now()`, so a movement recorded after the fact carries
  the day it happened, and nothing refuses a return earlier than the loan's `out_at` — a back-dated
  correction has to stay possible.
- **Check-in does not rewrite the loan's `notes`.** A loan is append-only history and the note is
  what was typed when the sample went out. There is no loan PATCH route, so a mistyped loan note
  cannot currently be corrected through the API.
- **A timestamp body field needs an explicit pattern, and the pattern is not enough.** Fastify's
  bundled Ajv carries no `format` keywords (the same reason `date_effective` uses an explicit
  `YYYY-MM-DD` pattern), so `timestampProp` in `src/routes/admin-samples.js` is a regex — which can
  only police the SHAPE. `2026-02-31` passes it and arrives as a pg 22007/22008, mapped to a **422**
  by the module, because a rejected value must never surface as a 500.
- **An optional POST body must be typed `['object', 'null']`.** Fastify hands a bodyless POST to
  the validator as null, so a plain `type: 'object'` schema would 400 the most ordinary check-in
  there is; the handler passes `request.body ?? {}`. Routes with no body schema at all
  (archive/restore) never hit this.

### The sample-order lifecycle (`src/samples/sample-order-states.js` + `sample-orders.js`)

- **The machine lives in a module that imports NOTHING, and that is load-bearing twice over.**
  `sample-order-states.js` holds `SAMPLE_ORDER_STATUSES`, `ALLOWED_TRANSITIONS`, `SOURCE_STATUSES`
  (the derived inverse), `STATUS_STAMPS`, `DELETABLE_SAMPLE_ORDER_STATUSES`, `requireStatus`,
  `requireTransition` and `isDeletableStatus`. The CRM mirrors it (`sampleFlow.js`), so anything
  reaching for pg would make it uncopyable across the repo boundary — and `src/lifecycle/registry.js`
  imports the deletable set for its guard, which is only possible while the module is a LEAF:
  registry → sample-orders → `lifecycle/archive.js` → registry is a cycle, and the registry
  validates its entries at import time, so it would run against a half-initialised module.
  `assertMachine()` runs at module load (the `assertEntity` posture) and a test exercises the whole
  machine with no database at all — that block IS the proof it is portable.
- **The vocabulary is the schema's and the transitions are the module's**, exactly as
  `1786852800000_samples-orders.js` said: a CHECK sees one row at a time and cannot see which state
  a row is moving FROM. `test/samples-order-lifecycle.test.js` parses the live
  `sample_orders_status_check` and asserts the two agree on the vocabulary, and that every
  `STATUS_STAMPS` column exists — the `DISCOUNT_METHOD_ENUM` posture with the drift test built in.
- **`displayed` and `cancelled` are terminal.** An abandoned request is re-raised as a new one,
  never reopened: reopening would leave `cancelled_at` stamped on a live row, and the whole point of
  six stamps is that a NULL reads as "has not been there" without consulting `status`.
- **`POST /admin/sample-orders/:id/transition` (body `{ status, at? }`) is the ONLY way a status
  moves.** `status` is absent from `SAMPLE_ORDER_UPDATE_COLUMNS` and from the PATCH schema, and a
  create always lands in `requested` whatever the body says (Ajv strips the key rather than 400ing
  it, so the whitelist is the real defence). Same rule as `out` on a sample: a move writes the state
  AND the stamp that dates it, and either alone is a row that contradicts itself. Recording an order
  raised weeks ago is a create with a back-dated `requested_at` plus moves each carrying their own
  `at`; nothing refuses a stamp earlier than the previous one, because a back-dated correction has
  to stay possible.
- **`withSampleOrderTxn` mirrors `withSampleTxn`**: BEGIN, `SELECT id, status … FOR UPDATE` (404 on
  an unknown id), run, COMMIT, re-read through `getSampleOrder`. The lock is what makes
  `requireTransition` mean anything — it reads the state this transaction is about to overwrite — so
  two staff advancing one order are serialised and the loser is refused rather than silently
  rewriting the winner's stamp.
- **A concurrency test must race the SAME move.** `ordered` against `cancelled` yields two 200s
  through a *correct* lock (the loser wakes in `ordered`, and `ordered → cancelled` is legal), so it
  fails against working code and passes against a broken lock only by accident. Racing `ordered`
  against `ordered` is what discriminates: the loser's re-read sees the state it was asked to move
  to and the self-move is refused.
- **An illegal-transition test asserts the row is UNCHANGED, not just the 409.** A status code alone
  passes against a handler that writes first and refuses afterwards; read before, read after,
  `toEqual`.
- **`sample_order` is in the lifecycle registry with a GUARD and no probes** — nothing in the schema
  references `sample_orders`, so there is nothing to probe, and "is this row still a record of
  something" is a question about the row's own state that no foreign key can express. The refusal
  carries `blockers: []` and `archivable: true`, so the CRM's existing dialog needs no second shape.
  Deletable only while `requested` or `cancelled`: an order actually placed with a house is the
  record that the house was asked for something.
- **`showroom_id` is the one editable ref here that is NOT nullable** (a request is redirected, never
  un-homed): the route types it `integer`, so an explicit null is a 400, and the module maps the
  23502 to a 422 for a direct caller. `colourway_id` and `supplier_id` clear with an explicit null
  as usual. There is no 23505 branch at all — nothing on this table is unique, and two showrooms
  asking one house for one design on one day are two real requests.
- **The list's count query shares `ORDER_FROM`, which is safe because every join is on a primary
  key**; the showroom join is INNER (`showroom_id` is NOT NULL) and the rest are LEFT. `q` searches
  the label, the showroom and the design, and deliberately not `notes` — the office's running
  commentary would make a list of requests answer with orders whose request matched nothing typed.
- ~~Still owed and named by no story: there is no showroom CRUD anywhere.~~ Built by W4-US-008 —
  see *The showroom address book* below.

### The showroom address book (`src/samples/showrooms.js`)

- **`GET|POST /admin/showrooms`, `GET|PATCH|DELETE /admin/showrooms/:id`,
  `POST /admin/showrooms/:id/archive|restore`** — backoffice-only, in the `adminSampleRoutes`
  plugin, so `src/app.js` needed no edit. No story in the samples PRD names this surface: US-008
  draws `AdminShowrooms` in the CRM and every showroom list on both samples screens (the register's
  filter, the sample form's picker) had nothing to call, because `showrooms` had a table from
  US-001 and nothing else. Every file it needed was already this workstream's.
- **A showroom is a plain address-book row** — name, address, city, three contact fields, notes —
  and says nothing about what stands in it. That is `samples.showroom_id` and
  `sample_orders.showroom_id`, both pointing this way.
- **`name` is NOT NULL, unique and PATCHABLE.** Unlike a slug it is not a URL and nothing addresses
  a showroom by it (both child tables point at the id), so a typo taken down over the phone is a
  correction rather than a new showroom — the same reasoning as `colourways.sku` and
  `samples.barcode`. A duplicate is the database's 23505 on `showrooms_name_key` mapped to a 409,
  never a pre-check. The PATCH schema types `name` as `string` rather than `['string','null']`, so
  clearing it is a 400 at the route; the module maps the 23502 to a 422 for a direct caller.
- **The child counts are on the BY-ID read and deliberately not on the list.** They are the only
  advance warning a screen has that Delete will be refused — the CRM kit forbids a pre-flight "can
  I delete this" GET, which races the delete — and they count ARCHIVED rows, exactly as the probes
  do. A count filtering `archived_at` would report an empty showroom and then be contradicted by
  the 409. Same posture as `GET /admin/brands/:id`; a test asserts the agreement in both
  directions.
- **`showroom` is in the lifecycle registry with TWO probes and no guard**, and the SET NULL one is
  why probes exist at all. `sample_orders.showroom_id` is NOT NULL + RESTRICT, so the database
  would refuse that half loudly; `samples.showroom_id` is SET NULL, so without its probe a delete
  would answer 200 while silently un-homing every sample that stood there. `test/samples-showrooms.test.js`
  asserts the samples are untouched after a refusal — the failure the status code cannot see.
  `archivable: true`, so a blocked delete offers archiving, which for a showroom that has ever been
  sent an order is the only way out.
- The list query is **alias-free**, because `SHOWROOM_COLUMNS` is unqualified — adding an alias
  later would break the projection, the same rule `BRAND_COLUMNS` carries. `q` searches the name,
  the city and the contact and deliberately not the notes.

### What a sample cost (`samples.unit_cost`, W20-US-001 + US-008)

`migrations/1788148800000_sample-cost.js` adds `unit_cost numeric(12,4)` + `cost_currency text`,
both nullable, with `CHECK (unit_cost IS NULL OR unit_cost >= 0)`.

- **`>= 0`, deliberately NOT `> 0`** the way `price_list_items.wholesale_rate` is. A zero line rate
  on a supplier price list is a malformed list; a free hanger is normal ("sometimes we get hangers
  for free") and is a fact worth recording. Refusing 0 would push the office into typing NULL for
  it, which means something else entirely.
- **NULL and 0 are DIFFERENT FACTS and nothing may conflate them.** NULL is "nobody recorded a
  cost", 0 is "free of charge, and we know it". `Number(null)` is 0, so a bare `Number()` on this
  column turns every uncosted hanger into a gift the moment anything sums it. One coercion
  (`value == null ? null : Number(value)`) lives in `costOf` and every read goes through it;
  `test/samples-value.test.js` asserts the two read back distinguishable end to end, which a status
  code cannot see.
- **`cost_currency` has no CHECK**, unlike `price_list_items.currency` (`EUR|USD|GBP`). That is the
  price-list pipeline's own closed vocabulary; a sample can be bought from anyone in anything, NZD
  included. Same posture as `sample_type` and `duty_class` being stored raw.
- **Cost is a FINANCE figure, gated by `loadReportAccess(db, user)` and never by
  `request.user.can_view_finance`.** `PUBLIC_USER_COLUMNS` does not carry that flag, so a direct
  read is `undefined` and answers false to everyone, silently and for ever — the exact bug
  `src/reports/access.js` documents. `backoffice` covers the showroom and the accounts desk alike,
  which is why the column exists beside the role.
- **The gate is FAIL-CLOSED AT THE SQL, not a projection on the way out.** `finance` is threaded
  into `listSamples`/`getSample`/`getSampleByBarcode`/`createSample`/`updateSample`/
  `setSampleArchived`/`checkOutSample`/`checkInSample` (default `false` everywhere, so a direct
  module caller that says nothing gets no costs), and the columns are simply not SELECTed. A column
  that was never selected cannot leak through a projection somebody forgot to apply, and the claim
  is provable over the STATEMENTS rather than over one response body — which is how the test asserts
  it. `costOf` keys off `Object.hasOwn(row, 'unit_cost')`, so payload presence follows the SELECT
  and there is one decision, not two to drift apart.
- **Reading and writing are ONE permission.** `assertCostWritable` 403s a write from a login without
  finance — Ajv's `removeAdditional` does not strip a *declared* key, so without it the value would
  land. It lives in the module, so it holds for the CRM, the AdminJS panel and any later caller.
- `SAMPLE_FINANCE_KEYS` is the one declaration of what counts as a cost here; a later cost column
  joins it. `test/price-list-exposure.test.js` carries the samples surface now — cost never reaches
  a client-facing response (FR-264), and the register also says who has what, which is staff
  information either way.

### The outstanding register (`src/samples/sample-loan-queue.js`, W20-US-004)

- **`GET /admin/sample-loans` reads ACROSS the whole register**, which is the gap FR-250 names:
  `listSampleLoans` answered "what happened to THIS hanger" and nothing answered "what is out". It
  is the outstanding report and the reminder work queue at once, because those two screens ask one
  question. Filters: `trade_account_id`, tri-state `overdue`, `due_before`, `q`, paginated on the
  same `DEFAULT_PAGE`/`DEFAULT_LIMIT`/`MAX_LIMIT` constants the register spends.
- **`returned_at IS NULL` is not a filter and is not overridable.** A returned sample is not
  outstanding; a flag to include one would be answering a different question. ARCHIVED samples DO
  appear — archiving is a decision about a CRM list, and an object somebody still has is still out.
- **`overdueExpression(alias)` is imported from `admin-samples.js`, never re-spelled.** That is why
  it is a function of its alias: a queue and a sample card computing "late" separately would
  eventually disagree and the badge would be the one nobody believed. `days_overdue` is derived the
  same way and is **NULL rather than 0** for a loan that is not late — 0 reads as "due today".
- **`due_before` deliberately does not match a loan with no agreed date** (the comparison yields
  NULL): "no date agreed" is not "due by Friday", the same reason `due_back_at` is nullable at all.
- **`suggested_email` is a SUGGESTION, from the trade account's linked login.** `sample_loans` has
  no email column and must not grow one by reflex: plenty of borrowers are not trade clients (an
  architect, a stylist, Atelier's own staff). Null means "we have no address", which the screen has
  to be able to say out loud, and the staffer confirms or replaces it at send.
- `reminder_count`/`last_reminded_at` are correlated scalar subqueries, the `loan_count` posture:
  an aggregate join would need a GROUP BY over every selected column and would drag the counts into
  the COUNT query, where they are dead weight.

### Reminders (`src/samples/sample-reminders.js`, `src/routes/admin-sample-loans.js`, W20-US-007)

- **NO SCHEDULER IS INTRODUCED, and that is the design.** "Editable before send" and "sent
  automatically at 2am" cannot both be true of one message, and the client asked for the first, so
  a reminder is a **staff action off a work queue**: the queue is a read, the send is a click, the
  letter is editable in between. The platform keeps its property of having no cron, no worker and no
  queue — nothing to monitor, no dead-letter state, nothing failing silently at 2am. If a runner
  ever arrives it brings its own ADR, and the first thing it must not do is take over sending a
  message a human was promised the chance to edit. `test/samples-reminders.test.js` asserts
  `sample_loan_reminders` carries no `scheduled_for`/`attempts`/`due_at` column.
- **The draft and the send are TWO routes on purpose.** `POST /admin/sample-loans/reminders/preview`
  renders one draft per loan and sends NOTHING (asserted over the capture transport, not a status
  code); `POST /admin/sample-loans/reminders` takes finished `subject`/`body`/`to` and sends them
  **verbatim** via `mailer.send({ subject, text })`. A single "send from a template" call would
  render the letter after the staffer stopped looking at it — two renders of a template an editor
  may have changed in between.
- **A loan the preview will not draft comes back in `missing`**, never silently dropped: a draft
  list quietly shorter than the selection reads as a rendering bug.
- **A send is RECORDED ONLY ONCE THE MAILER SAYS IT WENT.** `mailer.send` never throws — it reports
  — so the failure path is this module's decision: a failed send is a 502 with nothing written, and
  a null mailer is a 503. Recording either would tell the office a client had been chased, and
  "already chased" is precisely what stops somebody chasing. (Every other mail trigger in this API
  is a no-op without a mailer because it is a side effect of a request that must succeed anyway;
  this request IS the send.)
- **`sample_loan_reminders` stores the LETTER, not a template reference** (`migrations/1788321600000`).
  "Which shape was used" is not the question the office asks when a client rings back, and the whole
  point of the story is that a staffer may rewrite it. It also means editing the stored template
  later cannot rewrite history. `loan_id` is RESTRICT (history about a movement is not an owned
  child), `sent_by` is SET NULL, `sent_to` is a snapshot exactly like `holder_name`.
- **A TABLE, not `sample_loans.last_reminded_at`.** A column answers only "when was the most recent
  chase"; the count and the previous date are what tell a staffer whether to send a politer letter
  or pick up the phone. A second reminder must read as the second one.
- **Sending to a loan that is already back is a 409**, an unknown loan a 404 — told apart by one
  read, so the answer names the actual problem rather than "not found" for both.
- Fixture cleanup gains a step at the front: `sample_loan_reminders` → `sample_loans` → `samples`
  → `brands` → `suppliers` → `showrooms`. `loan_id` is RESTRICT, so a surviving reminder 23503s the
  loan delete inside the next `beforeEach`.

## Sample requests (`sample_requests` + `sample_request_lines`, 16 Sep 2026)

The storefront's "Request a sample" enquiry cart, landed. A shopper collects
colourways and sends them as ONE request (`POST /samples/request`, public,
honeypotted, the `/orders/request` rate limit); it lands `pending` with two
letters sent (`sample_request_received` to the shopper,
`backoffice_new_sample_request` to the office's one address) and the office
moves it to `sent` or `declined` from the CRM (`/admin/sample-requests`).

- **A different record from `sample_orders`** (Atelier asking a HOUSE for
  showroom material — a showroom, no person) and from `samples` (the physical
  register). It names a person and what they asked for, nothing more.
- **Lines SNAPSHOT sku / design / colour / house** and `colourway_id` is SET
  NULL: a request is a record of what someone asked for on the day, and tidying
  the catalogue afterwards must neither block that tidy-up nor blank the request.
  No registry probe is needed — the lines cascade with the header.
- **Every SKU is resolved before anything is written** (422 naming
  `lines[n].sku`), so a line nobody can act on is never stored.
- `src/samples/sample-request-states.js` is the zero-import leaf (three states,
  two moves, both terminal; `pending` and `declined` deletable) that the
  registry guard and the CRM's mirror both read.
- Nothing here touches stock; the schema test's source scan covers the module.
