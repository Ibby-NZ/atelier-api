# Xero tracking options — the pricing-parameter table

*Verum · 12 Aug 2026 · analysis of `Xero Range.xlsx` and `Xero Type.xlsx` in `incoming/data-exports/` (gitignored)*

Companion to [`d365-export-analysis.md`](./d365-export-analysis.md) §6 item 2 — "Range/Type (Xero…) … this entity
is the parameter home (§3.2 range-level inheritance) and the only Range → Brand → Supplier link" — and to
`atelier-platform-demo/Atelier-Reports-Data-Requirements.md` A10 (broker duty table) / A13.

These are the two exports the client has owed us since 9 July. They arrived today.

**Headline: four of the five missing waterfall parameters are now in hand, and they are exact.** Reconstructing
the incumbent's pricing engine from `Discount (%)`, `Duty Rate A/B/C (%)`, `Clearance` and `Trade Markup (%)`
reproduces the D365 export's own stored figures on **19,201 of 19,201** duty steps, **14,521 of 14,521**
discount steps and **19,161 of 19,199** trade-price steps. That is not a correlation, it is the engine.

**Freight is a dollar amount per unit. It is not a percentage, and it never was.** Proved below on 19,197 of
19,201 rows. The demo waterfall's 8% would be right on 632 of them.

**But the freight class letters are still not decodable from this table** — see §5, which is the one question
this delivery does not answer. It does, however, hand us the arithmetic that lets us *recover* them from the
price corpus, which was impossible before today.

---

## 1. What landed

| File | Entity | Sheet | Data rows | Cols | Bytes |
|---|---|---|---|---|---|
| `Xero Range.xlsx` | `fulmxero_trackingoption` | `Active Tracking Options` | **58** | 16 | 16,146 |
| `Xero Type.xlsx` | `fulmxero_trackingoption` | `Active Tracking Options` | **17** | 16 | 8,087 |

Both are **dynamic** worksheets of the same entity and the same 16-column view, so the whole apparatus
`scripts/convert-d365-exports.js` already has applies: `xl/worksheets/sheet.xml` carries the
`<entity>:<signature>:<logical>=<Display>&…` map, `xl/worksheets/sheet2.xml` carries the grid in that column
order, and every row carries its GUID and row checksum. The two files have **different view signatures** but
identical column sets — they are two saved views over one entity, filtered by tracking category.

Decoded map:

| # | Logical name | Display name |
|---|---|---|
| A | `fulmxero_trackingoptionid` | (Do Not Modify) Tracking Option |
| B | `checksumLogicalName` | (Do Not Modify) Row Checksum |
| C | `modifiedon` | (Do Not Modify) Modified On |
| D | `fulmxero_trackingcategoryid` | Tracking Category |
| E | `fulmxero_name` | Name |
| F | `fulmxero_supplierid` | Supplier |
| G | `fulmxero_dutyratea` | Duty Rate A (%) |
| H | `fulmxero_dutyrateb` | Duty Rate B (%) |
| I | `fulmxero_dutyratec` | Duty Rate C (%) |
| J | `fulmxero_clearance` | Clearance |
| K | `fulmxero_freight` | Freight |
| L | `fulmxero_discount` | Discount (%) |
| M | `atelier_trademarkup` | Trade Markup (%) |
| N | `fulmar_minqtytoavoidsurcharge` | Min Qty to avoid surcharge |
| O | `fulmar_surchargeperunit` | Surcharge $ per unit |
| P | `statecode` | Status |

Publisher prefixes tell the history: `fulmxero_` is the original Fulmar–Xero solution (name, supplier, the
three duty bands, clearance, freight, discount), `atelier_` is Atelier's own addition (trade markup),
`fulmar_` is a later Fulmar addition (the two surcharge columns). The waterfall was extended twice.

**Parsing note — these two workbooks have no `xl/sharedStrings.xml` at all.** Every text cell is written
inline (`<x:c t="inlineStr"><x:is><x:t>`), unlike the eleven July exports. A reader that only looks at `<v>`
elements silently returns empty strings for Tracking Category, Name and Supplier while happily reading every
number — which reads as "the client sent us a table of numbers with no labels" rather than as a parser bug.
`scripts/lib/xlsx.js` handles both forms (`cellValue` branches on `t="inlineStr"`); use it, not a regex.

---

## 2. Xero Range — all 58 rows

Blank cells are shown as `—`. `Modified` is the D365 `modifiedon`, rendered from its Excel serial in the
exporting user's local time (naive, per the house rule).

