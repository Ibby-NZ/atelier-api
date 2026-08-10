# W2 — CRUD completion (`aug6/w2-crud`)

Every dataset the CRM shows now has full create, read, update and delete — including the DELETE
endpoints the API has never had, a standalone Collections screen, and a first live screen for the
freight tiers.

Epic: [`_bmad-output/planning-artifacts/epics.md` § Epic 2](../../_bmad-output/planning-artifacts/epics.md)
· Architecture: [`architecture.md`](../../_bmad-output/planning-artifacts/architecture.md)
(§§ *Shared lifecycle module*, *Delete policy*, *CRM CRUD kit*)

**Requires:** W1 Foundations, already merged into this branch (`2b75fae`, `560c13b` in the API;
`74fd824` in the CRM). Every hard delete goes through W1's `src/lifecycle/` registry, and every
screen composes W1's `src/admin/` kit. Neither was edited by this workstream.

**Blocks:** W5 (reporting reads these models).

---

## Stories

All 12 pass.

| # | Story | Repos | API commit | CRM commit |
|---|---|---|---|---|
| US-001 | DELETE for brand and collection | api | `5ed1479` | — |
| US-002 | DELETE for product and colourway | api | `6172811` | — |
| US-003 | DELETE for price-list item and contact enquiry | api | `7596d50` | — |
| US-004 | DELETE for user with the self-delete guard | api | `009e62e`, `0966b52` | — |
| US-005 | Missing admin reads: brand, collection, price-list item by id | api | `135885b` | — |
| US-006 | Colourway list and detail endpoints | api | `e24d300` | — |
| US-007 | Shipping-rate CRUD with the last-tier guard | api | `f9e25c0` | — |
| US-008 | Inventory create and delete | api | `1e3fde4` | — |
| US-009 | Delete on the products and houses screens | crm | `024967b` (bookkeeping) | `9a7b875` |
| US-010 | Standalone AdminCollections screen | crm | `b7ac235` (bookkeeping) | `e015b0e` |
| US-011 | AdminShipping screen | crm | `4e2d0bb` (bookkeeping) | `6be831a` |
| US-012 | Delete on stock, supplier rates, orders and users screens | crm | this commit (bookkeeping) | `e2fa086` |

A CRM story's API commit carries `prd.json`, `progress.txt` and `sprint-status.yaml` only — no API
source. `0966b52` is a follow-up that hardened US-004's tests after two Ralph iterations collided in
the same worktree; the story itself is `009e62e`.

---

## What landed

**Nine DELETE routes**, every one a one-line handler piping `deleteOrExplain` into `replyDelete`:
brand, collection, product, colourway, price-list item, contact enquiry, user, shipping rate,
inventory. Each probes before it deletes, because the schema will not stop a destructive delete —
of the 13 FK edges between the live tables exactly one is RESTRICT, eight CASCADE and four SET NULL.
A refused delete is a **409 carrying `blockers` and `archivable`**, never a thrown error (Fastify's
serializer drops custom properties off a thrown one).

Three guards do the work no probe can: a zone's **last** freight tier is refused (an empty zone makes
`getShippingQuote` 400 and stops checkout for every shopper in it), an inventory row with
`qty_reserved > 0` is refused (deleting it would leave the release join matching nothing forever),
and a **self-delete is 403**. An order has no delete at all — `deletable: false` in the registry.

**Six new or widened admin reads**: `GET /admin/brands/:id`, `/admin/collections/:id`,
`/admin/price-list-items/:id`, `/admin/colourways` (paginated, filterable) and
`/admin/colourways/:id`, plus `id` added to `listShippingRates`. The by-id brand and collection
reads carry child counts that deliberately **agree with the delete probes** — archived rows
included — because the kit forbids a pre-flight "can I delete this" GET, so the detail read is the
only place a screen can learn in advance that Delete will be refused.

**Shipping-rate and inventory CRUD**: `GET|POST /admin/shipping-rates`, `PATCH|DELETE /:id`, and
`POST /admin/inventory`. `unit` is derived from the colourway's product type through one exported
helper and never accepted from a client — it is what every quantity on the row *means*, so a
client-chosen unit does not produce a row a check could reject, it silently redenominates the stock.

