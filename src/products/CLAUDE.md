# atelier-api — category export (product sheet round trip)

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## Category export

The office fills in `products.category` through a spreadsheet round trip. Its pieces are shared with
the supplier pricing pipeline rather than reimplemented beside it.

- **`src/lib/csv-text.js` is the one encoding sniff and the one CSV reader** — strict UTF-8 (BOM
  tolerated), then a table-driven cp1252, then latin-1, which cannot fail. It moved out of
  `scripts/lib/text.js` because the API now has to read a file staff saved out of Excel, and roughly
  two-fifths of the supplier drops are cp1252 with nothing declaring it. `scripts/lib/text.js`
  stays as a re-export so `scripts/convert-price-lists.js`, `test/converters.test.js` and
  `test/colour-files.test.js` keep their specifier — that unchanged test suite is the proof the move
  changed no behaviour, which it could not be if the callers had moved too.
- **`src/` and `scripts/` import each other in both directions and that is deliberate**: one package,
  plain relative specifiers, no bundler, no `files` field. `src/seed/price-lists.js` already reaches
  into `scripts/lib/price-template.js` for the shared vocabularies; this is the same seam pointing
  the other way. A shared module lives with whoever owns it and the other side re-exports.
- **`decodeText` takes a Buffer, not a Uint8Array** — its last fallback is `bytes.toString('latin1')`.
  A route hands it the raw body Fastify gives it.
- **`csvRows` yields `[lineNumber, fields]` 1-based and counting the header row**, so a row number in
  a validation message is that number verbatim; adding an offset is how an error points at the wrong
  line.
- **`npm run convert:pricing` cannot run in a worktree** (`incoming/` is gitignored and exists only
  in the main checkout), so the byte-identity gate on `src/seed/data/price-lists.json` is a
  main-checkout step. Verify a change to this reader with a hand-made fixture instead —
  `node scripts/convert-price-lists.js <in-dir> <out.json>` over a file named to match
  `^(.+?)(?:\s+(FABRIC|WPPR|TRIMMING))?\s+PL\b` — and diff the emitted record against the
  corresponding line of the committed JSON. `test/price-template.test.js`'s byte-pin block names the
  exact cells behind its first record.

### The D365 workbooks (`npm run sheet:prices` / `npm run sheet:stock`)

The sheet below covers `products` — the seeded catalogue. The two catalogues the office actually works
from are in the D365 staging mirror, and `scripts/export-category-sheets.js` writes each as one workbook
(an All tab plus a tab per house, the same rows twice):

| dataset | table | rows | the CRM screen |
| --- | --- | --- | --- |
| `prices` | `legacy_product_prices` | 19,327 designs | Dynamics → Price list |
| `stock` | `legacy_stock_items` | 7,611 items | **Stock → Reserves** (`GET /admin/legacy/stock` — the tab is labelled Reserves, the data is the stock ledger) |

- **They stay two workbooks because they are two grains, and nothing joins them.**
  `legacy_stock_items.product_price_list` is the price row's DESCRIPTION, not its code, and resolves to
  exactly one price row for only 52% of items (`src/legacy/CLAUDE.md`). Do not add a lookup column.
- **Neither export contains duplicate rows.** Verified on the corpus: both are distinct on `guid`, on
  `row_checksum`, and on every business column combined. On the price list 381 CODES repeat, but 379 of
  those are the same number issued by two different houses (TREND `7221` is a different design at a
  different price from JANNELLI VOLPI `7221`) — a supplier's own numbering, not a global key. The 2
  within-house repeats (`GARRETT LEATHER GS1500`, `STROHEIM 81634`) are D365 data entry: a second record
  created later carrying a longer description, one of them with no price at all. `legacy_stock_items`
  has no code collisions — `item_code` is unique across all 7,611 — but the key stays the GUID on both
  sheets so they are read back the same way.
