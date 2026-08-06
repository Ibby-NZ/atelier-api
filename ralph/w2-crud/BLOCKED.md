# W2 CRUD completion — blocked stories

One section per blocked story, newest last. A human unblocks a story by clearing the `BLOCKED:`
prefix from its `notes` in `ralph/w2-crud/prd.json`; Ralph never retries one on its own.

---

## W2-US-001 — DELETE for brand and collection

**Blocked:** 2026-08-06T02:21:34Z
**Reason:** the story's mechanism lives in `atelier-api/src/lifecycle/`, which is W1's file
footprint (W2 must not author it) and which does not exist on this branch.

### What the story requires

`epics.md` Epic 2 names US-001 "Registry entries + DELETE routes for brand and collection".
`architecture.md` § *Shared lifecycle module* specifies all of it:

- a frozen registry entry per entity — `table`, `idColumn`, `archivable`, optional `guard`, and
  dependency probes `{ relation, label, sql }`;
- `deleteOrExplain(pool, entityName, id, ctx)`, which **returns** `{ deleted: false, status, error,
  message, blockers: [{ relation, label, count, capped }], archivable }` rather than throwing —
  Fastify's error serializer emits `{ statusCode, error, message }` and drops custom properties, so
  a thrown error physically cannot carry `blockers`;
- `replyDelete(reply, result)` to keep the route handler thin;
- the BEGIN → `FOR UPDATE` → guard → probe → DELETE → COMMIT order, with the `23503` catch as a
  backstop only.

Per the *Delete policy* table, brand blocks on `products` + `collections`, and collection blocks on
`products` (its FK is SET NULL, so without the probe a delete silently uncollects them).

### What was tried

1. Read `progress.txt`, `prd.json`, `project-context.md`, both `CLAUDE.md` files, `epics.md`
   Epic 2 and `architecture.md` §§ *Shared lifecycle module* / *Delete policy* / *CRM CRUD kit*.
2. Looked for the dependency to consume. It is absent in both repos:

   - `atelier-api/src/lifecycle/` — directory does not exist.
   - `grep -rn 'setArchived|deleteOrExplain|replyDelete' atelier-api/src` — no matches.
   - `atelier-crm/src/admin/` holds only `drafts.js`, `orderFlow.js`, `parts.jsx`, `stock.js`
     (+ tests) — no `list.js`, `useAdminList.js`, `Pagination.jsx`, `ConfirmDialog.jsx`,
     `deleteFlow.js`, `useCrudScreen.js`; `src/lib/api.js` has no `apiDelete`.
   - `_bmad-output/implementation-artifacts/sprint-status.yaml` — W1 US-001 "Lifecycle registry and
     deleteOrExplain" is still `pending`.
   - `git log` on `aug6/w2-crud` tops out at `38868e1`, the Ralph scaffold on top of `main`. The
     branch was never cut from, or merged with, `august-6th-updates`.

3. Considered and rejected hand-rolling the delete inside `src/catalogue/admin-brands.js` (a file
   W2 does own). It would satisfy prd.json's four acceptance criteria and pass the gates, but it
   duplicates the module W1 is building, collides with it at merge, and violates architecture.md's
   single-registry invariants. Ralph Step 6 covers this case explicitly.

No source file was written, so there is nothing to revert.

### What a human must decide

Pick one:

- **(a) Land W1 first.** Merge `aug6/w1-foundations` into `august-6th-updates` and rebranch/merge
  it into `aug6/w2-crud`, then clear the `BLOCKED:` prefix. This is what the epic plan assumes
  ("Requires: E1 merged") and needs no other change.
- **(b) Hand `src/lifecycle/` to W2.** If W1 is not going to be built, amend W2's Ralph prompt so
  `atelier-api/src/lifecycle/**` and `atelier-crm/src/admin/{list,useAdminList,deleteFlow,
  useCrudScreen}.js` + `{Pagination,ConfirmDialog}.jsx` + `apiDelete` move onto W2's MAY-touch list,
  and fold W1 US-001/US-002/US-004/US-005 into W2 as new stories. Note this makes W2 own files
  another workstream may also be editing.
