# D365 legacy export — column audit & data findings

*Verum · 29 Jul 2026 · analysis of the four Dynamics 365 exports in `incoming/data-exports/` (gitignored)*

Companion to `atelier-platform-demo/Atelier-Reports-Data-Requirements.md` (items A1–A15) and
`Atelier-Verum-Build-Spec.md` §3 (pricing waterfall) / §5 (data model).

Context: Derek Simpson (Fulmar) walked through the D365 export mechanics on 28 Jul — Product Prices
are the price-list spine, Stock Items are only created when a sales order is processed (a price-list
item spawns one stock item per colourway, with a suffix appended to the code), Accounts toggles
between customer and supplier views, and an export is capped at 100,000 rows. The legacy environment
is on a one-month licence extension, so this is likely the only clean pull we get.

**Status: the exports are now staged in Postgres.** `npm run convert:legacy && npm run import:legacy`
loads all four into `legacy_*` tables (§7). Nothing has been mapped into the live catalogue or
commerce tables yet — that step is gated on A1/A2/A3.

---

## 1. What landed

| File | Entity (logical name) | Rows | Cols |
|---|---|---|---|
| `Active Product Prices 29-07-2026 9-40-36 AM.xlsx` | `atelier_productprices` | **19,327** | 51 |
| `Stock View 29-07-2026 9-48-16 AM.xlsx` | `fulmxero_item` | **7,611** | 54 |
| `Customers 29-07-2026 9-50-28 AM.xlsx` | `account` | **866** | 190 |
| `Current Sales Orders 29-07-2026 9-47-16 AM.xlsx` | `fulmxero_salesorder` | **48** | 34 |
| `Export.xlsx` | — | — | — |

`Export.xlsx` is a duplicate of the Product Prices pull (identical 51 columns, identical leading
rows). **Delete it before any importer runs** or every price row imports twice.

Every export is comfortably under the 100k limit, so no year-slicing was needed. Publisher prefixes
in the schema names: `atelier_` (Atelier customisations), `fulmxero_` (the Fulmar–Xero solution),
`fulmar_` (later Fulmar additions).

### Export mechanics

These are **dynamic** worksheets. Each carries three lead columns —
`(Do Not Modify) <Entity>` (the record GUID), `(Do Not Modify) Row Checksum`, and
`(Do Not Modify) Modified On` — plus a hidden sheet holding the URL-encoded
`logical_name=Display Name` map and the option-set vocabularies.

That is **better than a static export** for our purposes and should be kept:

- the GUID is a stable natural key for staging tables and for re-pull matching;
- the row checksum detects changed rows on an incremental re-pull (the business runs live, so the
  import has to run more than once before cutover);
- the hidden sheet documents the D365 schema for free, including option sets that never appear in
  the data (e.g. sales-order statuses no current order has reached).

Parsing notes for the converter: dates arrive as **Excel serials** (epoch 1899-12-30), text fields
often arrive newline-wrapped (`"\nELLA STRIPE\n"`), and the header row lives on `sheet2.xml`
(`sheet.xml` holds the schema map).

---

## 2. Product Prices — the §3.5 gold dataset

51 columns, all requested ones present. The 14-column supplier price-list template already handled by
[`scripts/convert-price-lists.py`](../scripts/convert-price-lists.py) maps one-to-one onto this entity,
plus the waterfall outputs and the FX/override fields.

Corpus size cross-check: this export has **19,327** rows; the committed
`src/seed/data/price-lists.json` (built from the per-brand template drops) has **19,514** items across
40 suppliers / 41 ranges. Near-identical corpora from two independent paths — worth a row-level diff
as a validation exercise.

### Column inventory

**Inputs (map to `price_list_items`)**
`atelier_dateeffective` Date Effective · `atelier_code` Code · `atelier_description` Description ·
`fulmxero_trackingoption2id` Type · `atelier_packtype` Pack Type · `atelier_contents` Contents ·
`atelier_width` Width · `atelier_repeat` Repeat · `atelier_verticalrepeat` Vertical Repeat ·
`atelier_dutyrate` Duty Rate · `atelier_wholesalerate` Wholesale Rate (+ `_base`) ·
`transactioncurrencyid` Currency · `atelier_freightrate` Freight Rate ·
`fulmxero_trackingoption1id` Range

