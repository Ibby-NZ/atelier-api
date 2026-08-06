# W6 — Category export

A spreadsheet round trip that lets the office assign `products.category`, and the CSV reader
generalised out of the pricing pipeline so there is one encoding sniff in the platform rather than
two.

Epic: [`_bmad-output/planning-artifacts/epics.md` — Epic 6](../../_bmad-output/planning-artifacts/epics.md)
Branch: `aug6/w6-category-export` (both repos) · Requires E3 merged (`products.category`)

`products.category` (`fabric | wallpaper | trimming | accessory`) is the axis on which the catalogue
and the supplier rate ledger become joinable. It is nullable with no default, so every design
predates it and somebody has to look at each one — the office, not a developer. Hence a sheet.

## Stories

| # | Story | Repos | Commit |
|---|---|---|---|
| US-001 | Extract the encoding-sniffing CSV reader | api | `7f21b8b` |
| US-002 | Product sheet export with an empty Category column | api | `e416e8c` |
| US-003 | Re-import parse and validate | api | `23477f5` |
| US-004 | Apply validated categories | api | `b9a9152` |
| US-005 | CRM export and import panel | crm · api (bookkeeping) | `2905e55` (crm) · `5a9af2a` (api) |

All five pass. `ralph/w6-category-export/prd.json` and
`_bmad-output/implementation-artifacts/sprint-status.yaml` say so.

## What it does

    GET  /admin/product-sheet/export.csv?brand=<slug>   the sheet, Category empty
    POST /admin/product-sheet/validate                  the dry run; writes nothing
    POST /admin/product-sheet/apply                     one transaction, all or none

Backoffice-only (director inherits). The CRM screen is `AdminProductSheet`
(`/admin/product-sheet`, Catalogue → Categories): house selector → Download → upload → report →
Apply.

Decisions worth a reviewer's attention:

- **The header row is a contract**, `Product ID,House,Collection,Design,Category`, declared once in
  `src/products/product-sheet.js` and asserted verbatim. `Product ID` is `products.id`, so a
  re-import matches on identity and never on row order — staff sort the sheet, delete finished rows
  and paste blocks between files.
- **Category is exported EMPTY on every row.** That is what makes blank mean *skipped* and a value
  equal to the stored one mean *unchanged* — the pair of counts the whole report is built on.
  Exporting the stored value would make "the office confirmed this" indistinguishable from "the
  office did not get to this row".
- **The dry run and the write are two routes, not one with a `?dry_run=` flag**, and they share one
  decision: the private `matchProductSheet(db, parsed, { lock })`, which the apply runs inside its
  own transaction with `FOR UPDATE` (`ORDER BY id` beside it as the deadlock rule). The apply takes
  the FILE again rather than the report — a list of updates handed back by a client is a list the
  client could have edited.
- **`applied` is the UPDATE's own `rowCount`**, not the report's prediction; they agree by a check
  that throws 409 and rolls back if they ever do not.
- **Both routes refuse a broken sheet in exactly the same words** (one `refusalBody`), which is what
  lets one CRM panel serve both buttons. Asserted `toEqual` rather than separately, so the two
  cannot drift with both tests green.
- **No new dependency, in either repo.** The upload is raw bytes through a content-type parser
  encapsulated in the route's own plugin (the Stripe-webhook posture); there is no multipart parser
  in this API and adding one is a dependency.

## Gates

| Repo | Command | Result |
|---|---|---|
| atelier-api | `npm run lint` | 0 |
| atelier-api | `npm test` | 0 — 52 files, 1216 tests |
| atelier-crm | `npm test` | 0 — 38 files, 603 tests |
| atelier-crm | `npm run build` | 0 |

`test/product-sheet.test.js` is new and holds 52 of those tests across three suites (export,
validate, apply); the CRM's `src/screens/adminProductSheet.test.js` holds 36.

There is no typecheck step in either repo, and no e2e harness on this machine — hence the
verification list below rather than a browser assertion.

**Not run here, and it must be run before merge:**
`npm run convert:pricing && git diff --exit-code src/seed/data/price-lists.json`. US-001 moved
`decodeText`/`csvRows`, and `incoming/pricing-templates/` is gitignored so it exists only in the
main checkout. It was verified in the worktree against a hand-made fixture instead — the converter's
output line is byte-for-byte equal to line 2 of the committed `price-lists.json`, which is
unmodified — but the real corpus run is a main-checkout step.

## Needs human verification

A person should drive the round trip once in a browser, signed in as back office, at
`http://localhost:5273/#/admin/product-sheet`:

1. Pick a house and press Download. Confirm the file opens in Excel as five columns with **Category
   empty**, and that a design whose name begins `=` shows as text rather than evaluating.
2. Type a category into a few rows, save as **CSV (Comma delimited)** — which is cp1252 on Windows —
   and choose the file. Confirm the counts in the report match what was typed and that **no Apply
   button appears until the check comes back clean**.
3. Press Apply, then confirm the categories on `/admin/products`. Upload the same file again and
   confirm it reports `0 applied` — re-applying is a no-op by construction.
4. Break one row (a misspelt category) and confirm the refusal names **that row's number** and
   offers no Apply, and that choosing an `.xlsx` by mistake is refused by name.
5. The download and both uploads are cross-origin (CRM :5273 → API :3001) with a credentialed
   request. `app.inject()` does not preflight, so only a real browser proves the CORS methods —
   the standing rule in `atelier-api/CLAUDE.md`.

No migration, no seed change and no change to `src/seed/data/price-lists.json` in this workstream.
