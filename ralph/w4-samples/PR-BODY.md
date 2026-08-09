# W4 Samples — a real samples register and showroom stocking

Epic 4 of the August 6th updates: `_bmad-output/planning-artifacts/epics.md` § *Epic 4 — Samples*.
Spec: `_bmad-output/planning-artifacts/architecture.md` § *Samples domain* and § *Delete policy*.
Branch `aug6/w4-samples` in **atelier-api** and **atelier-crm**; a story touching both repos
produces two commits with the same `[W4-US-XXX]` tag.

Replaces three demo screens that persisted nothing with a live register (`samples` +
`sample_loans`), showroom stocking (`showrooms` + `sample_orders`), the CRM screens over them, and
a scanner wired to the real endpoints.

## Stories

| # | Story | Repos | Commits |
|---|---|---|---|
| US-001 | Migration: showrooms and samples | api | `d4b2fc0` |
| US-002 | Migration: sample_loans with the one-open-loan index | api | `2f85c08` |
| US-003 | Migration: sample_orders | api | `0703bcc` |
| US-004 | Sample read models, filters and overdue derivation | api | `9d06df4` |
| US-005 | Sample CRUD routes and by-barcode lookup | api | `4b6a5b9` |
| US-006 | Check-out and check-in verb routes | api | `8f9aa22` |
| US-007 | Sample-order lifecycle module and routes | api | `2226583` |
| US-008 | AdminSamples and AdminShowrooms screens (+ the showroom API they needed) | api + crm | api `6f96437`, crm `129c011` |
| US-009 | AdminSampleOrders, live scanner, retired-route redirects | crm | crm `4fdaa4d`, api `4f0fd1d` (bookkeeping) |

Also on the branch: `49ab165` (US-005 blocked bookkeeping) and `12e8a22` (the human unblock that
widened the allowed-file list to `src/app.js` and `src/lifecycle/registry.js`, additive only) —
the audit trail of the mid-sprint ownership decision, deliberately kept.

## Gates (final state, after US-009)

- `( cd atelier-api && npm run lint && npm test )` → 0 — 59 files, 1438 tests, real local Postgres
  (`atelier_w4`)
- `( cd atelier-crm && npm test && npm run build )` → 0 — 40 files, 661 tests; Vite build clean
- Migration stories: `npm run migrate` run twice, second run "No migrations to run!" (proved per
  story in `ralph/w4-samples/progress.txt`)

There is no typecheck in any of these repos, and no e2e harness on this machine — the browser
checks below are owed by a person.

## Needs human verification (aggregated)

Nothing in W4 has been rendered in a browser: this repo pair has no jsdom and no e2e harness, so
every UI assertion is a source scan or a pure-module test. A person should eyeball:

1. **`/#/admin/samples`** (US-008) — filter bar (search, status, showroom, tri-state overdue
   select); an overdue row prints in clay; the expanded row's check-out form, movement history and
   Save.
2. **`/#/admin/showrooms`** (US-008) — create, rename; a showroom with samples refuses Delete with
   a dialog offering "Archive instead".
3. **`/#/admin/sample-orders`** (US-009) — raise a request, advance it requested → ordered → … and
   confirm each move stamps its date in the History line; Delete greyed once past `requested`; a
   cancelled order offers no moves.
4. **`/#/sample-scanner`** (US-009) — scan or type a barcode (a wedge scanner's Enter submits);
   check a sample out and back in; the "not in the register" card for an unknown tag.
5. **Redirects and tabs** (US-009) — old bookmarks `/#/samples` and `/#/showroom-samples` land on
   the register and sample orders; the samples strip reads register / showrooms / orders / scanner.
6. **Known cosmetic gap** — `layout.jsx` is outside this workstream's files, so the SideNav
   Samples item does not light on `/admin/samples`, `/admin/showrooms` or `/admin/sample-orders`.
   One line for whoever owns that file.

Judgement calls a human should confirm (each flagged in its story's progress entry):

- The `showrooms` column set (address book: address, city, three contact fields, notes) is what
  the office records for a stockist (US-001).
- A borrower is a free-text `holder_name` snapshot plus an optional trade-account link (US-002).
- A sample order is ONE requested item with no quantity column; `displayed` is the office's word
  for "on the shelf in the showroom" (US-003).
- The register search covers tag/label/type/shelf/design — deliberately not the borrower (US-004).
- `out` is unwritable by PATCH (movements only through the verb routes), and a sample with any
  loan history is never hard-deletable (US-005).
- A `missing`, `retired` or archived sample may be checked out without argument, and check-in
  always returns to `in_library` — a damaged return is a follow-up PATCH (US-006).
- `displayed`/`cancelled` are terminal; delete only from `requested`/`cancelled`; an order is
  created `requested` and advanced, never created mid-lifecycle (US-007).
- Check-out lives on the register screen as well as the scanner; the colourway link is a typed id
  box until a picker exists (US-008).
- The demo Tracking screen is now unreachable by design; reversing that is a product decision,
  not a bug (US-009).

## Still owed, named by no story in this PRD

- `CONSTRAINT_BLOCKERS` in `src/lifecycle/delete.js` has no `sample_loans_sample_id_fkey` or
  `sample_orders_showroom_id_fkey` entry (the probes cover both; only a lost race falls through
  to the generic "related records"). That file is not on this workstream's list.
- The `product` and `colourway` registry entries carry no `samples` probe, so deleting a design
  does not yet see the samples cut from it. `atelier-api/CLAUDE.md` records this as owed to E4,
  but no US-001..US-009 criterion names it and it changes another workstream's delete route — a
  human should decide whether it becomes a story.
- A colourway picker for the sample and sample-order forms (both currently a typed id whose
  resolved design renders after save).
- Deleting the retired demo screen files (`SampleTracking.jsx`, `ShowroomSamples.jsx`, unrouted
  since US-009) — outside this workstream's allowed files.