**Waterfall outputs (no home in the current schema)**
`atelier_exportprice` Export Price (+ `_base`) · `atelier_priceexdutynz` Price ex Duty ($NZ) ·
`atelier_priceincldutynz` Price Incl Duty ($NZ) · `atelier_landedcostnz` Landed Cost ($NZ) ·
`atelier_retailsellpricenz` Retail Sell Price ($NZ) · `atelier_tradesellpricenz` Trade Sell Price
over 5m · `fulmar_tradesellpricewithsurchargenz` Trade Sell Price under 5m ·
`atelier_5sellpricenz` / `atelier_10sellpricenz` tier prices

**FX** `exchangerate` Exchange Rate · `atelier_effectiveexchangerate` Price Exchange Rate

**Override lane** `atelier_setpricesmanually` Set Prices Manually, plus the `atelier_manual*` family:
Duty %, Markup to Trade %, Freight/Shipping ($NZ), Price including Freight ($NZ),
Trade ex Freight/Shipping ($NZ), Wholesale Price (+ `_base`)

**Empty in every row:** `Range OLD`, `Type OLD`, `Record Created On`, both `(Delegate)` columns.

### Findings

**The `atelier_manual*` columns are the override lane, not the parameters.**
`Set Prices Manually` = **Yes on 55 of 19,327 rows (0.28%)**. The manual columns are populated on
20–73 rows each (Wholesale Price 73, Trade ex Freight/Shipping 54, Price including Freight 53,
Markup to Trade % 39, Duty % 37, Freight/Shipping 20). This is exactly the
`calculated_value` / `override_value` split proposed in Build Spec §3.4 — confirmed live in the
incumbent schema. Practical consequence: **~19,272 clean auto-mode rows** are available for the §3.5
Step-3 acceptance diff, and the 55 manual rows are legitimate exclusions rather than mismatches.

