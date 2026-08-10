# D365 legacy export — column audit & data findings

*Verum · 29–30 Jul 2026 · analysis of the eleven Dynamics 365 exports in `incoming/data-exports/` (gitignored)*

Companion to `atelier-platform-demo/Atelier-Reports-Data-Requirements.md` (items A1–A15) and
`Atelier-Verum-Build-Spec.md` §3 (pricing waterfall) / §5 (data model).

Context: Derek Simpson (Fulmar) walked through the D365 export mechanics on 28 Jul — Product Prices
are the price-list spine, Stock Items are only created when a sales order is processed (a price-list
item spawns one stock item per colourway, with a suffix appended to the code), Accounts toggles
between customer and supplier views, and an export is capped at 100,000 rows. The legacy environment
is on a one-month licence extension, so this is likely the only clean pull we get.

**Status: the exports are now staged in Postgres.** `npm run convert:legacy && npm run import:legacy`
loads all eleven into `legacy_*` tables (§7) — **55,877 rows**. Nothing has been mapped into the live
catalogue or commerce tables yet; that step is gated on A1/A2.

**Two findings from the 29 Jul pull were corrected by the 30 Jul pull** (§3a):

1. Reserved quantity *does* have a legacy source — a separate `fulmar_reserve` entity with numeric
   quantities. The free-text `Reserve` note on the stock item is not the reservation record.
2. Real sales history *does* exist — 7,002 sales invoices back to Nov 2019, each linked to its sales
   order and its Xero invoice. The 48-row open-orders export was not the whole picture.

---

## 1. What landed

| File | Entity (logical name) | Rows | Cols |
|---|---|---|---|
| `Active Product Prices 29-07-2026 9-40-36 AM.xlsx` | `atelier_productprices` | **19,327** | 51 |
| `Stock View 29-07-2026 9-48-16 AM.xlsx` | `fulmxero_item` | **7,611** | 54 |
| `Customers 29-07-2026 9-50-28 AM.xlsx` | `account` | **866** | 190 |
| `Current Sales Orders 29-07-2026 9-47-16 AM.xlsx` | `fulmxero_salesorder` | **48** | 34 |
| `Export.xlsx` | — | — | — |
| **30 Jul pull** | | | |
| `Active Contacts 30-07-2026 …` | `contact` | **2,662** | 225 |
| `Active Sales Invoices 30-07-2026 …` | `fulmxero_salesinvoice` | **7,002** | 38 |
| `Active Item Locations 30-07-2026 …` | `fulmxero_itemlocation` | **7,575** | 25 |
| `Active Purchase Orders 30-07-2026 …` | `fulmxero_purchaseorder` | **5,268** | 37 |
| `Active Purchase Invoices 30-07-2026 …` | `fulmxero_purchaseinvoice` | **2,663** | 33 |
| `Active Cuttings 30-07-2026 …` | `fulmar_cutting` | **1,886** | 26 |
| `Active Reserves 30-07-2026 …` | `fulmar_reserve` | **969** | 30 |

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
[`scripts/convert-price-lists.js`](../scripts/convert-price-lists.js) maps one-to-one onto this entity,
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

## 3a. The 30 Jul entities

### Reserves (`fulmar_reserve`) — 969 rows — **corrects §3**

The reservation record Atelier actually keeps. **967 of 969 rows carry a numeric `quantity`,
totalling 10,978.1 units**; all 969 carry a `product_code` (a related-entity lookup back to Product
Prices); 756 carry a `reserved_until` date spanning 2024-07-25 → 2026-08-15. Also `cfa`, `customer`,
`customer_contact`, `comments`, and the customer's owner.

**`inventory.qty_reserved` therefore has a legacy source after all.** §3's conclusion was drawn from
the stock item's free-text `Reserve` column, which is a staff note; it is not the reservation ledger.
This entity also gives the Reserves Form Workflow a real data model rather than a process sketch.

### Sales invoices (`fulmxero_salesinvoice`) — 7,002 rows — the A2/A4 spine

- **6,846 of 7,002 link to a sales order**; **7,000 of 7,002 carry a `xero_invoice_id`.** That is the
  A4 match key, already populated — it does not need inventing.