| Name | Supplier | Duty A | Duty B | Duty C | Clearance | Freight | Discount | Trade Markup | Min Qty | Surcharge | Status | Modified |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ALPAKA | Alpaka | 5 | 5 | 5 | 10 | 25 | 0 | 100 | — | — | Active | 2025-09-02 |
| ALTAGAMMA | Jannelli & Volpi | 5 | — | — | 10 | 35 | — | 65 | — | — | Active | 2025-09-02 |
| ARMANI CASA WALL COVERING | Jannelli & Volpi | 5 | 5 | 5 | 10 | 35 | — | 85 | — | — | Active | 2025-09-02 |
| ATELIER MISC | — | 5 | 5 | 5 | 10 | 26 | 0 | 100 | — | — | Active | 2024-12-17 |
| ATELIER STOCK | — | — | — | — | 10 | — | — | 100 | — | — | Active | 2024-12-17 |
| BRAQUENIE | Pierre Frey Paris | 5 | 5 | 5 | 10 | 28 | 0 | 87 | — | — | Active | 2024-12-17 |
| BROCHIER | Brochier | 5 | 5 | 5 | 10 | 50 | 0 | 92 | **5** | **20** | Active | 2025-09-02 |
| C & C MILANO | C & C Milano | 5 | 5 | 5 | 10 | 58 | 20 | 85 | — | — | Active | 2026-01-23 |
| C & C Milano Bedding | C & C Milano | **10** | **10** | **10** | 10 | 38 | — | 88 | — | — | Active | 2024-12-17 |
| CLARENCE HOUSE | Fabricut Inc | 5 | 5 | 5 | 10 | 23 | 0 | 85 | — | — | Active | 2026-02-02 |
| COLEFAX & FOWLER | Colefax & Fowler | 5 | 5 | 5 | 10 | 30 | 0 | 89 | — | — | Active | 2024-12-16 |
| DE LE CUONA | de Le Cuona | 5 | 5 | 5 | 10 | 50 | — | 70 | — | — | Active | 2026-03-22 |
| FABRICUT | Fabricut Inc | 5 | 5 | 5 | 10 | 23 | 30 | 70 | — | — | Active | 2026-02-02 |
| FADINI BORGHI | Pierre Frey Paris | 5 | 5 | 5 | 10 | 28 | 0 | 85 | — | — | Active | 2024-12-17 |
| FILIPPO UECHER | Mariaflora And Filippo Uecher | 5 | 5 | 5 | 10 | 52 | 10 | 88 | — | — | Active | 2026-01-23 |
| FINE | FINE TEXTILVERLAG GmbH | 5 | 5 | 5 | 10 | 52 | 0 | 88 | — | — | Active | 2026-01-22 |
| FOX LINTON | Jim Thompson / The Thai Silk Co. Ltd. | 5 | 5 | 5 | 10 | 52 | — | 87 | — | — | Active | 2026-01-23 |
| GARRETT LEATHER | Garrett Leather Corp | 5 | 5 | 5 | 10 | 10 | 0 | 70 | — | — | Active | 2025-09-02 |
| HAMAM | VERİTAS TEKSTİL KONFEKSİYON PAZARLAMA SAN. VE TİC. A.Ş. | 5 | **10** | 5 | 10 | **—** | 0 | 75 | — | — | Active | 2025-08-26 |
| JANE CHURCHILL | Colefax & Fowler | 5 | 5 | 5 | 10 | 30 | 0 | 85 | — | — | Active | 2025-09-02 |
| JANNELLI VOLPI | Jannelli & Volpi | 5 | 5 | 5 | 10 | 30 | — | 75 | — | — | Active | 2025-09-02 |
| JEAN MONRO | Jean Monro | 5 | — | — | 10 | 50 | — | 70 | — | — | Active | 2026-02-27 |
| JIM THOMPSON | Jim Thompson / The Thai Silk Co. Ltd. | 5 | 5 | 5 | 10 | 28 | 0 | 85 | — | — | Active | 2025-09-02 |
| JV DESIGN | Jannelli & Volpi | 5 | — | — | 10 | 30 | — | 75 | — | — | Active | 2025-01-28 |
| JV Fabric | Jannelli & Volpi | 5 | 5 | 5 | 10 | 50 | — | 70 | — | — | Active | 2026-02-02 |
| JWALL | Jannelli & Volpi | 5 | — | — | 10 | 30 | — | 70 | — | — | Active | 2025-01-28 |
| KIEFFER | Rubelli / Dominique Kieffer | 5 | 5 | 5 | 10 | 50 | 25 | 85 | — | — | Active | 2026-01-19 |
| LARSEN | Colefax & Fowler | 5 | 5 | 5 | 10 | 30 | 0 | 85 | — | — | Active | 2025-09-02 |
| LE CRIN | METAPHORES | 5 | 5 | 5 | 10 | 55 | 0 | 85 | — | — | Active | 2026-02-12 |
| LE MANACH | Pierre Frey Paris | 5 | 5 | 5 | 10 | 28 | 0 | 87 | — | — | Active | 2024-12-17 |
| LIBECO | Libeco-Lagae | 5 | 5 | 5 | 10 | 30 | 0 | 100 | — | — | Active | 2025-09-02 |
| LIBERTY | Liberty London | 5 | 5 | 5 | 10 | **51.5** | — | 85 | — | — | Active | 2026-01-25 |
| LINK OUTDOOR | Link Outdoor | 5 | 5 | 5 | 10 | 30 | 25 | 60 | **5** | **20** | Active | 2025-09-02 |
| LORO PIANA | Loro Piana | 5 | 5 | 5 | 10 | 49 | — | 65 | — | — | Active | 2026-02-11 |
| MADEAUX | Madeaux | 5 | 5 | 5 | 10 | 50 | 0 | 87 | — | — | Active | 2026-02-01 |
| MANUEL CANOVAS | Colefax & Fowler | 5 | 5 | 5 | 10 | 30 | 0 | 89 | — | — | Active | 2024-12-16 |
| MARIA FLORA | Mariaflora And Filippo Uecher | 5 | 5 | 5 | 10 | 52 | 10 | 80 | — | — | Active | 2026-01-23 |
| METAPHORES | METAPHORES | 5 | 5 | 5 | 10 | 49 | 0 | 75 | — | — | Active | 2026-02-12 |
| Miscellaneous | — | — | — | — | — | — | — | — | — | — | Active | **2020-08-26** |
| MISSONI WALL COVERING | Jannelli & Volpi | 5 | 5 | 5 | 10 | 38 | **50** | 85 | — | — | Active | 2025-09-02 |
| NICKY HASLAM | Jean Monro | 5 | — | — | 10 | 50 | — | 70 | — | — | Active | 2026-02-27 |
| NO 9 | Jim Thompson / The Thai Silk Co. Ltd. | 5 | — | — | 10 | 28 | — | 85 | — | — | Active | 2025-09-02 |
| PERENNIALS OUTDOOR FABRIC | Perennials Outdoor Fabrics | 5 | 5 | 5 | 10 | 55 | 20 | 65 | — | — | Active | 2026-02-08 |
| PIERRE FREY | Pierre Frey Paris | 5 | 5 | 5 | 10 | 28 | 0 | **69** | — | — | Active | 2024-12-17 |
| RAMM, SON & CROCKER | Jean Monro | 5 | — | — | 10 | 30 | — | 70 | **5** | **20** | Active | 2025-09-18 |
| RUBELLI | Rubelli / Dominique Kieffer | 5 | 5 | 5 | 10 | 50 | 25 | 85 | — | — | Active | 2026-01-19 |
| S HARRIS | Fabricut Inc | 5 | 5 | 5 | 10 | 30 | 0 | 85 | — | — | Active | 2026-02-02 |
| SETTE | SETTE E & D, S.L | 5 | 5 | 5 | 10 | 31 | 0 | 85 | **5** | **20** | Active | 2024-12-17 |
| SIRPI WALLCOVERING | Jannelli & Volpi | 5 | — | — | 10 | 30 | — | **63** | — | — | Active | 2025-01-28 |
| SOLBIATI | Solbiati | 5 | 5 | 5 | 10 | 26 | 0 | 100 | — | — | Active | 2024-12-17 |
| STOCK - INTERWEAVE | Inter-Weave Ltd | **0** | **0** | **0** | **0** | **2** | 0 | 100 | — | — | Active | 2024-12-17 |
| STOKER MILLS | Stoker Mills | 5 | 5 | 5 | 10 | 26 | 0 | 100 | — | — | Active | 2025-09-02 |
| STROHEIM | Fabricut Inc | 5 | 5 | 5 | 10 | 23 | 0 | 80 | — | — | Active | 2026-02-02 |
| THE VALE LONDON | The Vale London | 5 | — | — | 10 | 35 | **35** | 85 | **5** | **20** | Active | 2025-09-02 |
| TIMNEY FOWLER | Timney Fowler Ltd | 5 | 5 | 5 | 10 | 35 | 0 | 100 | **5** | **25** | Active | 2025-09-02 |
| TREND | Fabricut Inc | 5 | 5 | 5 | 10 | 20 | 20 | 70 | — | — | Active | 2026-02-02 |
| VEREL DE BELVAL | METAPHORES | 5 | 5 | 5 | 10 | 49 | 0 | 85 | — | — | Active | 2026-02-12 |
| VERVAIN | Fabricut Inc | 5 | 5 | 5 | 10 | 23 | 0 | 85 | — | — | Active | 2026-02-02 |