**The five waterfall parameters are NOT exported.** They live on the range (or in the C# engine).
They are, however, recoverable by regression from the output ratios below.

**Step 8 — tiers strike off Trade Sell Price, and do not stack.**

| Check | Matches (±$0.02) | Misses |
|---|---|---|
| `10% Sell Price = Trade over-5m × 0.90` | 19,235 | 36 |
| `5% Sell Price = Trade over-5m × 0.95` | 19,233 | 3 |

Resolves the open question in §3.1 step 8 and the A12 stacking ambiguity: two independent tiers off
the trade price, not a compounded chain and not struck off retail.

**Step 4 — duty is a flat 5%, applied only to duty-class rows.**
`Price Incl Duty ÷ Price ex Duty` = exactly **1.00 on 17,776 rows** and **1.05 on 1,218 rows**
(the remainder are rounding-noise neighbours of 1.05). `Duty Rate` is blank on 17,871 rows and `A`
on 1,456. This is A10's "real duty table" — it is a single 5% band keyed on duty class `A`, matching
Charlotte's 15 Jul note that duties cap around 5%.
**The 7% duty placeholder used downstream in the CRM `/import` wizard is wrong and should go.**

**Step 2 — Export Price is Wholesale Rate times a discrete supplier discount.**
`Export Price ÷ Wholesale Rate` takes a small set of exact values:

| Ratio | Rows | Reading |
|---|---|---|
| 1.00 | 13,029 | discount-inclusive supplier — step skipped |
| 0.80 | 3,142 | −20% |
| 0.70 | 1,973 | −30% |
| 0.75 | 523 | −25% |
| 0.50 | 250 | −50% |
| 0.90 | 189 | −10% |

A single resolved multiplier per row, not a visibly compounded chain.

**FX — two rates, and the second one is the authority.**
`Exchange Rate` takes exactly four values: EUR **0.45** (10,508 rows), USD **0.51** (6,563),
GBP **0.38** (2,229), NZD 1 (26) — an annually-set table in foreign-per-NZD, matching the demo's
`fx.js` convention. `Price Exchange Rate` matches it except on **14 rows** (0.5 / 0.54 / 0.55).
Reading: `Exchange Rate` is the annual planning rate, `Price Exchange Rate` is the rate actually
struck on the row. **A9 answer: import Price Exchange Rate as authoritative; keep Exchange Rate for
provenance.** Confirm the direction convention with Derek before dividing by it.

**Steps 6–7 — markups are per-range and derivable.**
`Retail ÷ Landed` clusters on 2.405 (5,794 rows), 2.21 (3,336), 2.275 (3,176), 2.197 (1,542),
2.457 (1,049), 2.145 (807). `Trade ÷ Landed` clusters on 1.85 (6,442), 1.70 (3,754), 1.75 (3,537),
1.69 (1,538), 1.89 (1,039), 1.65 (807). 50 distinct ranges in the file. Grouping the rows by range
reconstructs the per-range markup table the C# engine holds — the §3.2 range-level inheritance,
recovered from data rather than from code.

**Reference distributions**

- Type: Fabrics 11,553 · W/P 6,289 · Trimmings 796 · Accessories 577 · Leather 50 ·
  Samples and Displays 34 · Throws/Blankets 12 · blank 9
- Pack Type: P/M 8,650 · P/Y 5,755 · P/Roll 2,831 · P/P 2,026 · Hide 46 · blank 19
- Currency: Euro 10,508 · US Dollar 6,563 · Pound Sterling 2,230 · NZD 26
- Freight Rate: A 11,783 · B 5,431 · C 1,496 · D 589 · E 1 · blank 27
- Status: Active on all 19,327 (the view is pre-filtered — an all-states pull would show the rest)

`Leather`, `Samples and Displays` and `Throws/Blankets` are **outside** the current
`price_list_items.category` check constraint (`fabric|wallpaper|trimming|accessory`), and `Hide` is
already in the `unit` constraint but has no template rows. The constraint needs widening or an
explicit mapping decision before import.

---

## 3. Stock Items

54 columns. Two of them were cut off in the screenshot review and turn out to matter a lot:
`fulmxero_xerostockonhand` **Xero Stock on Hand** and `fulmxero_xerotod365stockdifference`
**Xero to D365 Stock Difference**.

**A3 is a five-row problem.** The Xero-to-D365 stock difference is non-zero on **5 of 7,611 items**.
Stock On Hand is non-zero on 368 items; Xero's figure is non-zero on 372. The "which system owns
stock quantity, and how do we tie-break at cutover" question can be settled from this file directly.

**The 5m surcharge is a stock-item mechanic.** `Min Qty to avoid surcharge` = **5 on 987 items**,
3 on 5 items, blank on 6,619. `Trade Price with Surcharge` is populated on 4,253 items. But on the
price-list side, under-5m differs from over-5m on only **4 of 19,327 rows**. So the small-cut
surcharge is applied per stock item, not per price-list row. **This requirement appears nowhere in
the Build Spec, the reports doc, or the demo pricing engine — it is new scope discovered from the
export.**

**Other counts**

- `Product Price list` (the FK back to Product Prices) is **missing on 1,064 items (14%)** — those
  SKUs have no price join and need triage.
- Status Reason: Active 4,156 · **Inactive 3,455** — nearly half the catalogue is dead. Decide
  whether inactive items migrate at all.
- 55 distinct suppliers, 77 distinct ranges (vs 50 ranges on Product Prices — the range master is
  wider than the priced set).
- Can Sell = Yes on all 7,611; Can Track = No on 85.
- `Item Measure`: P/M 5,266 · P/Y 906 · Each 435 · P/Roll 383 · Hide 59 · Per Set 5 ·
  IP/Dblrl 4 · **blank 553**. `Each`, `Per Set` and `IP/Dblrl` (double roll) are outside both
  `inventory.unit` (`metres|units`) and `price_list_items.unit`. A11 needs a mapping table, and the
  553 blanks need a default.
- **`Reserve` is free text, not a quantity.** 112 items populated, **zero of them numeric** —
  staff use it as a note: *"ALL 53.5m - Leanne / Harvey"*, *"reserved for Wendy KK 28-10-2022"*,
  *"actual stock 8.4- JC 15/4/26"*. Staged as `reserve_note text`. **Consequence:
  `inventory.qty_reserved` has no legacy source and cannot be migrated** — reservations start empty
  at cutover, or come from an operational process we define. Available Cuts (220 items) is likewise
  free text.
- The Xero chart-of-accounts mapping lives **here**, not on Accounts: Inventory Account 7,563 ·
  Purchasing Account 7,610 · Sales Tax Rate 7,609 · Purchasing Tax Rate 7,598. Capture it — it is
  the A4 boundary data and expensive to re-derive after the environment is switched off.

---

## 4. Accounts

190 columns; 86 of them empty in every row. The file is named "Customers" but is **not filtered** —
`Is Customer` Yes 321 / No 538, `Is Supplier` Yes 21. Split on the flags, not the view name.
Customer Type: Trade 828 · Retail 15 · blank 23.

**Populated and valuable**

- `fulmxero_xerocontactid` **Xero Contact ID on 853 of 866** — the A4 match key, near-complete.
  (`Xero Network Key` is empty; not needed.)
- **Territory on 836**: Upper North Island 481 · South Island 205 · Lower NI official 142 · Other 8.
  `Province` (`territorycode`) is the granular axis: Auckland 385 · Canterbury 140 · Wellington 111 ·
  Otago 44 · Bay of Plenty 29 · "Default Value" 31. **A7 answered** — territory is the macro-region
  on the account, province the city/region. Hygiene: "Lower NI official" and "Default Value" need
  cleaning.
- `atelier_accountnumber` Atelier Account Number 859 · `accountnumber` Exonet DR 581 ·
  `atelier_exonetcracnumber` 19 — legacy document reconciliation keys.
- CRM fields Atelier actually uses: Last Sales Contact 657 · Next Sales Contact Due 625 ·
  Oldest Sample Due Back 209 · Sales Warning Message 168 · Order/Stock Check Details 3 ·
  Default Reserve Days 4.
- Consent state: the six `donot*` flags are populated on every row; GDPR Optout 192 ·
  Marketing Only 327 · Last Date Included in Campaign 230. **Must migrate before any Mailchimp push.**

  **Polarity trap.** The export renders these by their D365 *label*, whose wording is the inverse of
  the attribute: `donotemail = false` prints as **"Allow"**, `donotsendmm = false` prints as
  **"Send"**. A column named `send_marketing_materials` fed from `donotsendmm` would invert every
  row's consent. Staging keeps D365's polarity and D365's naming (`do_not_*`, TRUE = do not
  contact); interpretation happens downstream. Actual state: 1 account opted out of email, 6 out of
  bulk email, 15 out of marketing material. Guarded by
  `test/legacy-import.test.js` ("preserves D365 consent polarity verbatim").