- **The key is the D365 GUID, not the code.** 18,946 distinct codes over 19,327 designs, and two
  `(range, code)` pairs repeat outright — a sheet matched on code could not identify those rows at all.
  Same argument as `Product ID` on the CSV sheet.
- **The stock sheet carries `On Hand` / `Available` / `Status` to be FILTERED on, not edited.** 3,455 of
  the 7,611 items are Inactive and only ~370 hold any stock; a sheet that had silently dropped either
  would read as "that is all the stock". Filtering is a click, and dropping is the part the office cannot
  undo. The quantities are written as NUMBERS (everything else is a string) so they sort and total —
  as text, "10" sorts below "2". A quantity D365 has not set stays an EMPTY cell, never a 0.
- **89 stock rows carry no house and land on a `(No house)` tab.** Dropping them would lose them
  silently; a tab named for the gap is the same statement the balance check makes.
- **`--one-sheet` keeps the All tab alone** (`npm run sheet:stock -- --one-sheet`). The house tabs are a
  view, so it removes a convenience and never a row — same rows, same count, same balance check. It is a
  flag rather than a second dataset because the two outputs differ in nothing else.
- **The house tabs are a VIEW, not a partition**: every design appears on `All Products` AND on its
  house's tab, so a re-import must be idempotent per GUID and must tolerate the same GUID twice in one
  file (the CSV sheet's `repeats` rule, arriving by a second door).
- **`Category` is empty and `Suggested Category` is beside it**, derived from the D365 item type through
  `CATEGORY_BY_ITEM_TYPE` — the same map the supplier price-list template reads, so the two pipelines
  cannot drift on what `W/P` means. 112 price rows and 958 stock rows have an item type the four-value
  vocabulary has no word for (Leather, Towels, Cushions, Bedding, Bed Linen, Candles, Furniture,
  Rug/Carpet, Throws/Blankets, Samples and Displays, "No Group Selected") and come through blank; they
  need a person.
- **The Category cells carry an Excel dropdown**, which is the note this file says a CSV has nowhere to
  put. It is the reason the workbook exists rather than a fifty-first CSV: an unknown category stops
  being a row error reported after the fact and becomes a value the office cannot type.
- **`scripts/lib/xlsx-write.js` is the writer, the mirror of the `xlsx.js`/`zip.js` READER** — no
  dependency, because Node bundles `deflateRawSync` and (20.12+) `crc32`. A string cell goes through the
  shared table and stays text, so a code like `81634` or `00815` stays the code; only an actual JS number
  becomes a numeric cell, which is how the caller decides. The ZIP timestamps are fixed at the 1980 DOS
  epoch, so the same rows produce the same bytes — the byte-identity gate the pricing pipeline already
  relies on (the price workbook was proved unchanged that way when the stock dataset was added).
- **Excel does not report a malformed part, it "repairs" it** — i.e. discards content and names nothing.
  So `test/xlsx-write.test.js` asserts the two things a reader cannot: the `CT_Worksheet` child SEQUENCE
  (`dimension` → `sheetViews` → `cols` → `sheetData` → `autoFilter` → `dataValidations`; out of order is
  a repair) and the relationship/content-type graph. The round trip through this repo's own reader is the
  other half.
- **Nothing reads a filled workbook back yet.** A category typed against a D365 price row belongs in
  `d365_overrides.extras` (the custom-field lane — `src/legacy/CLAUDE.md`), never in `patch`, which is
  keyed on D365 column names.

### The sheet (`GET /admin/product-sheet/export.csv`)

- **The header row is a CONTRACT, not a caption**: `Product ID,House,Collection,Design,Category`,
  declared once as `PRODUCT_SHEET_HEADER` in `src/products/product-sheet.js` and asserted verbatim
  by `test/product-sheet.test.js`. The re-import matches on it, so renaming a label breaks every
  sheet already sitting on somebody's desk.
- **`Category` is emitted EMPTY on every row, and that is what makes the round trip legible.**
  Exporting the stored value would leave the re-import unable to tell "the office confirmed this"
  from "the office did not touch this row" — so blank means *skipped* and a value equal to the
  stored one means *unchanged*, which is exactly the pair of counts the apply step reports. The
  four legal values are deliberately NOT printed in the file: a CSV has nowhere to put a note Excel
  will not hand back as a data row, so the CRM panel states them and an unknown one is reported
  with its row number.
- **`Product ID` is `products.id`, and it is there so a re-import never depends on row order.**
  Staff sort the sheet, delete the rows they have finished and paste blocks between files, none of
  which a positional match survives. The id rather than the slug because the slug is immutable by
  policy while the id is immutable by construction.
- **Archived products are out, hidden ones are in.** Archiving is how a design leaves the
  catalogue, so categorising one is work nothing reads; `show_on_website = false` is a design still
  being photographed, which is exactly the kind nobody has categorised yet. The house itself is
  fetched whatever its archived state, like every other by-slug admin read.
- **An unknown slug is a 404; a house with no products is a header-only file.** The empty sheet is
  a true statement ("this house holds nothing"), where a 404 there would read as a broken export.
- **`?brand=` defaults to `atelier-textiles-nz` through Ajv's `useDefaults`, which fires only when
  the key is ABSENT.** `?brand=` (empty string) is present, so it meets the `^[a-z0-9-]+$` pattern
  and 400s — the right answer for a download, and the opposite of the CRM's list convention, where
  `buildListQuery` drops an empty filter precisely so it never reaches the API.
- **A test for the default must not assume the seed.** CI runs migrations only, so
  `atelier-textiles-nz` may not exist; assert that the no-`?brand=` response EQUALS the explicit
  one (true at 200 and at 404 alike) plus the exported constant, never that the download succeeds.
- **The hardened CSV writer is `csvCell`/`csvRow`/`csvDocument` in `src/lib/csv-text.js`**, beside
  the reader — the file staff post back is read by the module that wrote it. Formula lead-ins
  (`= + - @ TAB CR`) take an apostrophe because every name in the sheet is staff-typed free text via
  `PATCH /admin/*` and `=HYPERLINK`/`=WEBSERVICE` exfiltrate in Excel; then RFC 4180 quoting; CRLF
  separators and a trailing newline. `src/pricing/trade-price-lists.js` still holds its own copy of
  those two rules — it belongs to the client-facing trade list and nothing about it changed —
  and should import from here whenever it is next touched.
- **`csvCell('=HYPERLINK("x")')` is `"'=HYPERLINK(""x"")"`**, not `'=HYPERLINK…`: a quote in the
  payload triggers RFC-4180 quoting on top of the neutralisation, so a `startsWith("'=")`
  assertion fails on the writer being more correct, not less.
- The `Content-Disposition` filename comes from the brand **slug** (`[a-z0-9-]` by construction,
  server-generated and immutable), never the house NAME, which is free text and can carry a quote
  or a CR. `.csv` is its own path segment — hung off a `:param` Fastify folds it into the parameter
  and every lookup 404s.

### Reading the sheet back (`POST /admin/product-sheet/validate`)

- **The validate route is a DRY RUN and writes nothing**, and it is a separate route from the apply
  rather than a `?dry_run=` flag: the office's flow is literally two steps (read the report, then
  decide), and a request that can write must never be one query parameter away from one that
  cannot. `parseProductSheet` (pure) and `validateProductSheet` (one read query) live in
  `src/products/product-sheet.js` beside the export — the file staff post back is read by the
  module that wrote it, so the header contract has exactly one definition.
