# W5 Reporting — "August 6th updates"

Real aggregation endpoints with filter-before-export, product performance by
brand, and server-side masking that actually fires. Epic 5 of nine
(`_bmad-output/planning-artifacts/epics.md` § Epic 5).

**Requires:** W2 merged (read models), W3 merged (suppliers and category) — both were.
**Blocks:** nothing.

Merge target: `august-6th-updates` in each repo. Branch: `aug6/w5-reporting`.

---

## Stories

| # | Story | Repos | Commits |
|---|---|---|---|
| US-001 | Extract the hardened CSV writer to `src/lib/csv.js` | api | `1debb9a` |
| US-002 | Migration: reporting index and finance access | api | `27fffdd` |
| US-003 | Report filter layer | api | `f1ad0d4` |
| US-004 | Revenue scope CTE and the masking module | api | `8434d6f` |
| US-005 | Product performance by brand | api | `8cd92db` |
| US-006 | Server-side CSV export | api | `a9c6a91` |
| US-007 | Stock and not-invoiced reports | api | `7604e53` |
| US-008 | `report_access` on `/auth/me` and CRM consumption | api + crm | `95ed056` · `b825dd7` |

All eight `passes: true`. No `BLOCKED.md`.

**Provenance note.** The loop died on the account's monthly spend limit with
US-008's code complete but uncommitted in both repos (iterations 8–10 stalled
producing nothing). The supervising session re-ran every gate green, wrote the
missing progress entry, and committed the work under the story tag. Nothing was
authored after the loop stopped except this file and that bookkeeping.

---

## What is in it

- **`src/lib/csv.js`** — the RFC 4180 + formula-neutralising CSV writer
  extracted from the trade price lists, now shared. The trade module imports it;
  behaviour pinned by tests before and after the move.
- **Migration `*reporting-index*` / finance access** — `users.can_view_finance`
  (default false) and the reporting indexes.
- **Report filter layer** — whitelisted filter columns, parameterised values,
  the same posture as the catalogue's FILTER_COLUMNS.
- **Revenue scope CTE + masking** — one CTE decides which orders count as
  revenue; `maskReport` projects columns by the caller's resolved access, so a
  non-finance login receives a report with the cost columns absent (projection,
  not deletion).
- **Product performance by brand**, **stock** and **not-invoiced** reports, all
  behind `requireRole('backoffice')`.
- **Server-side CSV export** — filter-before-export: the export endpoint runs
  the same filtered query as the JSON read and streams CSV through the shared
  writer; masking applies to the file exactly as to the screen.
- **`report_access` on `/auth/me`** — derived `{ reports, finance }` computed
  from the row on every read and published to the CRM; the backing flag itself
  never ships (`publicUser` projection). `loadReportAccess` re-fetches the flag
  by session-resolved id in the report layer, because `request.user` comes
  through `PUBLIC_USER_COLUMNS` and would otherwise read the flag as undefined
  forever. CRM's `accessOf` prefers the API's statement over the demo capability
  map, which is what makes masking fire for a non-finance staff login.

## Gates

`verify.sh` at the branch tip: api lint + tests, crm tests + build — see the
committed `verify-*.log`. Final suite: api 53 files / 1395 tests, crm green,
build green.

## Needs human verification (aggregated)

1. **The masked state needs a live API session to see.** Every CRM login maps
   to the demo director caps, so a back-office login with
   `can_view_finance = false` on a live API is the only way to eyeball the
   masked report library and its CSV export.
2. **Stock report ships without a valuation** until A1 (the cost source) is
   settled — confirm that is acceptable to the office.
3. **The not-invoiced queue carries no value column** because request lines
   never receive a price on this platform — confirm the queue is wanted
   value-less rather than not at all.
4. `epics.md` § Epic 5 for the epic-level context.