**Every live CRM list screen now composes the kit.** Delete with the shared `ConfirmDialog` is on
houses, collections, products, freight tiers, stock, supplier rates and both account rosters; on a
409 the dialog stays open, renders the API's sentence plus one line per blocker, drops the confirm
button and offers "Archive instead" where the entity has an archive. Two new screens:
`AdminCollections` (`/admin/collections`, split out of AdminBrands) and `AdminShipping`
(`/admin/shipping`, the first thing in the CRM that could ever edit a freight tier). The five
copy-pasted paginators are gone.

---

## Gates

| Repo | Command | Result |
|---|---|---|
| atelier-api | `npm run lint` | 0 |
| atelier-api | `npm test` | 0 — 39 files, **766 tests** (655 before this branch) |
| atelier-crm | `npm test` | 0 — 35 files, **490 tests** (389 before this branch) |
| atelier-crm | `npm run build` | 0 |

There is no typecheck in either repo and no ESLint in the CRM, which is why `npm run build` is a
gate there rather than a release step. API tests run against a real local Postgres (`atelier_w2`).
No migration was added by this epic, so there is no second-run no-op to prove.

---

## Needs human verification

There is no e2e harness and no `dev-browser` on the build machine, so every screen contract below
was verified by source scan and unit test only. A person must look at these.

**The standing one, and the one most likely to break everything at once:** a **real cross-origin
DELETE preflight from the CRM at :5273**. `app.inject()` does not preflight, so nothing in the API
suite can prove it; `allowedMethods` in `src/app.js` already lists DELETE and `test/cors.test.js`
guards it, but only a browser settles it. If it is wrong, every delete in this PR fails while curl
passes.

**Catalogue (US-009, US-010)**
- Houses → Delete a house holding products: dialog stays open, shows "3 products, 1 collection"
  style lines, **no** Delete button, an **Archive instead** button. An empty house deletes and the
  toast names it.
- Products → Delete a product with an order line behind it: the blocker labels must read
  "colourways holding stock" / "units of stock on hand", and a `capped` count must render "1+", not
  "1".
- Collections → a house row's Collections link lands on `/admin/collections` with that house
  filtered, and clicking a *second* house's link while already there changes the filter (the bug
  `useState` would have had). With the filter on "All houses", two same-named collections from
  different houses must be distinguishable in the list, the dialog and the toast. Creating a
  collection whose name already exists under a *different* house must succeed; under the same house,
  409.
- Escape and a backdrop click cancel, and focus lands on Cancel so a stray Enter cannot delete.

**Freight rates (US-011)**
- A rate typed in **dollars** must reach the API as whole cents — the one arithmetic error this
  screen could make silently. Check `GET /shipping/quote?zone=&qty=` follows an edit.
- Delete a zone's **last** tier: dialog stays open, reads the guard's sentence, **Cancel only** (no
  "Archive instead" — a freight tier has no archive).
- Create a tier at a floor that already exists in that zone: a 409 naming the existing tier, inline,
  with the form still filled. Create one with a brand-new zone name and confirm the zone starts
  quoting.

**Stock, supplier rates, orders, accounts (US-012)**
- Manage stock → Delete a row with `qty_reserved > 0`: **Cancel only**, same as a freight tier.
  Delete an unreserved row, confirm the **SKU survives in the catalogue**, then use "Add a stock row"
  to bring it back at 0 in the right unit (metres for a fabric, units for a finished good).
- Supplier rates → the CRM's first real pager: page through it, confirm a search resets to page 1,
  and confirm that deleting the last row on the last page steps back a page rather than showing an
  empty table. The delete confirmation must say the next import re-creates the row **before** Delete
  is pressed.
- Web orders → there must be **no Delete anywhere**, in any state. Archive/Restore still work.
- Users & permissions → try to delete **your own** signed-in account: 403, no count lines, Archive
  instead offered. Delete a client with an order: the 409 names orders / trade applications /
  contact enquiries with counts.
- The four Dynamics mirrors (Clients, Price lists, Stock, Sales orders) page exactly as they did.

**Two things this branch cannot deliver, recorded so they are not mistaken for oversights**
- **"Samples block a product delete"** (US-002 criterion 1) is unmeetable: there is no `samples`
  table yet. E4 US-001 creates it, and whoever lands it must add the probe to the `product` and
  `colourway` registry entries plus a test here. A probe against a non-existent relation fails the
  registry's `information_schema` safety test, so nothing was stubbed.
- **`ralph/w2-crud/CLAUDE.md` is modified and uncommitted**, and was not authored by any story in
  this epic — its MAY-touch list was widened mid-run. It is an edit to the operating instructions,
  which no story owns; a human should commit it or explain it.