## 3. Xero Type — all 17 rows

| Name | Supplier | Duty A | Duty B | Duty C | Clearance | Freight | Discount | Trade Markup | Min Qty | Surcharge | Status | Modified |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Accessories | — | — | — | — | — | — | — | — | — | — | Active | 2020-05-18 |
| Bed Linen | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Bedding | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Candles | — | — | — | — | — | — | — | — | — | — | Active | 2020-04-19 |
| Curtain Accessories | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Cushions | — | — | — | — | — | — | — | — | — | — | Active | 2023-11-16 |
| Fabrics | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Furniture | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Leather | — | — | — | — | — | — | — | — | — | — | Active | 2020-05-06 |
| Miscellaneous | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| No Group Selected | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Rug/Carpet | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Samples and Displays | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Throws/Blankets | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Towels | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| Trimmings | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |
| W/P | — | — | — | — | — | — | — | — | — | — | Active | 2019-11-25 |

**The first-pass reading was right: Xero Type carries no numeric values whatsoever.** All ten parameter
columns and the Supplier column are empty on all 17 rows. Verified cell by cell through the library reader,
not by regex.

That is a finding, not a gap in the export. **Type is a vocabulary, not a parameter set.** It is the second
Xero tracking category — `fulmxero_trackingoption2id` on the price row, rendered as "Type" — and it exists to
tag a line for Xero reporting. Every pricing parameter in the incumbent hangs off the **Range**, which is the
brand. Do not go back to the client asking for "the Type rates"; there are none, and there never were.

---

## 4. What the grain actually is

### A Range row is a HOUSE, plus five rows that are not

`Name` is Atelier's own spelling of the maison, ALL-CAPS in 52 of 58 rows. Cross-checked against three
independent corpora, it is the same vocabulary as `legacy_product_prices.range_name` and
`price_list_items.product_range` — §8 measures the join.

Five of the 58 rows are not houses:

| Row | What it is |
|---|---|
| `ATELIER MISC` | Atelier's own miscellaneous line — 1 price row, 38 stock items |
| `ATELIER STOCK` | Atelier's own stock line — 17 price rows, 37 stock items. Freight, discount and all three duty bands blank; only clearance 10 and markup 100 |
| `STOCK - INTERWEAVE` | An NZ-domestic supplier (Inter-Weave Ltd). **Duty 0, clearance 0, freight $2** — the only row in the file with no duty and no clearance, which is exactly what a local purchase looks like |
| `Miscellaneous` | Entirely empty and last modified **2020-08-26**. Dead. |
| `C & C Milano Bedding` | Not a house but a *product line* of one — C & C Milano split in two so bedding can carry duty 10% and freight $38 against the main line's 5% and $58 |

And one house is split by supplier rather than by line: `KIEFFER` and `RUBELLI` are two ranges under one
supplier (`Rubelli / Dominique Kieffer`) with identical parameters, and `LE CRIN`, `METAPHORES` and
`VEREL DE BELVAL` are three under `METAPHORES`.

So the grain is: **one row per (house × product line) that Atelier prices differently.** It is a *pricing
parameter set*, and the house is how it is named. That is finer than a brand and much finer than a supplier.

### Supplier is the invoicing entity, and it is the axis we do not have

28 distinct values across 55 rows; 3 rows leave it blank (`ATELIER MISC`, `ATELIER STOCK`, `Miscellaneous`).

| Supplier | Ranges |
|---|---|
| Jannelli & Volpi | 8 (ALTAGAMMA, ARMANI CASA WALL COVERING, JANNELLI VOLPI, JV DESIGN, JV Fabric, JWALL, MISSONI WALL COVERING, SIRPI WALLCOVERING) |
| Fabricut Inc | 6 (CLARENCE HOUSE, FABRICUT, S HARRIS, STROHEIM, TREND, VERVAIN) |
| Colefax & Fowler | 4 (COLEFAX & FOWLER, JANE CHURCHILL, LARSEN, MANUEL CANOVAS) |
| Pierre Frey Paris | 4 (BRAQUENIE, FADINI BORGHI, LE MANACH, PIERRE FREY) |
| Jean Monro | 3 (JEAN MONRO, NICKY HASLAM, RAMM SON & CROCKER) |
| Jim Thompson / The Thai Silk Co. Ltd. | 3 (FOX LINTON, JIM THOMPSON, NO 9) |
| METAPHORES | 3 (LE CRIN, METAPHORES, VEREL DE BELVAL) |
| C & C Milano · Mariaflora And Filippo Uecher · Rubelli / Dominique Kieffer | 2 each |
| 19 others | 1 each |

**This is the Supplier → Brand roll-up A13 asks for, stated by the client rather than inferred.** It agrees
with everything `src/suppliers/CLAUDE.md` already records — Rubelli sells Dominique Kieffer, Jim Thompson
sells No.9 — and it settles the four-house Colefax question (`CF` covering Colefax & Fowler *and* Jane
Churchill in the item-code tokens) with the other two houses named as well.

It is also the sharpest evidence yet that **our `suppliers` table is mostly brands.** Only 8 of these 28
invoicing entities exist in it (§8); the other 32 rows in `suppliers` were created from price-list filename
prefixes, which name houses.

### A Type row is the product-type vocabulary

The 17 Type values map cleanly onto `legacy_product_prices.item_type` — every one of the ten types the
19,327 price rows actually use is here, plus seven that no price row uses (`Bed Linen`, `Candles`,
`Curtain Accessories`, `Cushions`, `Furniture`, `No Group Selected`, `Towels`). Nine price rows carry no
type at all.

---

## 5. The waterfall, reconstructed and verified

All checks below run over the **19,272 auto-mode rows** of `legacy_product_prices` (the 55 `Set Prices
Manually` rows are excluded, per `d365-export-analysis.md` §2). Tolerance is ±$0.02 against the export's own
stored figure.

```
1  Wholesale Rate                       (supplier's price list, supplier's currency)
2  Export Price      = Wholesale Rate × (1 − Discount/100)              ← Discount (%)
3  Price ex Duty $NZ = Export Price ÷ Price Exchange Rate
4  Price incl Duty   = Price ex Duty  × (1 + DutyRate<letter>/100)      ← Duty Rate A/B/C (%)
5  Landed Cost $NZ   = (Price incl Duty + FREIGHT$) × (1 + Clearance/100)
                                                     ↑              ↑
                                        per (range × freight letter)  Clearance
6  Trade Sell $NZ    = Landed Cost × (1 + Trade Markup/100)            ← Trade Markup (%)
   Retail Sell $NZ   = Landed Cost × <retail markup>                   ← NOT IN THIS TABLE
7  under-5m price    = Trade Sell + Surcharge $ per unit               ← per stock item, mostly
8  5% / 10% tiers    = Trade Sell × 0.95 / × 0.90                      (independent, do not stack)
```