- Credit Limit 202 · Payment Terms 734 · Payment Terms Sales 801 · Sales Days 804.
- Bank account fields on 15–29 rows (suppliers). **Sensitive — keep out of any committed artefact.**

**Empty, so cannot be sourced from D365**

`Price List` (all 866 blank), Sales/Purchases AC Code, Sales/Purchases Tracking 1–2, AR/AP Tax Type,
Aging 30/60/90, Annual Revenue, Category, Date Of Last Ativity, Preferred User, Shipping Agent,
Shipping Contact, Managing Partner, plus the usual D365 boilerplate (SIC Code, Ticker Symbol,
Stock Exchange, Shares Outstanding, KPI, SLA, Satori/Twitter IDs, Yomi name).

**Two findings that change the plan**

1. **72% of accounts have no attributable owner.** Owner = "Atelier Sales" 491 + "Showroom #" 135 =
   626 of 866. Named owners: Charlotte 202 · Rebecca 28 · D365 App User 5 · Jenette 3 · Liz 1 ·
   Jessica 1. This is A6's shared-login attribution gap, quantified — and it means "Sales per Owner"
   is unreportable on historical data without a back-attribution rule.
2. **Discount tiers are per-order, not per-account.** `Price List` is empty on every account and
   `Discount` is set on 14 (values 5, 8, 10, 0). Meanwhile `Sales Order Discount %` is set on 17 of
   48 orders (10% on 9, 5% on 8). A12's tier structure therefore has to be reconstructed from order
   history, not from the account master.