- **(c) Descope.** Accept per-entity delete logic inside each owned module and drop the shared
  registry from architecture.md. Not recommended — the registry's whole value is that the probe
  list is declared once and safety-tested once.

### Same blocker, other stories

Unblocking W1 clears all of these at once; leaving it blocks each in turn:

| Story | What it needs from W1 |
|---|---|
| US-002 DELETE product/colourway | registry + `deleteOrExplain` |
| US-003 DELETE price-list item / contact enquiry | registry + `deleteOrExplain` |
| US-004 DELETE user (self-delete guard) | registry + `guard` |
| US-007 shipping-rate CRUD | the DELETE half (last-tier guard) |
| US-008 inventory create + delete | the DELETE half (`qty_reserved > 0` guard) |
| US-009..US-012 CRM screens | `useCrudScreen`, `Pagination`, `ConfirmDialog`, `apiDelete` |

**US-005** (admin reads by id) and **US-006** (colourway list/detail) depend on nothing from W1 and
can proceed on this branch as it stands.

---

## W2-US-002 — DELETE for product and colourway

**Blocked:** 2026-08-06T02:24:25Z
**Reason:** identical to US-001 — the mechanism is `atelier-api/src/lifecycle/`, which is W1's file
footprint and is still absent from this branch. Re-verified this iteration, not inherited.

### What the story requires

`epics.md` Epic 2 names US-002 "Registry entries + DELETE routes for product and colourway", so the
deliverable is two entries in W1's registry plus two thin handlers. `architecture.md`
§ *Delete policy*:

| Entity | Blockers → 409 | Guard |
|---|---|---|
| product | order lines via colourways, samples, non-zero inventory | — |
| colourway | order lines (RESTRICT), samples, non-zero inventory | — |

Note the second acceptance criterion in `prd.json` — colourways and zero-quantity inventory cascade
as **owned children**, so this story also needs the registry to distinguish a cascade a delete is
allowed to perform from one it must refuse.

### What was tried

1. Read `progress.txt` (`## Codebase Patterns` first), `prd.json`, `project-context.md`, both
   `CLAUDE.md` files, `epics.md` Epic 2, and `architecture.md` §§ *Shared lifecycle module* /
   *Delete policy*.
2. Re-verified the dependency on the branch as it stands **now** rather than trusting the US-001
   entry — another workstream could have landed it in between:

   - `ls atelier-api/src` — 21 entries, no `lifecycle`.
   - `grep -rn "deleteOrExplain|replyDelete|setArchived|from '.*lifecycle" atelier-api/src` — no
     matches.
   - `ls atelier-crm/src/admin` — `drafts.js`, `orderFlow.js`, `parts.jsx`, `stock.js` (+ tests)
     only; the CRUD kit is still absent.
   - `_bmad-output/implementation-artifacts/sprint-status.yaml` — W1 US-001 still `pending`.

3. Considered and rejected hand-rolling the delete inside `src/catalogue/admin-products.js` (a file
   W2 owns). It is a worse idea here than it was for US-001: this story's third acceptance
   criterion requires the 23503 backstop to produce "the same 409 shape", which is by definition
   `deleteOrExplain`'s shape — hand-rolling would pin that contract in a second place and leave two
   copies to be kept in step by hand at merge.

No source file was written, so there is nothing to revert.

### What a human must decide

Nothing new — this is the same decision US-001 raised, and options (a) / (b) / (c) above apply
unchanged. Choosing **(a) land W1 first** clears US-002 along with US-003, US-004, the delete halves
of US-007/US-008 and all four CRM stories in one move.

If the answer is going to be (a) but W1 is not close, consider **reordering `priority` in
`prd.json` so US-005 and US-006 come first**. They need nothing from W1, and running them now means
the loop spends its remaining iterations building rather than re-blocking the same dependency ten
times.

---

## W2-US-003 — DELETE for price-list item and contact enquiry

**Blocked:** 2026-08-06T02:28:17Z
**Reason:** two independent blockers — (1) the same absent `src/lifecycle/` as US-001/US-002, and
(2) **a planning gap that is new with this story**: the contact-enquiry half lives in files no epic
owns.

### What the story requires

`architecture.md` § *Delete policy* gives both rows, and both are the simplest in the table:

| Entity | Blockers → 409 | Guard |
|---|---|---|
| price-list item | — | — (copy must warn a re-import recreates it) |
| contact enquiry | — | — |

§ *Shared lifecycle module* still makes `deleteOrExplain` + `replyDelete` + a frozen registry entry
the only sanctioned delete path, returning **200 `{ deleted: { entity, id } }`**.

The second acceptance criterion — "the price-list response or docs warn that `npm run import:pricing`
recreates the row, so archive is the durable removal" — is a copy/doc change, not a code blocker.
It is true: the price-list upsert key is `(supplier, category, code)` with `ON CONFLICT … DO UPDATE`,
so a re-import genuinely resurrects any hard-deleted row.

### What was tried

1. Read `progress.txt` (`## Codebase Patterns` first), `prd.json`, `project-context.md`, both
   `CLAUDE.md` files, `epics.md` Epic 2 and `architecture.md` §§ *Shared lifecycle module* /
   *Delete policy*.
2. Re-verified blocker 1 on the branch as it stands now rather than trusting the US-001/US-002
   entries: `ls atelier-api/src` shows no `lifecycle`; `grep -rn
   "deleteOrExplain\|replyDelete\|setArchived" atelier-api/src` returns nothing; W1 US-001 is still
   `pending` in `sprint-status.yaml`.
3. Read the two entities' existing code to size the work honestly:
   `src/routes/admin-price-lists.js` + `src/pricing/admin-price-lists.js`, and
   `src/routes/contact.js` + `src/contact/contact.js`. **Both entities already have archive and
   restore** (`setPriceListItemArchived`, `setEnquiryArchived`), so US-003 adds hard DELETE
   alongside a working soft delete — it is not a rename of it.
4. Checked file ownership per entity, which is where blocker 2 appeared:

   - `src/routes/admin-price-lists.js` — on W2's MAY-touch list AND in Epic 2's "Owns these files".
     The price-list half is W2's.
   - `src/pricing/admin-price-lists.js` — the module the route calls, and where the SQL must go
     (route files are thin by house rule). **Not** on the MAY-touch list; not in Epic 2's owns list.
   - `src/contact/contact.js` and `src/routes/contact.js` — **neither is on any list anywhere.**
     `grep -in "contact\|enquir" epics.md` returns exactly one line, the US-003 row itself. No epic
     in the plan claims these files.

5. Considered hand-rolling both deletes. **This is a much closer call than it was for US-001/US-002
   and that is worth recording.** These two entities have no probes, no guard and no 409 shape, so a
   hand-rolled `DELETE … RETURNING id` emitting architecture.md's `200 { deleted: { entity, id } }`
   would be ~6 lines per entity and would later collapse to
   `replyDelete(reply, await deleteOrExplain(pool, '<entity>', id))` with an identical external
   contract and identical tests. The duplicate-409-shape argument that killed US-002 does not apply.
   It was still rejected, on blocker 2: half the story would be written into files the plan assigns
   to nobody, which is precisely the cross-workstream ownership question Ralph Step 6 reserves for a
   human.

No source file was written, so there is nothing to revert.

### What a human must decide

**Decision 1 — the same one US-001 raised.** Options (a) land W1 first / (b) hand `src/lifecycle/`
to W2 / (c) descope the registry, all unchanged. (a) remains the plan of record.

**Decision 2 — new, and needed whichever way decision 1 goes: who owns contact enquiries?**
`src/contact/**` and `src/routes/contact.js` are unallocated across all nine epics. Either:

- add them to W2's MAY-touch list (they are only reachable from a back-office inbox screen, so W2 is
  the natural home); or
- split US-003 into US-003a (price-list item, W2) and US-003b (contact enquiry, whoever takes the
  file); or
- drop the contact-enquiry half — archive already exists for it and no screen asks for a hard
  delete.

Note also that `src/pricing/admin-price-lists.js` should be added to W2's MAY-touch list explicitly
even for the price-list half; owning the route without the module it delegates to is not a workable
footprint, and the same shape recurs in US-005 (`getPriceListItem`) and US-007/US-008.

**If the human wants any delete before W1 lands, US-003 is the cheapest of the four to unblock** —
no probes, no guard, ~6 lines per entity, trivial conversion at merge.