| Step | Parameter from this table | Rows checked | Exact matches |
|---|---|---|---|
| 2 · discount | `Discount (%)` | 14,521 | **14,521 (100%)** |
| 4 · duty | `Duty Rate A/B/C (%)` keyed on the row's duty letter | 19,201 | **19,201 (100%)** |
| 5 · landed | `Clearance` + a per-(range × freight-letter) dollar freight | 19,201 | **19,197 (100.0%)** |
| 6 · trade | `Trade Markup (%)` | 19,199 | **19,161 (99.8%)** |
| 8 · 5% tier | — | 19,236 | 19,233 |
| 8 · 10% tier | — | 19,270 | 19,235 |

The 38 trade-markup misses are spread thinly (Jim Thompson 11, Manuel Canovas 6, four ranges with 4, six with
1) and look like rows whose landed cost was recomputed after the markup last changed — stale snapshots, not a
different rule.

---

## 6. Freight — a dollar amount, decisively

**The question is settled by two rows that need no statistics.**

`STOCK - INTERWEAVE` prices one NZD item: `Price ex Duty` 38.00, `Price incl Duty` 38.00, `Landed Cost`
**40.00**. Its parameters are duty 0, clearance 0, freight **2**. `38 + 2 = 40`. A 2% freight would give
38.76.

`GARRETT LEATHER` prices 42 hides at a wholesale rate of zero (price on application): `Price incl Duty` 0.00,
`Landed Cost` **11.00** on every one of them. Its parameters are freight **10**, clearance **10**.
`(0 + 10) × 1.10 = 11.00`. **A percentage of zero is zero.** There is no percentage reading of this row.

Generalised: `Landed = (Price incl Duty + freight$) × (1 + Clearance/100)`, computed on unrounded
intermediates, holds on **19,197 of 19,201 rows**. Isolating the freight term per (range × freight letter)
gives a constant to the cent — see §7's table, where every bucket agrees at ≥99.5% and most at 100%.

**Liz is right and the meeting record is right.** Freight has always been a dollar value applied per unit,
and nothing in the incumbent's engine treats it otherwise.

### The demo's 8% is wrong by a lot, in both directions

Expressing each row's real dollar freight as a percentage of its duty-paid value over the 19,159 rows where
that is computable:

| min | p5 | p25 | **median** | p75 | p95 | max |
|---|---|---|---|---|---|---|
| 0.0% | 5.0% | 15.9% | **27.0%** | 42.0% | 76.1% | 2,186% |

**632 rows of 19,159 (3.3%) fall in the 7–9% band where an 8% rule would be approximately right.** A flat
percentage under-charges freight on cheap goods by an order of magnitude and over-charges it on expensive
ones. Replace it with the dollar figure; do not "tune" the percentage.

### Clearance is a percentage, and its label does not say so

`Clearance` is 10 on 56 rows, 0 on `STOCK - INTERWEAVE` and blank on `Miscellaneous`. Every one of the three
other percentage columns is labelled `(%)` in the display name. This one is not — yet the arithmetic is
unambiguous: the 0.10 coefficient multiplies the *whole* duty-paid-plus-freight amount, and it disappears
exactly on the one range whose Clearance is 0.

Algebraically `(x + f) × 1.1` cannot be told apart from `x × 1.1 + f × 1.1`, so this analysis cannot say
whether the office thinks of it as a clearance loading on the goods or on the freight. It can say that it is
**not** a flat clearance fee in dollars: a $10 fee added to Garrett Leather's zero-cost hides gives $10, and
the export says $11.

---

## 7. Duty — confirmed, and refined

`price_list_items.duty_class` and `legacy_product_prices.duty_rate` hold a single uninterpreted letter. **The
three Duty Rate columns are that letter's rate table, per range**, and the mapping is exact:

- letter `A` → `Duty Rate A (%)`, letter `B` → `B`, letter `C` → `C`, **blank letter → 0%**
- 19,201 of 19,201 rows reproduce `Price incl Duty` from `Price ex Duty` on that rule

Distribution across the 58 ranges:

| | 5% | 10% | 0% | blank |
|---|---|---|---|---|
| Duty Rate A | 54 | 1 | 1 | 2 |
| Duty Rate B | 44 | 2 | 1 | 11 |
| Duty Rate C | 45 | 1 | 1 | 11 |

**This confirms `d365-export-analysis.md` §2's finding and refines it three ways.**

1. **The flat 5% is real and it is the client's own parameter**, not an inference from output ratios. 54 of 58
   ranges say A = 5.
2. **The 7% placeholder in the CRM `/import` wizard is wrong and must go.** The value 7 appears nowhere in
   this file, in any band, on any range.
3. **There are exceptions, and they are per-range, not per-class.** `C & C Milano Bedding` is 10% on all three
   bands; `STOCK - INTERWEAVE` is 0% on all three (a domestic purchase); `HAMAM` is the only range whose
   bands differ from each other — A 5, **B 10**, C 5.

**A10 is closed for band A and open for B and C.** Every duty-classed row carries the letter `A` — 1,456 of
19,327 in `legacy_product_prices` and 1,454 of 19,514 in `price_list_items`, the rest blank. **Not one row in
either corpus carries `B` or `C`.** So the B and C rates are real parameters that
the priced catalogue has never exercised — we can store them, but nothing validates them and nobody should
assume the corpus proves them right.

---

## 8. The freight class letters — **still not decodable, and this is the gap**

This is the most important question in the analysis, so the answer is stated plainly first.

> **The Xero Range table does NOT give the freight letter → value mapping.** It carries exactly one
> `Freight` number per range. `price_list_items.freight_class` distinguishes five letters (`A` 11,879 ·
> `B` 5,571 · `C` 1,485 · `D` 578 · `E` 1 in the committed ledger). One number cannot decode five letters, and
> nothing in either workbook is keyed by a freight letter the way the three duty columns are keyed by a duty
> letter.

**But the letters are now *recoverable*, and they were not before today.** Because Clearance and the duty
bands are known, the freight term can be isolated from `Landed Cost` per row:

```
implied freight $ = Landed Cost ÷ (1 + Clearance/100) − Price incl Duty
```

Bucketed by (range × freight letter) over the 19,201 auto-mode rows, that quantity is **constant to the
cent — 19,197 of 19,201 rows agree with their bucket's value**. The letters are a real, live axis:
**25 of 43 ranges use more than one letter**, and the spread within a range is large (Fabricut's `A` is $30
while its `B` is $3 and its `C` is $5 — full-roll air freight versus a trimming).