- **Statuses split by what kind of thing is wrong.** A file that is not a product sheet at all —
  not a Buffer, empty, or a header this API never wrote — is a **400** thrown from the parser,
  because there is nothing to report per row. Row-level failures are a **422** carrying
  `{ message, errors: [{ row, message }], error_count, summary }`. A clean sheet is **200**
  `{ summary: { rows, skipped, repeats, unchanged, changed }, changes }`.
- **The 422 is RETURNED via `reply.code(422)`, never thrown.** Fastify's error serializer emits
  exactly `{ statusCode, error, message }` and drops custom properties, so a thrown error cannot
  carry `errors` — the same reason `src/lifecycle/` returns its refusals. `httpError` stays correct
  for the message-only 400s.
- **The row number is `csvRows`'s own line number**, so it counts the header and points at the line
  Excel shows. Row 2 is the first data row; no offset arithmetic anywhere.
- **When there are no errors the file balances: `rows === skipped + repeats + unchanged + changed`.**
  That invariant is the summary's only guarantee of being trustworthy, and is asserted — the same
  posture as the colour converter's "rows in = colourways out + skips + errors".
- **A blank Category is `skipped`, not an error**, which is the whole reason the export leaves the
  column empty: blank means "did not get to this row" and a value equal to the stored one means
  "confirmed it", and those must be two different counts. A blank row therefore never contradicts a
  filled one for the same id.