3. **Account email lives on the contact.** Account `E-mail` 454 vs `E-mail (Primary Contact)` 834.
   The Contacts entity is mandatory, not optional.

---

## 5. Sales Orders — not yet usable

48 rows, header only. All 48: Owner and Created By = Jenette Canlapan, Pricing Type = Trade, Status
Reason ∈ {Order Confirmation 41, Draft 7}. `Contact` empty on all rows. This is the *Current Sales
Orders* view — open orders, no history.

The hidden sheet gives the full lifecycle vocabulary, which no current order exercises:

> Draft → Pending Confirmation → Sales Order → Order Confirmation → Packing Slip →
> Invoice Sent to Xero → Cancelled Order → Archived Order

Compare to `orders.status` in this repo (`requested|confirmed|paid|shipped|declined`) — different
vocabulary, and "Invoice Sent to Xero" has no equivalent.

**The blocker: line items are a separate entity and were not exported.** No SKU, quantity, unit
price, per-line salesperson, or cut requirement exists in any of the four files. Without the
sales-order detail entity there is no `order_lines` data at all, and no sales history for any of the
ten target reports.

---

## 6. Still to export

Ordered by dependency; the licence extension is the constraint.

1. **Sales order line items** — the hard blocker (SKU, qty, unit price, line salesperson, delayed-until,
   exclude-shipping flag; qty is free text like "18 m", so capture the raw string per A11).
2. **All Sales Orders**, not the current-open view — filtered by order date to whatever history depth
   A14 settles on.
3. **Range/Type (Xero…)** — `Range` and `Type` are Xero tracking *options*
   (`fulmxero_trackingoption1id` / `2id`, owned by `fulmxero_trackingcategory1id` / `2id`). This
   entity is the parameter home (§3.2 range-level inheritance) and the only Range → Brand → Supplier
   link. Product Prices carries **no supplier column at all**, and `price_list_items` is keyed
   `(supplier, category, code)` — without this entity the price export cannot be keyed.
4. **Contacts.**
5. **Purchase Orders + lines, Purchase Invoices, Sales Invoices** — the buy side and the invoice
   history behind reports 1, 2, 7 and 8.
6. Cuttings, Reserves, Samples / Sample Histories, Stock Item Locations.

---

## 7. The pipeline (built)

Mirrors the ratified price-list pipeline — same two-step shape, same fail-loud posture:

```
incoming/data-exports/*.xlsx              the raw D365 pulls (incoming/ is gitignored)
incoming/data-exports/normalized/*.json   npm run convert:legacy
scripts/convert-d365-exports.py           stdlib-only, same posture as convert-price-lists.py
src/seed/legacy-import.js                 validate-before-SQL, chunked unnest, one transaction
src/seed/import-legacy.js                 npm run import:legacy
migrations/1785542400000_legacy-d365-staging.js
test/legacy-import.test.js
```

Normalised JSON stays under `incoming/` rather than `src/seed/data/` because the account and
sales-order exports are client PII and must never be committed. Supplier bank-account columns are
dropped at conversion time and never reach the database at all.

**Land raw first, map second.** One staging table per entity, keyed on the D365 record GUID, plus
`row_checksum`, `source_file`, `exported_at`, and a `raw` jsonb holding every non-empty column
verbatim by D365 logical name. A separate mapping pass then promotes staged rows into live tables.
Three reasons: A1/A2/A3 are still unsettled; the import must run repeatedly until cutover; and
re-mapping must never require re-exporting from an environment being switched off.

Design details worth keeping:

- **Columns are identified by D365 logical name, never by display name or position.** The dynamic
  worksheet embeds a `logical_name=Display Name` map in `sheet.xml`; the converter reads it and
  fails if a required logical name is absent. Renaming a column in the D365 view cannot break the
  import, and a reordered view cannot silently shift values into the wrong column.
- **Re-pulls are idempotent.** Upsert target is the GUID, so `import:legacy` twice leaves row counts
  unchanged and refreshes values in place. Rows absent from a later export are kept — a deleted D365
  record does not silently vanish from staging.
- **Duplicate exports are caught automatically.** The stray `Export.xlsx` re-presented all 19,327
  price rows; the converter deduped them on GUID and reported it.