Recovered table (value, with the row count behind it):

| Range | `Freight` in this table | A | B | C | D | blank |
|---|---|---|---|---|---|---|
| ALTAGAMMA | 35 | | 35 (447) | | | |
| ARMANI CASA WALL COVERING | 35 | | 35 (444) | | 50 (60) | |
| BRAQUENIE | 28 | 28 (156) | 40 (30) | 34 (36) | | |
| C & C MILANO | 58 | 58 (1510) | 40 (89) | 12 (78) | | |
| CLARENCE HOUSE | **23** | **30** (463) | 3 (34) | 5 (65) | | |
| COLEFAX & FOWLER | 30 | 30 (573) | 35 (90) | 13 (71) | 35 (1) | |
| DE LE CUONA | 50 | 50 (140) | | | | |
| FABRICUT | **23** | **30** (1510) | 3 (204) | 5 (262) | | |
| FADINI BORGHI | **28** | **30** (68) | | | | |
| FILIPPO UECHER | 52 | 52 (63) | | | | |
| FINE | 52 | 52 (461) | | | | |
| FOX LINTON | 52 | 52 (60) | | | | |
| GARRETT LEATHER | 10 | 10 (42) | | | | 10 (1) |
| HAMAM | **—** | **50** (143) | **17** (208) | **9** (195) | **5** (28) | |
| JANE CHURCHILL | 30 | 30 (314) | 35 (37) | | | |
| JANNELLI VOLPI | **30** | | **35** (2449) | | | |
| JEAN MONRO | 50 | 50 (1) | | | | |
| JIM THOMPSON | **28** | **29.5** (536) | 39 (85) | 13 (4) | 19 (39) | |
| JV DESIGN | **30** | | **35** (277) | | 50 (84) | |
| JV Fabric | 50 | 50 (67) | | | | |
| JWALL | **30** | | | | **50** (209) | |
| KIEFFER | 50 | 50 (97) | | | | |
| LARSEN | 30 | 30 (334) | 35 (21) | 13 (1) | | |
| LE CRIN | 55 | 55 (20) | | | | |
| LE MANACH | 28 | 28 (272) | 0 (14) | | | |
| LIBERTY | 51.5 | 51.5 (143) | 39 (31) | 17 (10) | 20 (1) | |
| LORO PIANA | 49 | 49 (192) | 35 (3) | 11.5 (19) | | 49 (1) |
| MADEAUX | 50 | 50 (97) | 40 (50) | | | |
| MANUEL CANOVAS | 30 | 30 (259) | 35 (33) | 13 (21) | | 30 (1) |
| MARIA FLORA | 52 | 52 (127) | | | | |
| METAPHORES | 49 | 49 (152) | | | | |
| MISSONI WALL COVERING | 38 | | 38 (159) | | 50 (164) | |
| PERENNIALS OUTDOOR FABRIC | 55 | 55 (141) | | 15 (4) | | |
| PIERRE FREY | **28** | **30** (935) | 35 (174) | 10 (433) | | |
| RUBELLI | 50 | 50 (460) | 36 (60) | | | |
| S HARRIS | 30 | 30 (646) | 3 (193) | 5 (61) | | |
| SETTE | 31 | 31 (2) | | | | |
| STOCK - INTERWEAVE | 2 | 2 (1) | | | | |
| STROHEIM | **23** | **30** (419) | 3 (183) | 5 (74) | 12 (3) | |
| TIMNEY FOWLER | **35** | | **31.5** (1) | | | |
| TREND | **20** | **30** (1115) | 3 (73) | 5 (131) | | |
| VEREL DE BELVAL | 49 | 49 (36) | | | | |
| VERVAIN | **23** | **30** (142) | 3 (27) | 5 (30) | | |

Read the bold rows: **the `Freight` column is not simply "the A rate".** It equals the range's A-class rate in
27 of the 35 ranges that have one, and equals *some* letter's rate in only **30 of 43 ranges**. `HAMAM`'s is
blank while its price rows imply four distinct rates. `JWALL` says 30 while all 209 of its rows imply 50.

Two readings are possible and they have opposite consequences:

- **`Freight` is the current default and the letters override it.** Then the letter table is a separate
  entity we have never seen, and this column is a fallback for an unclassed row.
- **`Freight` is what the office edits today and the price rows are stale snapshots.** Then the letter values
  above are historical and must not be used to reprice anything.

The single row of `E` in the corpus (a Hamam row) implies **$70** — an outlier consistent with neither
reading, and a class with one member cannot be generalised from at all.

**This must go to Derek before any freight rate is written anywhere.** Meanwhile the recovered table above is
evidence, and belongs in a note beside the ledger, never in it — the same posture `duty_percent` already takes
(`src/seed/CLAUDE.md`: "a placeholder written here would be indistinguishable from a rate a supplier quoted").

---

## 9. Trade markup, retail markup and discount

### Trade markup — populated on 57 of 58 ranges

14 distinct values, all whole percentages: 85 (18 ranges) · 70 (9) · 100 (8) · 75 (4) · 87 (4) · 65 (3) ·
88 (3) · 80 (2) · 89 (2) · 60 · 63 · 69 · 92 (1 each) · blank (1, `Miscellaneous`). Range 60–100.

Verified: `Trade Sell = Landed × (1 + markup/100)` on 19,161 of 19,199 rows. The clusters
`d365-export-analysis.md` §2 found by regression (1.85 / 1.70 / 1.75 / 1.69 / 1.89 / 1.65) are these numbers
read directly.

### The RETAIL markup is not in this table, and it is not a constant

`Retail ÷ Trade` over the corpus: **1.30 on 17,692 rows**, but 1.40 (696), 1.50 (349), 1.80 (361), 1.35 (125),
1.23 (7). Thirteen ranges have a modal ratio other than 1.30:

| Ratio | Ranges |
|---|---|
| 1.35 | MARIA FLORA |
| 1.40 | DE LE CUONA, LARSEN, LE CRIN, LIBERTY |
| 1.50 | GARRETT LEATHER, JEAN MONRO, JWALL, KIEFFER |
| 1.80 | JV DESIGN |
| other | SETTE (3.40), STOCK - INTERWEAVE (2.30), KVADRAT MAHARAM (1.23 — no Xero row) |

So **a second, per-range retail markup exists and this delivery does not contain it.** It is derivable from
the corpus the same way the freight letters are, and it carries the same staleness caveat.

### Discount — populated on 40 of 58 ranges, and blank means zero

`0` on 29 rows, blank on 18, and 20 (3) · 25 (3) · 10 (2) · 30 · 35 · 50 (1 each).