- **A repeated Product ID saying the same thing collapses (`repeats`); saying two different things
  is an error naming BOTH rows.** Staff paste blocks between files, so a genuine repeat is normal —
  but nothing here may choose between two contradicting statements, and the row error is what stops
  the file being applied at all.
- **An unmatched id is reported, never resolved through the House or Design cells beside it.** Those
  columns are for the human and staff edit them; the id is the key. The Design cell is quoted back
  in the message only so a person can find the row — which is also where the file's own encoding
  becomes observable end to end.
- **A row against an ARCHIVED product is refused, not absorbed.** The export omits archived products
  (archiving is how a design leaves the catalogue), so a category typed against one means the sheet
  and the catalogue disagree and somebody should look.
- **A category is trimmed and lower-cased before matching, and the accepted set is IMPORTED**
  (`CATEGORIES` from `scripts/lib/price-template.js`), never retyped: `products.category` and
  `price_list_items.category` are one vocabulary. "Fabric" can only mean `fabric`, so refusing it
  would be pedantry; anything else is an error naming the value and listing the four legal ones.
- **`products.id` is int4, so the parser range-checks the digit string.** A value past 2147483647
  would otherwise reach the `ANY($1::int[])` cast and surface as a 500 from Postgres rather than as
  the typo it is. General rule: range-check anything destined for an `int` cast before it reaches SQL.
- **Trailing EMPTY header cells are dropped before the contract is compared**, so a header line
  ending in a stray comma still matches — a blank cell declares no column. Blank LINES between rows
  are ignored and not counted. Both are what Excel and a hand edit actually leave behind.
- **The upload is deliberately not brand-scoped.** `Product ID` is unique across the catalogue, so a
  sheet identifies its own rows whichever house they came from; a scope would only add a way to
  refuse a legitimate file.
- **`errors` and `changes` are capped** (`MAX_REPORTED_ERRORS` 50, `MAX_REPORTED_CHANGES` 200) with
  the true counts beside them (`error_count`, `summary.changed`) — sixty broken rows are usually one
  mistake made sixty times, and a silent cap would read as "that was all of them".
- **`validateProductSheet` returns an `updates` array that is deliberately NOT served.** It is the
  seam the apply step consumes; the apply re-reads the posted file rather than trusting a list a
  client hands back.

### Taking a file at all

- **The route registers its own content-type parser inside its plugin scope** —
  `addContentTypeParser([...], { parseAs: 'buffer', bodyLimit }, …)` — exactly like the Stripe
  webhook and `admin-legacy-import.js`. Parsers are encapsulated, so no other route's body handling
  changes. There is no multipart parser in this API and adding one is a dependency, so the CRM posts
  the raw bytes.
- **Three content types, because a browser reports a `.csv` as any of them**: `text/csv`,
  `application/vnd.ms-excel` (Windows, while Excel owns the extension) and
  `application/octet-stream`. Do **not** register `text/plain` or `application/json` — the root
  instance already parses both and re-registering an inherited type throws at boot.
