# W8 — Colour files

Import the 18 supplier colour spreadsheets into the colourway catalogue, with the 2026 rates they
carry as a secondary output in the universal pricing-template shape.

Epic: `_bmad-output/planning-artifacts/epics.md` — **Epic 8** (`aug6/w8-colour-files`, api only,
6 stories). Architecture: `_bmad-output/planning-artifacts/architecture.md` § "Colour files".
Requires E10 Pricing template (merged) — the rate output is emitted in its template shape.

## Stories

| # | Story | Commit | What it added |
|---|---|---|---|
| US-001 | Adapter registry and the row-extraction harness | `260f5f1` | `scripts/lib/colour-sheet.js`, `scripts/lib/colour-adapters/index.js`, `scripts/convert-colour-files.js`, `npm run convert:colour` |
| US-002 | Adapters for the single-sheet, single-brand files | `f9c6480` | `records.js` + six adapters over five files (Jean Monro, Madeaux, Liberty, Maria Flora, Perennials ×2) |
| US-003 | Adapters for the multi-sheet and multi-brand files | `0c58500` | the remaining twelve drops — Colefax, Jannelli & Volpi, Pierre Frey, Jim Thompson ×2, the five Fabricut houses, C&C Milano, and the de Le Cuona PDF's declared refusal |
| US-004 | Normalised output, loud failure, per-file summary | `02b21fd` | `reading.js`, `output.js`, `skip(reason)`, the per-file abort and the written `colourways.json` |
| US-005 | Rates as a secondary output | `0a7b474` | `rate-template.js`, `rates.js`, rate declarations in all twelve adapters, the written `rates.csv` |
| US-006 | Import colourways into products and colourways | `0cf1de6` | `src/seed/colourways-import.js`, `src/seed/import-colourways.js`, `npm run import:colour` |

All six commits are in `atelier-api` only; no story in this epic touched the CRM or the storefront.

## Gates

`( cd atelier-api && npm run lint && npm test )` → **both 0** at `0cf1de6`:
41 test files, **863 tests**, of which **114** are `test/colour-files.test.js` (22 → 39 → 59 → 72
→ 98 → 114 across the six stories). No typecheck exists in this repo and none was added.

No migration, no route and no CRM file was touched. `incoming/` was read and never written.

## What the pipeline does end to end

```
incoming/colour-files/*.xlsx                     18 drops, 18 layouts
  └─ npm run convert:colour
       ├─ incoming/colour-files/normalized/colourways.json   45,923 rows
       └─ incoming/colour-files/normalized/rates.csv         15,611 rates, v2 template shape
            └─ npm run convert:pricing → npm run import:pricing   (the office's existing path)
  └─ npm run import:colour
       └─ products + colourways + inventory                  38,064 colourways, 8,438 products
```

**Whole-corpus numbers, all measured rather than asserted:**

- **Reading:** 18 files — 17 read, 1 declared refusal (the de Le Cuona PDF). 48,384 rows in →
  **47,082 colourways**, 1,604 skipped by stated reason, 1,159 exact repeats dropped, **45,923
  written**.
- **Rates:** 47,608 priced rows in → **15,611 rates out**, 1,822 skipped, 230 codes priced two ways
  and therefore given no rate. **14,914 of the 15,611 land on a row the office's own
  `price-lists.json` already holds** under the same supplier, category and code; 10,634 of those
  match to the cent.
- **Import:** 45,923 rows in = **38,064 colourways + 7,824 skipped + 28 repeats + 7 conflicts**,
  across **8,438 products and 22 houses**. 15 brand spellings covering 7,823 rows have no
  catalogue row and import nothing.

## Needs human verification

No screen and no route is touched by any story in this epic, and there is no e2e harness in this
repo. What a person must look at or decide, aggregated across the six stories:

**Before the first production import — decisions only a person can make**