Verified exactly on all 14,521 rows where the column is populated. **And on all 4,638 rows belonging to a
blank-discount range, `Export Price ÷ Wholesale Rate` is 1.000** — so a blank reads as zero, not as unknown.
Every one of the six discrete ratios `d365-export-analysis.md` §2 found is a `Discount (%)` value here.

**This is a single resolved rate per range, not a chain.** It does not contradict `supplier_brand_terms`'
multiplicative rule — JV Fabrics' "40% then 40%" nets to ×0.36, and this table would carry it as one number
if D365 held it at all — but it means **the D365 side cannot be a source for `discount_chain`.** A chain
imported from here would be a one-element array, which is a different claim from "we do not know the chain".

### Against `supplier_brand_terms`

In the dev database `supplier_brand_terms` holds **0 rows** (`supplier_aliases` 0, `brands.supplier_id` NULL
on all 41) — `npm run backfill:suppliers` has not been run here, so the "6 Fabricut rows" the plan notes
describes a database this analysis could not measure. Either way:

- the table's markup is **per range**, i.e. per house, which is exactly `supplier_brand_terms`' `(supplier,
  brand)` grain — it fits;
- 57 markups are available where 6 (or 0) exist today;
- but only **33 of 58 range names resolve to a `brands` row** (§10), so **25 markups have nowhere to land**
  until the naming decisions in `src/seed/CLAUDE.md`'s "houses the office owes a name" list are made.

`supplier_brand_terms.markup` is `numeric(6,4)` with `CHECK (markup IS NULL OR markup > 0)`. Decide before
importing whether it stores `0.85` or `1.85` — this table says **85**, and both readings pass the CHECK.

---

## 10. Join keys — measured, never guessed

Following `src/suppliers/backfill-plan.js`: exact `lower(btrim(…))` on name, or the slug, or an alias. No
fuzzy matching. Everything that does not match is listed.

### `Supplier` → live `suppliers`: **8 of 28 (28.6%)**

| Route | Matches |
|---|---|
| `suppliers.name` exact | 6 — Colefax & Fowler, Jean Monro, Loro Piana, METAPHORES, Madeaux, de Le Cuona |
| `suppliers.slug` only | 2 — `C & C Milano`→C&C Milano, `Jannelli & Volpi`→Jannelli Volpi |
| `supplier_aliases` | **0** — the table is empty |
| `suppliers.short_code` | **0** — NULL on all 40 rows |
| `suppliers.d365_token` | **0** — NULL on all 40 rows |

The 20 with no live supplier: `Alpaka` · `Brochier` · `FINE TEXTILVERLAG GmbH` · `Fabricut Inc` ·
`Garrett Leather Corp` · `Inter-Weave Ltd` · `Jim Thompson / The Thai Silk Co. Ltd.` · `Libeco-Lagae` ·
`Liberty London` · `Link Outdoor` · `Mariaflora And Filippo Uecher` · `Perennials Outdoor Fabrics` ·
`Pierre Frey Paris` · `Rubelli / Dominique Kieffer` · `SETTE E & D, S.L` · `Solbiati` · `Stoker Mills` ·
`The Vale London` · `Timney Fowler Ltd` · `VERİTAS TEKSTİL KONFEKSİYON PAZARLAMA SAN. VE TİC. A.Ş.`

Most of these are visibly the legal-entity form of a house we do hold (`Fabricut Inc` / Fabricut,
`Pierre Frey Paris` / Pierre Frey, `Liberty London` / Liberty). **They are corrections to make in the CRM, one
alias at a time, not a fuzzy rule to write** — the backfill's own doctrine.

### `Supplier` → `legacy_accounts.name`: **3 of 28**

Only `Garrett Leather Corp`, `Jim Thompson / The Thai Silk Co. Ltd.` and `Rubelli / Dominique Kieffer` match
an account by name — and all three are flagged `is_supplier = true`, which is encouraging but is 3 of the 21
supplier accounts in that file. **`fulmxero_supplierid` is a lookup rendered as a display name, so it suffers
exactly the trap `d365-export-analysis.md` §3a records for `product_price_list`.** A re-export carrying the
account's `atelier_accountnumber` or GUID would make this a real key; today it is a label.

### `Name` → the three range corpora: **excellent**

| Target | Range rows matched | Corpus rows covered |
|---|---|---|
| `legacy_product_prices.range_name` | **48 of 58** | **19,256 of 19,327 (99.6%)** |
| `price_list_items.product_range` | **40 of 58** | **19,450 of 19,514 (99.7%)** |
| `legacy_stock_items.range_name` | **54 of 58** | **7,271 of 7,611 (95.5%)** |

`Name` is the join key. It matches on the raw string, case-insensitively, with no normalisation beyond
whitespace collapsing.

Reverse gaps — corpus values with **no** Xero Range row:

- `legacy_product_prices`: 2 values, 71 rows — **BOUSSAC (64)**, KVADRAT MAHARAM (7)
- `price_list_items`: 1 value, 64 rows — **BOUSSAC**
- `legacy_stock_items`: 23 values, 340 items — blank (89), DANIELA DALLAVALE (53), BOUSSAC (43),
  LINIE DESIGN A/S (40), SAHCO HESSLEIN (40), JOHN ENGLAND TEXTILES LTD (13), EVELYN KAHLE (11), STUDIO B (11),
  ARMANI CASA (10), GIEN (5), DONGHIA (5), CASADECO (4), MONTIGNY (3), and ten more with 1–2 each

**BOUSSAC is the one that matters**: 64 priced rows in the committed ledger and 43 stock items, and no
parameter row at all. Either the range was retired in D365 without retiring its prices, or the export view
excluded it. Ask.

### `Name` → `brands`: **33 of 58 (56.9%)**

28 exact on `brands.name`, 5 more on the slug (`BRAQUENIE`→Braquenié, `KIEFFER`→Dominique Kieffer by Rubelli,
`LORO PIANA`→Loro Piana Interiors, `METAPHORES`→Métaphores, `S HARRIS`→S. Harris).

The 25 with no brand row: `ALTAGAMMA` · `ARMANI CASA WALL COVERING` · `ATELIER MISC` · `ATELIER STOCK` ·
`C & C Milano Bedding` · `FOX LINTON` · `JANNELLI VOLPI` · `JV DESIGN` · `JV Fabric` · `JWALL` · `LE MANACH` ·
`LIBECO` · `LIBERTY` · `LINK OUTDOOR` · `Miscellaneous` · `MISSONI WALL COVERING` · `NICKY HASLAM` · `NO 9` ·
`PERENNIALS OUTDOOR FABRIC` · `RAMM, SON & CROCKER` · `RUBELLI` · `SIRPI WALLCOVERING` · `SOLBIATI` ·
`STOCK - INTERWEAVE` · `STOKER MILLS`