- **Therefore the handler must check `Buffer.isBuffer(request.body)`.** A caller posting JSON is
  parsed by the ROOT parser and arrives as an object, on which `decodeText` throws a TypeError — a
  500 for what is really a 400. The check lives in `parseProductSheet`, at the boundary.
- `bodyLimit` is set on BOTH the parser and the route (Fastify's default is 1 MB, and the largest
  house's sheet is a few thousand rows). Admin routes here do not opt into `config.rateLimit` — the
  backoffice guard is the gate, per the convention in the suppliers section.
- **Do not write a literal U+FEFF into source to strip a BOM.** It is invisible in the file and in
  every diff; `String.fromCharCode(0xfeff)` says the same thing visibly.

### Writing it back (`POST /admin/product-sheet/apply`)

- **The apply takes the FILE again, never the validate step's report.** A list of updates handed
  back by a client is a list the client could have edited, so the bytes are re-parsed and re-matched
  and the counts are recomputed at write time. The consequence to know is that the office may have
  changed the catalogue between the two requests, which is why the apply RETURNS its own counts
  rather than echoing the dry run's.
- **The whole sheet is one transaction**: `BEGIN` → match (locking) → one `UPDATE … FROM
  unnest($1::int[], $2::text[])` → `COMMIT`. Either every category the office typed lands or none
  does — a half-applied sheet is worse than a refused one, because the office cannot tell which half
  by looking at the file. A per-row UPDATE in a loop would be the same transaction and the same
  result at one round trip per design, which is the reason every batch write here unnests.
- **`validateProductSheet` and the apply are one decision, not two implementations.** The private
  `matchProductSheet(db, parsed, { lock })` is the shared half; `db` is a pool or an open client
  (the shape `setArchived` and `resolveOrderRecipient` already take), which is what lets the apply
  run the identical read inside its own transaction.
- **`lock` adds `FOR UPDATE` and it is what makes the report true at write time.** Without it a
  product can be archived or hard-deleted between the decision and the UPDATE, and the office is
  told a row was written that was not. The dry run passes it false on purpose — a report that took
  row locks would block the back office over a question. `ORDER BY id` sits beside it as the
  deadlock rule: two overlapping sheets applied at once take the same locks in the same order.
- **`rowCount !== updates.length` throws a 409 and rolls back.** The lock makes it unreachable from
  an ordinary request, exactly like `src/lifecycle/delete.js`'s 23503 catch, and it is correct
  anyway: the alternative is reporting to the office a count the database did not do.
- **`applied` is the UPDATE's own `rowCount`, and it is deliberately not just `summary.changed`.**
  The two agree by the check above; one of them is a prediction and the other is evidence, and the
  number a person reads as "done" should be the second.
- **Both routes refuse a broken sheet in the same words**, through one `refusalBody(report)` in the
  route file — the 422 shape is what the CRM renders, so one screen serves both buttons. "Nothing
  has been written" is a statement about a rollback on the apply and about a route that cannot write
  on the validate. `test/product-sheet.test.js` asserts the two bodies are `toEqual`; asserting each
  separately would let them drift with both tests green.
- **The parse happens before a connection is taken**, so a file that is not a product sheet at all
  is a 400 that never holds one open.
- Re-applying the same file is a no-op by construction rather than by a guard: a stated category
  equal to the stored one is `unchanged`, never an update, so the second run reports
  `applied: 0, changed: 0`.
- **A write suite resets only its FIXTURE ROWS in `beforeEach`, never its users** — this test file
  now holds three suites and re-registering would spend the 10-per-15-min bucket. Each owns its own
  `buildApp()` (a fresh limiter store), slug prefix and email domain, and the prefixes must not be
  prefixes of one another: `sheet-test-%` does not match `sheet-apply-test-house`, which is the only
  reason three prefix cleanups can coexist in one file.