1. **The 15 houses with no catalogue row** (7,823 colourways) import nothing until they exist:
   Jannelli & Volpi's six (`JANNELLI&VOLPI`, `ALTAGAMMA`/`ALTAGAMMA MODERN LIVING`, `DESIGN
   LICENCE`/`DESIGN LICENSE`, `JWALL`, `CO.DE`, `JV FABRICS`), `C & C Milano`, `Perennials`,
   `Le Manach`, `FOX LINTON`, `Nicky Haslam`, `BILL BENSLEY X JIM THOMPSON`, and `RSC`. Two of them
   are spelt two ways inside one file — choosing between the spellings is naming a house. A house
   must be created in the CRM; no converter or importer here will ever create one.
2. **What house is Jean Monro's `RSC` sheet?** 87 colourways (BERNARDO PAISLEY, OTTOLINE, KANPUR,
   THE HARE) are filed under the raw token because nothing in the repo names it.
3. **The colourway SKU shape is US-006's decision and becomes the catalogue's.**
   `COLEFAX-FOWLER-BOWOOD-01020-01` is what an order line will quote. If the office wants the D365
   shape (`{colour code} {YY}{SUPPLIER_TOKEN}`) or the CRM generator's (`CF-SWT-01`), changing it
   later means re-keying every imported colourway.
4. **Jannelli & Volpi's rates must not be imported as they stand.** The drop's DEALER PRICE is
   exactly **twice** the office's own figure for five of its six houses (3,939 rows at a ratio of
   2.000; Missoni's 323 match to the cent). CO.DE and JV Fabrics quote a **public** price with no
   dealer column at all (285 rows). Ask the supplier before those rows go anywhere.
5. **43 rows would change a unit the office already recorded** (Colefax 12, Liberty 11, Manuel
   Canovas 6, Pierre Frey 5, Larsen 4, Vervain 4, S Harris 1) — the ledger's minority cases, a
   wallpaper by the metre or a trimming by the piece, which these files give no way to tell apart.
6. **Madeaux's 13 grasscloth wallpapers state two rates in one cell** ("£35/m" and "£350/roll"), so
   none is written. Which one does Atelier buy at?
7. **The seven colour codes carrying two names** — six Madeaux section reprints ("Blue Grass"/
   "Bluegrass", "Duck Egg On Ecru"/"Duck Egg", "Rose On Ecru"/"Rose", "Red Earth"/"Clay", "Jewel
   Tones"/"Moonstone", "Taupe & Teal"/"Taupe and Teal") and Maria Flora's Filigrana 102
   ("Lino"/"Linen"). The converter keeps both rows; the importer keeps the first and reports both.
   Somebody has to say which name the catalogue carries.
8. **The de Le Cuona PDF** is refused by declaration — somebody must ask the supplier for the
   spreadsheet it was printed from. 139 of its rows are already in the price list.

**Data a person should eyeball against the supplier's own list**

9. **Jannelli & Volpi's 4,917 colourways have no colour names** — the file genuinely names none
   (6570 and 6571 are both "RIBBON GRASS"), so those records carry the item code as the catalogue
   name. Confirm the office is content to hold them by code, or ask JV for the colour list.
10. **Pierre Frey's 318 abbreviated SKU names** keep the whole name as the colour ("GR CORAIL RAY
    2CH BLEU BL 4" for "LE GRAND CORAIL - Rayure 2 chemins"). Eyeball a dozen.
11. **Nicky Haslam's design names are derived from the item code** ("AFTERALLTOO",
    "ODBALCONY-STRIPE") because that sheet has no design column; the price list spells the same
    design "AFTER ALL TOO".
12. **Maria Flora's colour code is the colour's alone** ("11"), with the pattern number kept
    separately as `design_code` ("60656") because the supplier never wrote a separator. Confirm
    that is the SKU shape the office wants.
13. **1,159 exact duplicates dropped** at conversion (Liberty's overlapping sheets, Jim Thompson's
    spring subset, Maria Flora's 73 reprints) — expected, but worth one check against the totals.

**Runs this loop deliberately never performed**

14. **`npm run convert:colour` has never been run to its DEFAULT output path**, so
    `incoming/colour-files/normalized/` does not exist yet — every corpus run in this branch wrote
    to a scratch path, leaving `incoming/` exactly as the client left it. Running it once by hand
    is what creates that directory, and `npm run import:colour` needs it.
15. **The real corpus has never been written to a database.** Creating a scratch database is not
    permitted in the loop's sandbox and `atelier_w8` is the test suite's own database, so the
    38,064-row import would falsify other suites' counts. The database path is covered by
    integration tests with prefixed fixtures; the whole-corpus figure above is the pure plan. Run
    `npm run import:colour` against a seeded database and check the CRM's Products screen — all
    8,438 products arrive with `show_on_website = false`, so nothing reaches the public storefront
    until somebody publishes it.
16. **`rates.csv` is NOT dropped into `incoming/pricing-templates/` by anything here.** Copying it
    there and running `npm run convert:pricing` regenerates the committed
    `src/seed/data/price-lists.json` — an 8 MB diff, and the office's decision to make.