- Date range **2019-11-08 → 2026-07-29**, ~6.7 years. Total NZ$15,051,540 ex-GST (base currency).
- `pricing_type`: Trade 6,888 · Retail 114. Retail is 1.6% of invoiced volume.
- **A12, answered from real transactions.** `sales_invoice_discount_pct` is set on 2,662 invoices:

  | Discount | Invoices |
  |---|---|
  | 10% | 1,447 |
  | 5% | 680 |
  | **8%** | **495** |
  | 0% | 37 |
  | 7% | 2 |
  | 13% | 1 |

  The live structure is **three tiers — 5% / 8% / 10%** — not the 2-tier −5/−10 the demo assumed and
  not the −25/−30/−35 placeholder. The 7% and 13% rows are one-offs. This also confirms the tier is a
  per-transaction choice, not an account attribute.
- Carries `xero_interface_error`, so failed Xero pushes are visible.

### Purchase orders (`fulmxero_purchaseorder`) — 5,268 rows — part-answers A13

- **`shipping_agent` is DHL Express on 4,563 of 4,574 populated rows (99.8%)**; the others are
  Rubelli/Dominique Kieffer (9), Mainfreight Air & Ocean (1), de Le Cuona (1). A13's "default
  shipping agent per supplier" collapses to essentially one agent — no per-supplier table needed.
- 37 distinct vendors; range 2019-04-17 → 2026-07-29.
- `delivery_instructions` populated on only 30 POs; also carries `delivery_address`, `attention`,
  `phone`, `location`, `pickup_date`.
- **Header only — no PO lines.** Outstanding balance (ordered − received) is still not computable, so
  report 1 (Shipment/outstanding) remains blocked.

### Purchase invoices (`fulmxero_purchaseinvoice`) — 2,663 rows

Vendor, dates, GST triplet in both currencies, `xero_invoice_id`,
`shipping_agents_invoice_number` (the freight invoice — relevant to report 2's freight/duty
apportionment). Header only.

### Contacts (`contact`) — 2,662 rows

- **`email` populated on 2,395** (vs 454 on the account) — confirms §4: usable email lives here.
- 2,109 linked to a company, 1,004 with a job title, 848 with a mobile.
- `xero_contact_number` populated on **1 row** — contact-level Xero linkage is effectively absent;
  the account's `xero_contact_id` stays the match key.
- Consent: 33 no-email, 67 no-marketing-material. **`include_in_emails` is TRUE on zero rows** —
  either unused or inverted; do not treat it as an opt-in signal without confirming.
- 225 columns, overwhelmingly D365 boilerplate. **`adx_identity_*` (portal password hash, security
  stamp) is dropped at conversion and never reaches the database** — same treatment as the supplier
  bank details.

### Item locations (`fulmxero_itemlocation`) — 7,575 rows — **do not use as a key yet**

- **Exactly one location: "Atelier Textiles Limited".** Multi-location stock is not in use, so this
  is a near-1:1 shadow of the stock item.
- **The `item` column is a display-name lookup, and stock-item names are not unique** — 7,611 items
  share 6,315 distinct names ("Loire Ecru" appears 22 times). So this table **cannot be joined back
  to a stock item reliably.** A re-export carrying the item's GUID or Item Code would fix it.
- **Unexplained stock discrepancy.** Summed independently per table:
  `legacy_stock_items.stock_on_hand` = **5,332.8** (368 non-zero) and `xero_stock_on_hand` = 5,421.8
  — those two broadly agree. But `legacy_item_locations.total_stock_on_hand` = **14,157.9** (780
  non-zero), 2.65× higher. One of the two is not what "on hand" means. **This must be resolved before
  A3's opening balances are trusted** — it is a bigger gap than the 5-row Xero/D365 difference.

### Item codes are composed per sales order, not catalogued

Confirmed by Atelier and visible in the data. A stock item does not exist until someone orders that
combination of options; the code is assembled at that moment. The grammar:

```
{supplier's colour-specific code}[ {YY}{SUPPLIER_TOKEN}]

F3518-003 23PF     price code F3518 + colour -003 + created 2023 + Pierre Frey
JT013819006 23JT   supplier code JT013819 + colour 006 + 2023 + Jim Thompson
TOSCA 21ST         design TOSCA + 2021 + Stroheim
10190 20MIWP       colour 10190 + 2020 + Missoni Wall Covering
CUSH*SPEC55X55     house finished good — no suffix
```

**5,671 of 7,611 item codes (74.5%) carry the ` {YY}{TOKEN}` suffix**, across **62 distinct tokens**
and years **11 → 26** (2011–2026). The remaining 25.5% are house/finished goods and plain-numeric
Fabricut codes. The token identifies the **supplier, not the brand** — `CF` spans Colefax & Fowler
*and* Jane Churchill, `FA` spans Fabricut *and* Clarence House, `RU` spans Rubelli *and* Kieffer. That
is the Supplier→Brand layer of Build Spec §3.4, recoverable empirically: the 62 tokens are a supplier
reference table, and their range spread is the brand roll-up A13 asks for.

Three consequences for the mapping:

1. **Product Prices is the catalogue spine, Stock Items is the transacted subset.** 19,327 priced
   designs vs 7,611 materialised SKUs — most designs have never been ordered. So Product Prices →
   `products` (design grain) and Stock Items → `colourways`, with the understanding that a colourway
   row only exists once it has been sold.
2. **The item code's numeric part is the supplier's colour code, not the price-list code.** They
   frequently differ (price code `40951` for SUMI vs item `30093-03`; `222917` for VANESSA vs
   `10190`; `5557` ARASHI vs `5559`). Do not attempt to match stock items to price rows on code.
3. **`colourways.sku` "typed by staff, not generated" should be revisited.** CLAUDE.md records that
   the CRM's Brand-Product-Colour generator was deliberately not ported. The legacy data shows the
   suffix half of the code is purely mechanical (year + supplier token) while the numeric half comes
   from the supplier's price list — so a generator is feasible for the part that matters. Flagged, not
   changed.

### The stock ↔ price link is destroyed by the export, and it is fixable

`fulmxero_productpriceid` is a real foreign key inside D365, but a dynamic worksheet renders a lookup
as the target's **display name** — here the price row's Description, i.e. the design name. Design
names repeat, so the key does not survive:

| Stock items (7,611) | Count | Share |
|---|---|---|
| Resolve to exactly one price row by design name | 3,971 | 52.2% |
| Design name matches **multiple** price rows (VOLTERRA matches 25) | 796 | 10.5% |
| Design name matches **no** price row | 1,780 | 23.4% |
| No `product_price_list` value at all | 1,064 | 14.0% |

**The fix is proven by the exports we already have.** Reserves and Cuttings were exported with the
related record's *code* rather than its name (`Code (Product) (Product Prices)`), and those join
cleanly:

| Export | Rows | Resolve to one price row | Ambiguous | No match |
|---|---|---|---|---|
| Reserves | 969 | **850 (87.7%)** | 51 | 68 |
| Cuttings | 1,886 | **1,742 (92.4%)** | 60 | 84 |

So the ask is narrow and needs no new entity: **add the related code column to the Stock Items view
and the Item Locations view** — "Code (Product Price list) (Product Prices)" and the item's "Item
Code" respectively — then re-export those two. Same mechanism, already in use elsewhere in the same
D365 org.

### Cuttings (`fulmar_cutting`) — 1,886 rows

Same shape as reserves minus the expiry: range, customer, product + `product_code`, colour code,
supplier, numeric `quantity`, comments. Gives the shelved Cutting Form Workflow a real data model.

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

1. **Re-export Stock Items with `Code (Product Price list) (Product Prices)` added**, and **Item
   Locations with the item's `Item Code` added.** Cheapest, highest-value ask on this list: it restores
   the stock↔price key on ~48% of stock items that currently cannot be linked at all, and makes item
   locations joinable. No new entity, no new permissions — the same related-column mechanism the
   Reserves and Cuttings views already use (§3a).