Several are the same house under a longer spelling (`LIBERTY`/Liberty London, `RUBELLI`/Rubelli Venezia,
`NO 9`/No.9 Thompson, `MISSONI WALL COVERING`/Missoni Home, `ARMANI CASA WALL COVERING`/Armani Casa) and are
naming decisions, not absences. The rest overlap almost exactly with the fifteen unresolved house spellings
`src/seed/CLAUDE.md` already lists for `import:colour`. **The same decision unblocks both.**

---

## 11. Coverage — who gets a rate and who gets nothing

Against the live catalogue (41 brands, 40 suppliers, 19,514 price-list rows):

- **33 of 41 brands** resolve to a Xero Range row by name or slug. The 8 that do not: Armani Casa, Atelier
  Textiles NZ, Boussac, Liberty London, Missoni Home, No.9 Thompson, Rubelli Venezia, Sahco. Five are longer
  spellings of a row that exists; **Atelier Textiles NZ (the house brand, correctly absent), Boussac and Sahco
  genuinely have no parameters**.
- **32 of 40 suppliers** do not appear in the `Supplier` column — because the column names the invoicing
  entity and our table mostly holds houses. Reading both columns, only **Boussac** has nothing anywhere.
- **18 of the 58 Range rows have no row in the committed `price_list_items`** — ALPAKA, ATELIER MISC, ATELIER
  STOCK, BROCHIER, C & C Milano Bedding, GARRETT LEATHER, LIBECO, LINK OUTDOOR, Miscellaneous, NO 9,
  RAMM SON & CROCKER, SETTE, SIRPI WALLCOVERING, SOLBIATI, STOCK - INTERWEAVE, STOKER MILLS, THE VALE LONDON,
  TIMNEY FOWLER. Most do have D365 stock items, so they are ranges Atelier trades but has never given us a
  price-list drop for.
- **2 of the 58 have nothing anywhere** — `Miscellaneous` (dead since 2020) and `NO 9`.

**A supplier with no row here still has no freight rate.** That is Boussac, and it is one row for someone to
add in D365 — not a modelling problem.

---

## 12. The 5-metre surcharge — defined at BOTH grains, and they disagree

| Where | Rows carrying a min qty | Values |
|---|---|---|
| **Xero Range** (this file) | **6 of 58** | Min Qty 5 on all six; Surcharge $20 on five, **$25 on TIMNEY FOWLER** |
| `legacy_stock_items` | **992 of 7,611** | 987 at qty 5, 5 at qty 3, spread over **23 ranges** |

The six ranges with a range-level rule: BROCHIER · LINK OUTDOOR · RAMM, SON & CROCKER · SETTE ·
THE VALE LONDON · TIMNEY FOWLER.

**935 of the 992 stock items carrying a min qty belong to a range that has none in this table** — De Le Cuona
(227), Loro Piana (117), Rubelli (114), Maria Flora (84), Fine (77), C & C Milano (64), Liberty (57) and
eleven more. The 57 that do belong to one of the six are Brochier (34), Link Outdoor (10), Sette (7), Timney
Fowler (5) and The Vale London (1). So the range parameter is **not** the source of the item setting, and
cannot be treated as a default that items inherit.

The dollar amounts disagree too. `Trade Price with Surcharge − Trade Price` on the 4,240 stock items carrying
both: **$0.00 on 3,224** · **$12.00 on 661** · **$20.00 on 246** · $15.00 on 28 · $10.00 on 12 · and
**~50 items where the surcharge price is LOWER than the trade price** (−$23.00 on 11, −$16.00 on 10,
−$21.75 on 7 …). The $12 tier is the most common and appears nowhere in this table.

On the price-list side the effect is nearly invisible, as §3 of the earlier analysis found: `under-5m` differs
from `over-5m` on 4 of 19,327 rows, and only SETTE's two rows match its range parameter ($20). TIMNEY FOWLER's
single row implies **$15** where the range says **$25**.

**Reading: the surcharge is an item-level operational setting that the range-level columns were added to
generalise, and the generalisation was never finished.** It remains new scope with no spec, now with a second
half-built implementation attached. Do not build either half without asking Liz which one is the intent.

---

## 13. Status and freshness

**`statecode` is `Active` on all 58 Range rows and all 17 Type rows.** No inactive row appears — but the
visible worksheet is named **"Active Tracking Options"**, so the view is pre-filtered exactly as the July
Product Prices export was. **This file cannot tell us whether inactive tracking options exist**, and it would
be wrong to conclude none do. If retired ranges matter (they would explain BOUSSAC), the view needs its filter
removed and a re-export.

`Modified On`:

| Xero Range | | Xero Type | |
|---|---|---|---|
| 2026-03 | 1 | 2023-11 | 1 |
| 2026-02 | 15 | 2020-05 | 2 |
| 2026-01 | 8 | 2020-04 | 1 |
| 2025-09 | 17 | 2019-11-25 | **13** |
| 2025-08 | 1 | | |
| 2025-01 | 3 | | |
| 2024-12 | 12 | | |
| 2020-08 | 1 (`Miscellaneous`) | | |

**Range is maintained. Type is abandoned.** 57 of 58 Range rows were touched in the last twenty months, in
visible campaigns — a December-2024 sweep of the Pierre Frey houses, a September-2025 sweep of about
seventeen, a January/February-2026 sweep of the Fabricut and Métaphores houses. The newest is DE LE CUONA on
2026-03-22, four and a half months before the export.

Type's 13 oldest rows all share the timestamp **2019-11-25**, which is the D365 go-live: created once, never
revisited except to add Candles and Leather in 2020 and Cushions in 2023. Consistent with it holding no
parameters — nobody has needed to change a number that does not exist.

---

## What this unblocks

- **A10 — the broker's duty table, for band A.** 54 of 58 ranges are 5%, with `C & C Milano Bedding` at 10%
  and `STOCK - INTERWEAVE` at 0%. It reproduces the export's own duty step on 19,201 of 19,201 rows. Bands B
  and C exist and are unexercised. **The CRM `/import` wizard's 7% placeholder is now provably wrong and
  should be deleted** rather than corrected to 5 — `price_list_items.duty_percent` stays NULL until a real
  file carries a real number, and this file is a *parameter* source, not a file.
- **The clearance fee.** 10% on 56 of 58 ranges, 0% on the one domestic supplier, applied to duty-paid value
  plus freight. It has no column anywhere in our schema today.
- **The trade markup.** 57 values, 60–100%, verified to 99.8%. Enough to populate `supplier_brand_terms.markup`
  for every house whose name resolves (33 of 58), against the 0 rows the dev database holds now.
- **The freight *magnitude*, and the end of the percentage argument.** Freight is dollars per unit. The demo's
  8% is right on 3.3% of rows. Whatever we build, it takes a dollar figure.
