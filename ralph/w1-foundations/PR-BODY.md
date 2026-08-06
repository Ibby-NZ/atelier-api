# W1 Foundations — "August 6th updates"

The shared delete/archive lifecycle module in the API and the CRM CRUD kit that
every other workstream consumes. Epic 1 of nine
(`_bmad-output/planning-artifacts/epics.md` § Epic 1); architecture in
`_bmad-output/planning-artifacts/architecture.md` § *Shared lifecycle module*,
§ *Delete policy* and § *CRM CRUD kit*.

**Requires:** nothing — this is first.
**Blocks:** W2, W3, W4, W5, W6, W7. Nothing else starts until this merges.

Merge target: `august-6th-updates` in each repo. Branch: `aug6/w1-foundations`.

---

## Stories

| # | Story | Repos | Commits |
|---|---|---|---|
| US-001 | Lifecycle registry and `deleteOrExplain` | api | `9ccb985` |
| US-002 | `setArchived` replaces the eight duplicated archive helpers | api | `73bb79f` |
| US-003 | Registry safety tests | api | `970e6bc` |
| US-004 | CRM list kit: `list.js`, `useAdminList`, `Pagination` | crm (+ api bookkeeping) | `28a02c0` · `190e7e6` |
| US-005 | CRM delete kit: `ConfirmDialog`, `deleteFlow`, `useCrudScreen`, `apiDelete` | crm (+ api bookkeeping) | `0f6300e` · `00090b9` |
| US-006 | CI workflows for all three repos | api + crm + store | `1064668` · `082e340` · `dac2f67` |

All six `passes: true`. No `BLOCKED.md`.

---

## What is in it

### atelier-api — `src/lifecycle/`

`registry.js` · `archive.js` · `delete.js`, plus three test files.

**The schema will not stop a destructive delete.** Of the 13 foreign-key edges
between the live (non-`legacy_*`) tables, exactly **one** is RESTRICT
(`order_lines_colourway_id_fkey`). Eight are CASCADE and four are SET NULL, so
`DELETE FROM brands WHERE id = <a stocked house>` raises nothing, destroys its
collections, products, colourways and inventory, and returns success. SET NULL is
worse because it is invisible — deleting a user SET NULLs their whole order
history into anonymous guest orders with no `guest_email`, silently.

So `deleteOrExplain(pool, entityName, id, ctx)` **probes first**:

```
BEGIN
  SELECT <id> FROM <table> WHERE <id> = $1 FOR UPDATE   (A)  0 rows -> 404
  entity.guard?.(client, id, ctx)                       (B)  refusal -> its status
  one probe query covering every relation               (C)  any count > 0 -> 409
  DELETE FROM <table> WHERE <id> = $1                   (D)
COMMIT
catch 23503 -> constraintBlockers -> the same 409 shape
```

- It **returns** the refusal, never throws it: Fastify's error serializer emits
  `{ statusCode, error, message }` and drops custom properties, so a thrown error
  cannot carry `blockers`. `replyDelete(reply, result)` keeps handlers thin.
- The lock is `FOR UPDATE`, **not `FOR NO KEY UPDATE`** — only `FOR UPDATE`
  conflicts with the `FOR KEY SHARE` an inserting transaction takes on the
  referenced row, and the weaker mode would leave the check-then-delete window
  open.
- Probes **count archived rows**, run as one `UNION ALL` round trip, each
  `LIMIT 101`, and report `{ count: 100, capped: true }` past that.
- Nine deletable entities registered (brand, collection, product, colourway,
  inventory, price-list item, user, shipping rate, contact enquiry) plus `order`
  as `archivable: true, deletable: false`. Supplier and sample entries belong to
  W3/W4, whose migrations create those tables.

`setArchived(db, entityName, id, archived, options)` replaces the UPDATE fragment
in all eight archive helpers. Each keeps its own wrapper — three different return
conventions are in play — and **no existing test file was modified**, which is the
move-not-rewrite proof.

### atelier-crm — `src/admin/`