2. **Range/Type (Xero…)** — `Range` and `Type` are Xero tracking *options*
   (`fulmxero_trackingoption1id` / `2id`, owned by `fulmxero_trackingcategory1id` / `2id`). This
   entity is the parameter home (§3.2 range-level inheritance) and the only Range → Brand → Supplier
   link. Product Prices carries **no supplier column at all**, and `price_list_items` is keyed
   `(supplier, category, code)` — without this entity the price export cannot be keyed. *Partial
   fallback exists:* the 62 supplier tokens embedded in item codes give an empirical
   supplier↔brand roll-up (§3a).
3. **All Sales Orders**, not the current-open view (48 rows). Lower priority than it was — the
   sales-invoice history already reaches back to Nov 2019, so the invoice side of A14 is covered.
4. **Receipts / goods-received entity**, if one exists — partial receiving is the known gap and
   nothing in these eleven exports records a receipt.
5. Samples / Sample Histories / Sample Tracker.

**SHELVED — line items for all four transaction entities.** Sales orders, sales invoices, purchase
orders and purchase invoices are all header-only (roll-up totals, no SKU/qty/unit price), and there is
no available export path for the detail rows. Decision: do not pursue. Standing consequences, to be
solved another way or accepted:

- `order_lines` cannot be populated from legacy data — legacy sales history stays header-grain.
- Reports 5, 6 and 7 cannot be sliced by range / brand / supplier from history; only by
  customer, owner, date and total.
- Reports 3 and 4 (zero-cost, margin exceptions) have no line-level cost or sell to work from.
- Report 1's outstanding balance (ordered − received) is not computable.
- Sales *by value* per customer/owner/period **is** available from the 7,002 invoice headers, so the
  comparative revenue reporting is not blocked — only the product-grain breakdowns are.

~~Contacts~~ · ~~Purchase Orders~~ · ~~Purchase Invoices~~ · ~~Sales Invoices~~ · ~~Cuttings~~ ·
~~Reserves~~ · ~~Stock Item Locations~~ — **delivered 30 Jul** (headers only where noted above).

---

## 7. The pipeline (built)

Mirrors the ratified price-list pipeline — same two-step shape, same fail-loud posture:

```
incoming/data-exports/*.xlsx              the raw D365 pulls (incoming/ is gitignored)
incoming/data-exports/normalized/*.json   npm run convert:legacy
scripts/convert-d365-exports.js           dependency-free, same posture as convert-price-lists.js
scripts/lib/                              shared zip/XML/xlsx readers + the D365 column map
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

- **Related-entity columns are matched on their suffix.** A column pulled from a linked record exports
  as `<relationship-guid>.<logical_name>` (e.g. `5c5e1693-….atelier_code` for "Code (Product)
  (Product Prices)"). The GUID is the relationship id and would change if the view were rebuilt, so
  the column map accepts a `*.atelier_code` wildcard key; a bare logical name always wins over one.

Loaded 29–30 Jul 2026 — **55,877 rows** across eleven tables: 19,327 product prices · 7,611 stock
items · 7,575 item locations · 7,002 sales invoices · 5,268 purchase orders · 2,663 purchase invoices
· 2,662 contacts · 1,886 cuttings · 969 reserves · 866 accounts · 48 sales orders.

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
5. ~~`inventory.qty_reserved` has no legacy source~~ — **superseded:** `legacy_reserves` carries
   numeric quantities for 967 rows (§3a). The mapping needs a rule for the 213 reserves with no
   expiry date and for reserves whose `reserved_until` is already past.
6. `legacy_item_locations` cannot be joined to a stock item (non-unique display-name key), and its
   on-hand total disagrees with the stock item's by 2.65× (§3a). Resolve before trusting A3.

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

Parsing is dependency-free (`node:zlib` for the zip members, a tag scanner for the XML — see
[`scripts/lib/`](../scripts/lib/)), identical in approach to
[`scripts/convert-price-lists.js`](../scripts/convert-price-lists.js): read `xl/sharedStrings.xml`,
then `xl/worksheets/sheet2.xml` for the data grid (`sheet.xml` holds the schema map). Header cells
arrive as inline strings; body cells as shared-string indices or raw numerics. Excel serial dates use
the 1899-12-30 epoch. D365 writes its SpreadsheetML with an `x:` element prefix while Excel writes the
default namespace, so tags are resolved through the document's prefix, never matched bare.