- **The freight letter → value mapping — recoverable, not delivered.** With Clearance and duty known, the
  per-(range × letter) dollar rate falls out of the price corpus at 100.0% agreement. §8's table is the
  recovered mapping; it needs Derek's confirmation before it is authoritative.
- **A13's supplier → brand roll-up, stated rather than inferred.** 28 invoicing entities over 55 houses, from
  the client's own data, superseding the 62-token empirical roll-up.
- **`Name` as the join key** into all three range corpora at 95–99.7% row coverage — the first key in this
  programme that works out of the box.
- **The `Type` question is closed.** There are no type-level rates. Stop asking.

## What is still owed

1. **The freight class letter table, from the client, per range.** §8 recovers it by regression but cannot say
   whether the letters override the `Freight` column or whether the corpus values are stale snapshots. The two
   readings give different numbers on 13 of 43 ranges. **This is the single blocking question.** Also: what do
   `A`–`E` *mean* (air/sea? roll/cut/sample?), and what is `E`, which has exactly one member implying $70.
2. **The retail markup, per range.** Not in this file. `Retail ÷ Trade` is 1.30 on 92% of rows but 1.35, 1.40,
   1.50 or 1.80 on thirteen ranges.
3. **A decision on the 5m surcharge** — range-level (6 ranges, $20/$25) or item-level (992 items, $12/$20/$15/$10,
   ~50 of them negative). Both exist; neither is specified; they disagree.
4. **BOUSSAC.** 64 priced rows, 43 stock items, no parameter row. Retired, or excluded by the view?
5. **An unfiltered re-export**, if retired ranges matter. The view is "Active Tracking Options".
6. **A supplier key.** `fulmxero_supplierid` exports as a display name and matches `legacy_accounts.name` on 3
   of 28. Adding the account's `atelier_accountnumber` to this view is the same one-column ask as the Stock
   Items re-export in `d365-export-analysis.md` §6 item 1.
7. **Names for the 25 ranges with no `brands` row** — the same list `import:colour` is already blocked on.
8. **Duty bands B and C.** Real parameters, zero rows in the corpus. Confirm with Charlotte that they are live
   rather than vestigial before storing them as if they mattered.
9. **`supplier_brand_terms.markup` units.** 85 here; the column is `numeric(6,4)` with `> 0`. Both `0.85` and
   `1.85` pass the CHECK and one of them is wrong by a factor of two.

## Traps

Each of these would silently produce a wrong number.

1. **`Clearance` is a PERCENTAGE and its label does not say so.** Every other percentage column in this view
   is suffixed `(%)`; this one is bare. Read as dollars it turns a $10 clearance into a $1 error per unit on
   a cheap fabric and a $50 error on an expensive one, in the same direction as the real fee, so it looks
   plausible everywhere. It multiplies **(duty-paid value + freight)**, not the goods alone.
2. **`Freight` is per UNIT, and the unit is the range's pack type, not the metre.** ALTAGAMMA's $35 is per
   ROLL (all 447 of its rows are `P/Roll`); Garrett Leather's $10 is per HIDE; the priced corpus is
   P/M 8,574 · P/Y 5,753 · P/Roll 2,816 · P/P 2,011. Applying a per-roll freight to a per-metre quantity
   overcharges by roughly the roll length.
3. **The `Freight` column is NOT the freight the price rows were built with.** It equals some letter's implied
   rate in only 30 of 43 ranges, and is blank for HAMAM, whose rows imply four different rates. A repricing
   run that reads this column will move prices on thirteen ranges — including all six Fabricut houses and
   Pierre Frey — without anyone having asked for a price change.
4. **Blank means ZERO for `Discount`, and blank means ZERO for the duty letter — but blank means UNKNOWN for
   `Freight`.** All 4,638 rows in a blank-discount range show a 1.000 export/wholesale ratio, and all 17,749
   blank-duty-letter rows show a 1.000 duty ratio, so both blanks are real zeros. HAMAM's blank Freight is
   not: its rows imply $50/$17/$9/$5 by letter. Do not write one COALESCE for all of them.
5. **The Range/Type split is not a category split — `Type` carries no parameters at all.** Any importer that
   loops "for each tracking option, read its rates" will silently write 17 rows of nulls over whatever the
   Range rows produced, or produce a Type-keyed rate table of zeros that reads as "duty free".
6. **`Name` is the join key; `Supplier` is a display name.** Joining on `Supplier` matches 8 of 28 live
   suppliers and 3 of 28 legacy accounts. Joining on `Name` covers 99.6% of the priced corpus. Using the wrong
   one silently drops five of the six Fabricut houses and all eight Jannelli & Volpi ranges.
7. **`statecode = Active` on every row proves nothing** — the view is pre-filtered to active options, exactly
   as the July "Active Product Prices" pull was. A range that is missing (BOUSSAC) may be inactive rather than
   absent.
8. **No `sharedStrings.xml`.** Text cells are inline, so a reader that only walks `<v>` elements returns the
   numbers and drops Tracking Category, Name and Supplier — a table of rates with nothing to key them on,
   which does not look like a parser fault. Use `scripts/lib/xlsx.js`.
9. **The duty letter is on the PRICE ROW and the rate is on the RANGE.** Both are needed; neither is
   sufficient. A row with letter `A` in a range where `Duty Rate A` is blank has no defined duty — and blank A
   occurs on two of the 58 rows.
10. **`Trade Markup` is stated as 85, not 0.85 and not 1.85.** Three plausible readings, two of which produce
    a sell price that looks like a real number.

---

## Reproducing this analysis

Dependency-free, using the machinery already in the repo. Read the schema map from
`xl/worksheets/sheet.xml` and the grid from `xl/worksheets/sheet2.xml`, exactly as `readSchemaMap` /
`SCHEMA_SHEET` / `DATA_SHEET` in [`scripts/convert-d365-exports.js`](../scripts/convert-d365-exports.js) do,
through [`scripts/lib/xlsx.js`](../scripts/lib/xlsx.js) (`openWorkbook`, `sharedStrings`, `sheetRows`,
`excelTimestamp`). Columns are addressed by **D365 logical name**, never by position. The cross-references run
against the local `atelier_dev` database: `legacy_product_prices` (19,327), `legacy_stock_items` (7,611),
`legacy_accounts` (866), `price_list_items` (19,514), `suppliers` (40), `brands` (41).

The waterfall verification isolates each step against the export's own stored output, on unrounded
intermediates (`Export Price ÷ Price Exchange Rate`, not the rounded `Price ex Duty $NZ`) — rounding at each
step instead costs about 60% of the exact matches on the landed-cost step and looks like a broken formula.

Neither workbook is registered in `ENTITIES` and neither has been imported. `fulmxero_trackingoption` would
be a twelfth `legacy_*` table, which — per `src/legacy/CLAUDE.md` — turns three green suites red on the
migration alone until their table-count assertions are updated in the same commit.
