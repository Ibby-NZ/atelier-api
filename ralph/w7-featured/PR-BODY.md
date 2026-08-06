# W7 Featured — the office controls what the storefront features

Epic 7 of the "August 6th updates" sprint —
[`_bmad-output/planning-artifacts/epics.md` § Epic 7](../../_bmad-output/planning-artifacts/epics.md),
architecture in
[`_bmad-output/planning-artifacts/architecture.md` § Featured ordering](../../_bmad-output/planning-artifacts/architecture.md).

Branch `aug6/w7-featured` in all three repos. Requires W1 merged. Blocks nothing.
**This is the only epic permitted to touch `atelier-storefront`.**

## What changed, in one paragraph

Which houses and collections the storefront features was a set of slug arrays hand-edited in the
storefront's own source, so every change was a developer task and a deploy. It is now
`featured_rank` — one nullable integer per row on `brands` and `collections`, edited in the CRM,
ordered by the public read models and read by both storefront surfaces. The migration seeds the
storefront's existing hardcoded choice, so nothing moved on deploy.

## Stories

| # | Story | Repos | Commits |
|---|---|---|---|
| US-001 | Migration: `featured_rank` on brands and collections, seeded from the current choice | api | `7176840` |
| US-002 | Admin patch support and the whole-list reorder endpoints | api | `8857d86` |
| US-003 | Public read-model ordering, respecting the trade-only gate | api | `fe56de9` |
| US-004 | Seed test asserting `featured_rank` survives a reseed | api | `2ae55e9` |
| US-005 | CRM featured panel plus the pure ordering module | crm (+ api bookkeeping) | crm `8cabf10`, api `f1be510` |
| US-006 | Storefront homepage reads featured instead of the slug arrays | store (+ api bookkeeping) | store `600b84d`, api `17d8f92` |
| US-007 | Storefront brands page "In focus" reads featured; artwork fallback chain | store (+ api bookkeeping) | store `cece6c7`, api `b9417cf` |

All seven pass. None is blocked; `ralph/w7-featured/BLOCKED.md` does not exist.

## The decisions worth reviewing

- **An integer rank, not a boolean.** The homepage needs three hero slides *in a chosen order*, and
  a boolean produces a set with no order. NULL means not featured; an inline CHECK refuses 0 and
  negatives.
- **No unique index, deliberately.** `ORDER BY featured_rank ASC NULLS LAST, name ASC, id ASC` is
  deterministic when two rows share a rank, whereas a partial unique index would make every step of
  a reorder a potential 409. That is what lets a whole list be rewritten in one statement.
- **Position in the submitted array IS the rank.** `PUT /admin/brands/featured` takes slugs and
  `PUT /admin/collections/featured` takes `(brand_slug, slug)` PAIRS — a collection slug is unique
  per house and never globally. Each is one transaction that clears then re-applies; an entry
  matching nothing is a 422 naming it, and the refusal rolls the clear back.
- **`featured_rank` is absent from the seed entirely**, so a catalogue reseed can never move an
  office decision — the same posture as `trade_only`, inventory and shipping rates. Two tests keep
  it that way, one behavioural and one structural, because neither alone covers the regression.
- **The database owns the ORDER; a page owns its COMPOSITION.** "The first three are the hero" is
  decided in `index.astro`, not in the schema. There is no slot or section column and there should
  not be one.
- **The artwork fallback chain never borrows another row's picture.** Commissioned art keyed to this
  row → this row's own catalogue photograph → a designed empty ground. A hero captioned "Nature's
  Opera" over Larsen's interior is worse than a plain band.
- **The storefront asymmetry is real**: the home is `prerender = true` (a featured collection
  appears at the next site build) while `/brands` is `prerender = false` (a featured house appears
  immediately). The CRM panel carries a standing note saying so, rather than letting it read as a
  bug.

## Gates

Run at the end of US-007, all three repos, all exit 0:

| Repo | Command | Result |
|---|---|---|
| atelier-api | `npm run lint` | 0 |
| atelier-api | `npm test` | 0 — 940 tests, 50 files (44 new across the epic) |
| atelier-crm | `npm test` | 0 — 459 tests, 34 files (47 new) |
| atelier-crm | `npm run build` | 0 |
| atelier-storefront | `npm run lint` | 0 |
| atelier-storefront | `npm test` | 0 — 132 tests (36 new) |
| atelier-storefront | `npm run build` | 0 |

Migration story (US-001): `npm run migrate` run twice, the second run a no-op — the programmatic
runner returns an empty array, asserted by `test/featured-rank.test.js`.

Both storefront pages were verified without a browser, against a throwaway fixture API on port
3199 (never 3001 — another loop may hold it): the homepage by parsing `dist/client/index.html`
after a fixture build, and `/brands` — which is `prerender = false`, so there is no HTML to parse —
by driving the built middleware handler on an ephemeral port and parsing the response. Between them
they cover the seeded ranks, a deliberately re-ordered list, every rung of the artwork chain, the
empty case and an API outage.

## Needs human verification

No browser check was possible from this loop: there is no e2e harness in any repo and dev servers
must not be started. These are the screens a person has to look at.

1. **The CRM's Houses & collections screen** (`/#/admin/brands`) — the new "Featured on the
   storefront" panel. Confirm both strips list what the migration seeded (3 houses, 7 collections),
   that Up/Down/Remove/Add behave, and that a saved reorder round-trips through a reload. Also check
   the Houses list with "Show archived" both on and off: the toggle no longer refetches, because the
   screen loads archive-inclusive rows so a whole-list save cannot silently unfeature an archived
   house.
2. **The homepage** after a build against a live API — the hero, the latest-collections row and the
   featured band should look exactly as they do today.
3. **`/brands`** against a live API — the "in focus" strip.
4. **Which THREE HOUSES are featured is a judgement call the migration had to make.** The storefront
   has never hand-picked houses: the old strip derived its three from `is_international`, a design
   count and whether editorial photography existed, and that last input lives in the storefront's
   own content, so no SQL in the API could reproduce it. The migration seeds the three houses behind
   the three hero collections (de Le Cuona, Larsen, Manuel Canovas) so the homepage and the directory
   agree. If the office wants a different three, that is now one CRM edit.
5. **The plain "weave" tiles on `/brands` are a design call.** All three seeded houses are
   represented-only, so under the trade gate none of them can contribute a catalogue photograph and
   only `pierre-frey` has a committed editorial page — all three cards will therefore paint the weave
   ground with the house name over it. Correct per the fallback chain (dropping them would delete the
   office's choice from the page), but whether it reads as a designed name plate or as three missing
   images is a human's call. The alternatives are featuring houses that have editorial pages (a CRM
   edit, no code) or commissioning art.
6. **Confirm `featured-collection-image.jpg` really is Larsen 2024's portrait.** The homepage's
   featured band shows the collection its commissioned portrait was shot for, and that registry now
   keys the file to `larsen/larsen-2024`. It is what today's page renders, but the file name says
   nothing and no loop can look at it.
7. **Two degraded homepage states a person should judge**: a featured collection rendering its own
   catalogue photograph in the 88vh hero frame (a 4:5 room shot, so the crop is not art-directed),
   and the plain umber slide. Both are correct per the chain; whether the office accepts them is a
   design decision.
8. **Confirm `FEATURED_LIMIT = 12`** is an acceptable cap on both lists (the API's `maxItems`, and
   the CRM keeps its own copy of the number). The homepage leads with three and its latest row shows
   four; `/brands` shows three.
9. **A featured collection belonging to a `trade_only` house** renders as a hero slide that opens on
   an empty grid for a signed-out visitor. Correct per the visibility design, and a merchandising
   decision the office is now free to make by mistake.

## Notes for the reviewer

- The full audit trail — what each story implemented, every gate result and the learnings behind
  each decision — is `ralph/w7-featured/progress.txt`, newest entry last. Its `## Codebase Patterns`
  block at the top is the general findings only.
- Durable conventions were written into each repo's `CLAUDE.md` under a `## Featured` heading, so
  concurrent workstreams editing the same file do not collide.
- A story touching two repos produced two commits carrying the same `[W7-US-XXX]` tag; that tag is
  how the cross-repo halves reassemble.