- **Validation runs before any SQL**, including the duplicate-GUID check — a multi-row upsert cannot
  touch the same conflict key twice (`ON CONFLICT DO UPDATE command cannot affect row a second
  time`). Unknown columns are rejected rather than silently dropped.
- **`raw` must be `JSON.stringify`'d** before binding — pg maps a raw JS object to a Postgres record,
  not jsonb (same trap as `hex_tones` in the catalogue seed).

Loaded on 29 Jul 2026: 19,327 product prices · 7,611 stock items · 866 accounts · 48 sales orders.

### Target mapping (not yet performed)

| Export | Target |
|---|---|
| Product Prices — inputs | `price_list_items` (1:1 on existing columns) |
| Product Prices — waterfall outputs, FX pair, Set Prices Manually | **new** table. Do not fold into `price_list_items`: these are derived values whose entire purpose is to be diffed against our recomputation |
| Stock Items | `colourways` (Item Code → `sku`, Product Price list → `product_id`) + `inventory` (Stock On Hand → `qty_available`, Reserve → `qty_reserved`, Item Measure → `unit`) |
| Accounts / Contacts | **no table exists.** `users` is auth-only; a trade account is not a login. Needs new `accounts` + `contacts`, with `users` linked later |
| Sales Orders + lines | **staging only** — see trap 3 |

### Schema traps

1. `inventory` upserts are `DO NOTHING` by design (reservations are live operational data), so a
   legacy import routed through the seed path silently no-ops. It needs its own explicit write path.
2. `order_lines.colourway_id` is `NOT NULL` with `ON DELETE RESTRICT`. Every legacy line needs a
   matching colourway, so Stock Items must import before orders, and unmatched lines need a
   quarantine table.
3. `orders.kind` and `orders.status` check constraints have no legacy values, and `orders` has no
   columns for salesperson, currency, exchange rate, reference, expected delivery date, GST or
   discount %. More importantly the commerce tables are owned by the Stripe webhook and the
   admin-orders state machine — injecting historic D365 orders would desync `qty_reserved`.
   **Legacy sales history belongs in its own tables, joined for reporting only.**
4. `price_list_items.category` (`fabric|wallpaper|trimming|accessory`) excludes Leather, Samples and
   Displays, and Throws/Blankets. `inventory.unit` (`metres|units`) excludes Each, Per Set, IP/Dblrl.
   Both constraints need a decision before import.
5. `inventory.qty_reserved` has no legacy source at all — D365's Reserve field is prose (§3).

---

## 8. Open questions

**Derek (Fulmar)**
- Confirm the FX convention on `Exchange Rate` / `Price Exchange Rate` (foreign-per-NZD assumed) and
  when the effective rate diverges from the annual one.
- Confirm the per-range markup table can be regressed from `Retail ÷ Landed` and `Trade ÷ Landed`, or
  supply it directly.
- Where does the 5m surcharge rule live — the "under 5m" price, `Min Qty to avoid surcharge`, or the
  C# engine?
- Which entity holds the sales-order line items, and can it be exported through the same view path?

**Charlotte**
- Duty is a single 5% band on duty-class `A` (1,456 of 19,327 rows). Confirm that is the complete
  duty table — A10 may already be closed.
- Mapping for Leather / Samples and Displays / Throws/Blankets and the units Each / Per Set /
  IP/Dblrl.

**Liz / Jenette**
- A6: 626 of 866 accounts sit on the "Atelier Sales" or "Showroom #" shared logins. What is the
  back-attribution rule for historical sales?
- A12: discount tiers are recorded per order (5% / 10%), not per account. Confirm the tier structure
  from order history once it is exported.
- A14: how many years of sales-order history to pull, and do the 3,455 inactive stock items migrate?

---

## 9. Reproducing this analysis

Parsing is stdlib-only (zipfile + ElementTree), identical in approach to
[`scripts/convert-price-lists.py`](../scripts/convert-price-lists.py): read `xl/sharedStrings.xml`,
then `xl/worksheets/sheet2.xml` for the data grid (`sheet.xml` holds the schema map). Header cells
arrive as inline strings; body cells as shared-string indices or raw numerics. Excel serial dates use
the 1899-12-30 epoch.