`list.js` · `useAdminList.js` · `Pagination.jsx` · `deleteFlow.js` ·
`ConfirmDialog.jsx` · `useCrudScreen.js`, plus `apiDelete` appended to
`src/lib/api.js`, and six test files.

- `buildListQuery` drops `null`, `undefined` and the empty string — an "All"
  `<select>` with `value=""` would otherwise send `role=`, which the API's enum
  answers with a **400 that kills the whole list**, not one filter.
- `useAdminList` keys its effect on the **serialised query string**, never the
  `filters` object (an inline object literal refetches forever), resets to page 1
  on a filter change, and steps back a page when a delete empties the last one.
- `apiDelete` sends **no body and no JSON content-type**;
  `apiSend('DELETE', path)` would trip Fastify's
  `400 FST_ERR_CTP_EMPTY_JSON_BODY` before the route ran.
- **No pre-flight "can I delete this" request** — it races the delete and the
  409 already answers authoritatively. On a 409 the dialog **stays open**,
  renders one line per blocker and offers "Archive instead".
- `ConfirmDialog` sets `role="dialog" aria-modal="true"`, cancels on Escape, and
  focuses **Cancel** so a stray Enter cannot delete a row.

**No CRM screen consumes the kit yet** — screen files belong to W2 onward.

### All three repos — `.github/workflows/ci.yml`

On pull requests into `august-6th-updates`, `permissions: contents: read`,
Node 22. api: `postgres:14` service + `DATABASE_URL`/`COOKIE_SECRET`, then lint +
test. crm: test + build (**no ESLint in that repo**, so build is the only compile
check). store: lint + test + build. **No workflow references a typecheck step** —
there is no TypeScript in any of these repos.

---

## Gates

Run in each repo at the tip of this branch. All nine exit 0.

| Repo | Command | Result |
|---|---|---|
| atelier-api | `npm run lint` | 0 |
| atelier-api | `npm test` | 0 — 39 files, **656 tests** (was 547; +109) |
| atelier-crm | `npm test` | 0 — 32 files, **389 tests** (was 334; +55) |
| atelier-crm | `npm run build` | 0 |
| atelier-storefront | `npm run lint` | 0 |
| atelier-storefront | `npm test` | 0 — 108 tests (unchanged) |
| atelier-storefront | `npm run build` | 0 |

No migration in this workstream, so the double-migrate no-op proof does not apply.

---

## Needs human verification

1. **The confirm dialog has never been rendered.** There is no jsdom in the CRM
   and no screen consumes the kit yet, so `ConfirmDialog`'s accessibility rules
   are asserted against source text. When W2 wires the first delete button, check
   in a real browser: Escape closes it, focus starts on **Cancel**, a backdrop
   click cancels, and a genuine 409 (delete a house that has products) shows the
   blocker lines with **Archive instead**.
2. **The paginator's look.** `Pagination.jsx` has not been rendered either.
   Compare it against the existing paginators it will replace —
   `/admin/price-list-items` is the closest visual reference.
3. **The CI workflows themselves.** Nothing about a GitHub Actions runner can be
   exercised from the dev machine. In particular `npm ci` cannot even be
   rehearsed locally: every worktree's `node_modules` is a symlink to the main
   checkout, so running it would rebuild the shared tree. **The first pull
   request is the proof** — watch the api job's Postgres service and the `npm ci`
   step on all three.
4. **A real 409 end to end** once W2 adds the first DELETE route, against seeded
   data rather than test fixtures.

## Notes for reviewers

- `src/lifecycle/` ships the mechanism, not its callers. No DELETE route is
  registered in this PR; that is W2's story list, by design.
- Two invariants have no runtime surface in these repos and are therefore
  asserted against source text: the CRM hook's dependency arrays and active flag,
  and the API's rule that **no caller derives an entity name from a request**
  (`test/lifecycle-registry.test.js` scans every `deleteOrExplain`/`setArchived`
  call site outside `src/lifecycle/` and demands a single-quoted literal). Each
  scan carries its own "did I find any call sites at all" assertion, so a renamed
  function cannot make it pass vacuously.
- Full per-story detail, including the learnings each one produced, is in
  `ralph/w1-foundations/progress.txt`.
