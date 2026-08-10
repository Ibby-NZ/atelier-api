# W10 — Pricing template (`aug6/w10-pricing-template`)

One universal pricing template for every supplier going forward. **v2 is a strict superset of the
existing 14 columns, in the same order, with `Supplier`, `Brand`, `Pattern Match` and
`Duty Percent` appended** — that is what lets it be universal without breaking a single existing
drop. **The header row is the version**: no version column, no preamble line, no marker cell, so a
v1 drop keeps importing forever and adding v3 is one registry entry.

Epic: [`_bmad-output/planning-artifacts/epics.md` → Epic 10](../../_bmad-output/planning-artifacts/epics.md#epic-10--pricing-template-aug6w10-pricing-template--api-only--6-stories) ·
Architecture: [`architecture.md` → "Pricing template"](../../_bmad-output/planning-artifacts/architecture.md)

**api only.** No CRM or storefront change. `src/seed/data/price-lists.json` is **untouched** by
every commit below — a data refresh is a separate commit touching only that file.

## Stories

| # | Story | Commit (atelier-api) |
|---|---|---|
| US-001 | Migration: `price_list_items` v2 columns | `34a4189` |
| US-002 | Template registry with v1 moved verbatim | `0ebd18c` |
| US-003 | v2 mapping and the omit-on-v1 rule | `d38516a` |
| US-004 | Importer accepts the v2 fields | `5d60b9c` |
| US-005 | Shared vocabulary module | `e7b89d4` |
| US-006 | Byte-pin unit test and regeneration tripwire | this commit |

(`b5512d2` and `a2d21d5` on this branch are a Ralph permission fix, not part of the epic.)

## What changed

- **Schema** (`migrations/1786334400000_price-list-template-v2.js`): `brand_name text`,
  `pattern_match text`, `duty_percent numeric(6,3)`, `template_version text NOT NULL DEFAULT 'v1'`.
  `brand_name` is deliberately **not** an FK to `brands` — supplier spelling does not reliably match
  the 41 houses and an FK would fail a whole 2,000-row import over one naming difference.
  `freight_class`'s CHECK widens from `IN ('A'..'E')` to `~ '^[A-Z]$'` and `duty_class` gains the
  same; the old sets encoded a guess about a broker table nobody has, so the first `F` from a
  supplier would have rejected the client's own file as if it were a bug in ours. **No placeholder
  duty or freight value is written anywhere** — the letters stay raw and uninterpreted and
  `duty_percent` stays NULL until a real file carries a real number.
- **Registry** (`scripts/lib/price-template.js`): `TEMPLATES` is a frozen
  `{ version, header, map }` array; `matchTemplate` matches **exactly on length and labels**, so a
  v2 file can never be read as a v1 one by its first fourteen columns. `mapV1` is the converter's
  original `normaliseRow` **moved**, not rewritten. A mismatch produces the same loud
  `file:line: unexpected header [...]` error, now listing every accepted header.
- **v2 mapping**: `mapV2` delegates the shared fourteen cells to `mapV1` and appends its own keys.
  The **Supplier cell wins over the filename** (the pipeline's most fragile input — a rename
  silently renamed a supplier); the filename is now a fallback. **v2-only keys are omitted entirely
  on v1 rows, never written as null**, with the reason commented at the emit site.
- **Importer** (`src/seed/price-lists.js`): validates the four new fields by type before any SQL and
  writes them through a **named** `unnest` rowset so `template_version` can be
  `COALESCE(b."template_version", 'v1')` — a missing key binds an explicit NULL, which defeats the
  column DEFAULT. Upsert key unchanged at `(supplier, category, code)`.
- **Vocabularies**: the five hand-copied lists (item type, pack type, currency, freight class, duty
  class) now live once in `price-template.js`, imported by the converter, the importer and
  `src/routes/admin-price-lists.js`. STORED sets are kept apart from INPUT maps and
  `assertStorable` proves at module load that no alias reaches outside its stored set. `p/hide` and
  `p/panel` accepted (both already in the column CHECK); ISO codes accepted as **input aliases
  only** — the stored currency set is not widened.
- **Byte pin + tripwire**: `test/price-template.test.js` pins `dumps(mapV1(row))` to a hardcoded
  string that is line 2 of the committed JSON verbatim, plus a whole-rate/float-noise case and a v2
  pin; `test/price-lists.test.js` asserts the committed file's first record carries none of the four
  v2 keys and keeps `mapV1`'s key order.

## Gates

All run in `atelier-api/` against the workstream database `atelier_w10`:

| Gate | Result |
|---|---|
| `npm run lint` | 0 |
| `npm test` | 0 — 37 files, **640 tests** passed (560 at the start of the epic) |
| `npm run migrate` twice (US-001) | 0; second run "No migrations to run!", programmatic runner returns `[]` |

Additional evidence gathered per story, all writing to scratch paths only and never to a committed
file: converter runs against hand-made v1 and v2 fixtures; a v1 fixture reproducing the committed
file's first record compared **byte-for-byte** in Node against line 2 of `price-lists.json`
(`identical bytes: true`); converter output fed straight into `validatePriceListItems`; and an audit
of all 19,514 committed records confirming no row uses any newly added vocabulary
(units `metre,piece,roll,yard`; currencies `EUR,GBP,USD`; freight `A`–`E`; duty `A`/null).

## Needs human verification

1. **`npm run convert:pricing && git diff --exit-code src/seed/data/price-lists.json` in the main
   checkout.** `incoming/` is gitignored, so `incoming/pricing-templates/` exists only there and
   this gate cannot run from a worktree at all. It proves both the byte-identity of the v1 path and
   that no real drop's header row or filename has stopped parsing under the now-exact header match.
   *This is the one blocking pre-merge check.*
2. **The CRM's back-office Supplier rates screen** (`atelier-crm`, `src/screens/Admin*`). Its
   duty-class field now accepts a **single uppercase letter** where the API previously took any text
   up to 200 characters, and the freight-class control must offer the full alphabet rather than a
   hard-coded `A`–`E` list. Nothing else renders these vocabularies, and the API change turns what
   would have been an opaque 23514 into a 400.
3. `test/admin-price-lists.test.js` is outside this workstream's file list, so the route's tightened
   `duty_class` has no direct route-level test — covered indirectly via the shared pattern. Unlock
   that file if a story ever needs to assert the 400 directly.

Nothing else needs eyeballing: every other change is a CLI (converter, importer) or schema, and no
screen renders the new columns yet. There is no e2e harness in any repo.

## Open product decisions deliberately NOT made here

- **The broker's duty table (A10) and a freight class → rate table are still owed.** Until they
  arrive the letters stay raw and `duty_percent` carries no range CHECK — a guessed range is the
  same class of mistake the old `A`–`E` freight set already was. Consequence to know: a
  `duty_percent` ≥ 1000 passes the converter and overflows `numeric(6,3)` at import, loudly.
- **A later v1 file for a key already imported from a v2 one clears that row's v2 fields** and sets
  `template_version` back to `v1`, because the upsert sets every non-key column to `EXCLUDED`.
  That is this table's freshest-wins contract applied uniformly. Giving just these four columns a
  quieter `COALESCE` rule is a product decision, not a tidy-up.
- **`Pattern Match` is a new column, not a migration of the pattern text currently embedded in
  `vertical_repeat`.** Backfilling it needs the definitive field list still owed from Charlotte.
