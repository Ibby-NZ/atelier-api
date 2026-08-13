---
baseline_commit: da971a24a37f4e060a2323c2c7b35a712a471aa1
---

# Story W11.US-001: Custom fields on the D365 override layer

Status: done

Epic: `w11-d365-corrections` (`d365-custom-fields`) · repo: **atelier-api** only

## Story

As a **back-office user of the CRM's Dynamics browser**,
I want to **attach fields Dynamics does not have to a staged or locally raised record, and edit or remove them later**,
so that **the office can record what it knows about a customer, price row or stock item without waiting for a D365 schema change and without that note being destroyed by the next `npm run import:legacy`**.

## Context — what already exists, and what is actually missing

`migrations/1787025600000_d365-overrides.js` + `src/legacy/` already make the staging mirror writable:

| Capability | Route | State |
|---|---|---|
| Correct an existing D365 column | `PATCH /admin/legacy/:entity/:guid` `{ set, revert }` | **done** |
| Append a record D365 does not have | `POST /admin/legacy/:entity` `{ values }` | **done** |
| Suppress / restore a record | `DELETE`, `POST .../restore` | **done** |
| **Attach a field D365 has no column for** | — | **THIS STORY** |

`normaliseOverridePatch` (`src/legacy/override-schema.js:161`) 422s any key outside the entity's
read projection, so today the office can only correct the ~20 columns D365 exports. "New fields"
is the missing half of the request.

**Scope boundary:** api only. The CRM screen that renders custom fields is a separate story in
another repo. No change to any `legacy_*` table, the importer, or the client portal.

## Acceptance Criteria

**AC1 — storage beside the patch, not inside it.** A migration adds `extras jsonb NOT NULL DEFAULT
'{}'::jsonb` to `d365_overrides`. Custom values do **not** go into `patch`: `patch`'s keys are D365
column names and are what `overridden_fields`, `base` and `stale_fields` are all keyed on — a custom
key there would be reported as an overridden D365 field, would make `baseSnapshotSql` throw
(it refuses a non-overridable column), and would never be projected by `mergedProjection`, which
only emits declared columns. `npm run migrate` twice; the second run returns an empty array.

**AC2 — every merged row carries `custom_fields`.** Both `mergedProjection` UNION branches emit
`COALESCE(o.extras, '{}'::jsonb) AS custom_fields`, in the same position, and `MERGED_EXTRAS`
lists it. `GET /admin/legacy/:entity` and `/:guid` return `custom_fields: {}` on the
**non-merged fast path** too (`mapRow` defaults it, exactly as it already defaults
`overridden_fields` and `archived_at`) — otherwise the key appears and disappears depending on
whether anyone has ever corrected that entity.

**AC3 — set custom fields on a correction.** `PATCH /admin/legacy/:entity/:guid` accepts
`custom` (object) and `revert_custom` (array of keys), either alone or beside `set`/`revert`.
The merge stays **ONE statement**: `extras = (d365_overrides.extras || EXCLUDED.extras) -
$revertCustom::text[]`. A read-modify-write in JS loses an update whenever two staff edit one
record within seconds and tells neither — the same argument the `patch` merge is built on.

**AC4 — set custom fields when raising a record.** `POST /admin/legacy/:entity` accepts `custom`
beside `values`. **`values` must still carry at least one non-null declared column value** — a
record identified only by custom fields is unsearchable and unfilterable (search and filters run
over declared columns) and reads as a blank row in the list, which is the phantom-row failure
`createLocalLegacyRecord` already refuses.

**AC5 — a custom key may not shadow a D365 column.** A key equal to an overridable column of that
entity, or to `guid`, is a **422 naming it**. Two "credit_limit" values on one record cannot be
told apart by a reader, and the meaning would change under them if D365 ever exported that column.

**AC6 — keys and values validated at the boundary.** Key `^[a-z][a-z0-9_]{0,39}$` (the column
vocabulary, so one CRM renderer serves both). Value: string, finite number, boolean, or `null` —
objects and arrays are 422 (flat like `patch`; nested has no renderer and no search story). String
value ≤ 2000 chars; ≤ 50 custom fields per record. Each refusal names the offending key.
The values are again **left untyped by the route schema** and gated in `override-schema.js`:
Ajv's `coerceTypes` would turn a deliberate `null` into `''` against a union type, and
`additionalProperties: false` would strip every key and answer 200 having written nothing.

**AC7 — `null` means empty, `revert_custom` means gone.** `custom: { x: null }` stores a JSON null
(the field exists, with no value); `revert_custom: ['x']` drops the key. Same semantics as
`set` vs `revert`, so there is one rule to learn. A key named in both `custom` and `revert_custom`
is a 422, not a precedence rule nobody can see from the request.

**AC8 — `dropEmptyOverride` must not destroy custom fields.** It deletes an override row whose
`patch` is `'{}'`; it gains `AND extras = '{}'::jsonb`. Without this, reverting the last column
correction on a record silently deletes every custom field beside it. Regression-tested directly.

**AC9 — custom fields survive `npm run import:legacy`.** Asserted by running the real importer in
the test, the way every other durability claim in `test/legacy-overrides.test.js` is.

**AC10 — staleness and `base` are untouched.** D365 has no value for a custom field to have
diverged from, so `custom` keys never enter `base` and never appear in `stale_fields` or
`overridden_fields`. A record with only custom fields reports `override.fields: []`.

**AC11 — privileges.** Custom fields are **clerical: `backoffice`**, like any other correction.
`touchesCommercial` classifies by declared column name and cannot classify a free-form key, so the
finance gate does not apply and must not be faked. Note in the code that a staff-typed custom field
carries only what a staff member typed — no D365 cost figure reaches it — so this opens no read
path the finance flag protects. Raising a record stays director-only.

**Gates (this repo's real ones — there is no typecheck anywhere):** `npm run lint` and `npm test`
green, plus `npm run migrate` twice proving the second run is a no-op.

## Tasks / Subtasks

- [x] **T1 — migration** (AC1). `migrations/<free timestamp>_d365-override-extras.js`, ESM
  (`export const up/down`; `migrate:create` emits CommonJS — rewrite it). **Check the timestamp is
  free first** (`ls migrations | grep <prefix>`): two collisions already exist in this repo and are
  deliberately not renamable. `addColumns` with `notNull: true, default: "'{}'::jsonb"`; `down`
  drops the column. No CHECK on the jsonb shape — the validation lives at the boundary, and a
  schema-level shape check is unexpressible for free-form keys.
- [x] **T2 — `src/legacy/override-schema.js`** (AC5, AC6, AC7). Export
  `normaliseCustomFields(entity, values)` and `normaliseCustomRevertList(entity, keys)`
  (mirroring `normaliseOverridePatch` / `normaliseRevertList`, same `httpError(422, …)` shape and
  the same "name the offending key" discipline). Export `CUSTOM_KEY_PATTERN`, `MAX_CUSTOM_FIELDS`,
  `MAX_CUSTOM_VALUE_LENGTH` so the tests assert against the constant, not a retyped literal.
  Add the `custom_fields` projection to **both** branches of `mergedProjection`.
  `assertEntities()` needs no new rule — `custom_fields` is synthetic and declared in neither
  `columns` nor `filters`.
- [x] **T3 — `src/legacy/legacy-read.js`** (AC2). Add `'custom_fields'` to `MERGED_EXTRAS`;
  default it in `mapRow` (`if (!Object.hasOwn(out, 'custom_fields')) out.custom_fields = {}`).
  Nothing else: the value is jsonb in and jsonb out, so none of the three safe-cast functions
  apply and no listing can be 500ed by a bad custom value — which is the whole reason this is a
  jsonb column rather than typed ones.
- [x] **T4 — `src/legacy/legacy-overrides.js`** (AC3, AC4, AC7, AC8). `setLegacyOverrides` takes
  `custom` / `revertCustom`; bind them into the existing upsert (`extras` in the INSERT column
  list, `(d365_overrides.extras || EXCLUDED.extras) - $n::text[]` in the DO UPDATE).
  `createLocalLegacyRecord` takes `custom`. Add `AND extras = '{}'::jsonb` to `dropEmptyOverride`.
  The "provide at least one column to set or revert" 422 must now also be satisfied by a
  custom-only request — a PATCH carrying only `custom` is valid.
- [x] **T5 — `src/routes/admin-legacy.js`** (AC3, AC4, AC11). Add `custom` (reuse `valuesSchema`)
  and `revert_custom` (array, `minItems: 1`) to `patchBodySchema`, and `custom` to
  `createBodySchema`. `requireFinanceFor` keeps receiving **declared** column names only — do not
  pass custom keys through it. Comment why.
- [x] **T6 — tests** in `test/legacy-overrides.test.js` (all ACs). New `describe('custom fields')`
  block reusing the existing fixtures/cleanup; add at least one case to the
  `every entity, not just accounts` block. Cleanup is on `created_by_user_id` against the suite's
  own fixture users — a row whose only identifying text is in the patch cannot be found by guid or
  by patch content once emptied.
- [x] **T7 — docs**. Append to the **existing** `### Correcting the mirror (d365_overrides)`
  subsection of `CLAUDE.md`: what a custom field is, why `extras` is a separate column, the
  shadowing rule, the `dropEmptyOverride` trap, and that the finance gate deliberately does not
  reach it. Do not restructure neighbouring sections. Flip `w11-us-001` to `done` in
  `_bmad-output/implementation-artifacts/sprint-status.yaml` in the same commit.

## Dev Notes

### Files to touch (5 source + 1 migration + 1 test + 2 docs). Read each fully before editing.

| File | State today | This story |
|---|---|---|
| `migrations/…_d365-override-extras.js` | — | NEW |
| `src/legacy/override-schema.js` | pure rules; `assertEntities()` runs at module load | + custom validation, + projection |
| `src/legacy/legacy-read.js` | two query paths, merged CTE, `mapRow` | + `MERGED_EXTRAS` entry, + `mapRow` default |
| `src/legacy/legacy-overrides.js` | three writers, all one-statement merges | + `custom` on two of them, + `dropEmptyOverride` guard |
| `src/routes/admin-legacy.js` | thin handlers, schemas | + two body properties |
| `test/legacy-overrides.test.js` | 71 tests | + custom-field block |
| `CLAUDE.md` | has the override section | append only |

### Traps this story can fall into (each one is silent)

1. **Putting custom values in `patch`.** They would be reported as overridden D365 fields, and
   `baseSnapshotSql` throws on a non-overridable column. AC1.
2. **Forgetting the fast path.** `listLegacy` skips the merged CTE entirely when no override
   exists for the entity, so `custom_fields` must be defaulted in `mapRow`. AC2.
3. **Misaligning the UNION branches.** A UNION ALL lines its branches up by POSITION and names
   its output from the first. Add the column in the one loop / one place both branches are built
   from; `assertEntities` asserts the two lengths match, which catches only the crudest case.
4. **`dropEmptyOverride` eating the custom fields.** AC8 — this is the highest-value regression
   test in the story.
5. **Typing the values in the route schema.** Ajv `coerceTypes` turns a deliberate `null` into
   `''`; `additionalProperties: false` + `removeAdditional` strips every key and answers 200 having
   written nothing. The comment already in `admin-legacy.js:110-129` explains both — extend it,
   do not contradict it.
6. **Writing to a `legacy_*` table.** Nothing in `src/legacy/legacy-overrides.js` may. The
   importer upserts every mapped column to EXCLUDED, so such a write vanishes at the next import
   with no error.

### Testing standards

`npm test` runs vitest against a **real local Postgres** (`atelier_dev`, `.env` required);
`vitest.config.js` sets `fileParallelism: false` because node-pg-migrate takes an advisory lock.
This suite registers its users **once** in `beforeAll` — `/auth/register` shares a
10-per-15-min-per-IP bucket, and re-registering per test 429s and yields no cookie. Numeric columns
come back from pg as strings; compare with `Number()`. Assert the REASON in every 422 message, so a
case cannot pass on the wrong refusal.

### References

- `src/legacy/override-schema.js` — `normaliseOverridePatch`, `mergedProjection`, `assertEntities`
- `src/legacy/legacy-read.js` — `MERGED_EXTRAS`, `mapRow`, `mergedSource`, two query paths
- `src/legacy/legacy-overrides.js` — `setLegacyOverrides`, `createLocalLegacyRecord`, `dropEmptyOverride`
- `src/routes/admin-legacy.js:110-129` — why the values are untyped in the schema
- `migrations/1787025600000_d365-overrides.js` — table header comment: why beside, not on top
- `CLAUDE.md` § *Legacy D365 staging* → *Correcting the mirror (`d365_overrides`)*
- `_bmad-output/project-context.md` § *Legacy D365 staging — read-only by design*, § *Quality gates*

## Dev Agent Record

### Agent Model Used

claude-opus-5[1m]

### Debug Log References

- RED: `npx vitest run test/legacy-overrides.test.js` → 27 failed / 73 passed (100 total).
- GREEN: same command → **100 passed**, the 71 pre-existing among them.
- `npm run lint` → clean.
- Migration proved up → down → up: the column exists (`is_nullable: NO`, `default '{}'::jsonb`),
  `down` removes it, re-up re-applies it, and a second `up` returns `[]`.
- Full suite `npm test` → **1886 passed, 4 failed in 2 files** (`test/contact.test.js` ×3,
  `test/featured-rank.test.js` ×1). **Both pre-existing and unrelated to this story** — they are the
  shared dev database's live state, not code: `contact_enquiries` holds one real submission
  (`bespoke-trial@verum.nz`, 2026-08-10) that the "lists 2 enquiries" and "0 rows" assertions count,
  and `brands.featured_rank` reads `loro-piana/pierre-frey/de-le-cuona` where the migration seeded
  `de-le-cuona/larsen/manuel-canovas` (someone reordered the strip through
  `PUT /admin/brands/featured`). Neither suite touches `src/legacy/*`, `d365_overrides` or the
  migration; both fail identically in isolation. Nothing was deleted from the dev database to make
  them pass. They pass on CI, which starts from an empty `postgres:14` service.

### Completion Notes List

- `extras` is a **separate jsonb column**, not more keys in `patch`. `patch` is keyed on D365 column
  names and `overridden_fields` / `base` / `stale_fields` all read it that way, so a custom key there
  would be reported as an overridden D365 field, would make `baseSnapshotSql` throw, and would never
  be projected at all.
- Being jsonb in and jsonb out, `custom_fields` needs none of the three `d365_override_*` safe-cast
  functions — no value stored here can raise 22P02 and take an entity's listing down. That is the
  argument for one free-form column over typed ones.
- Both UNION branches take the identical `customFields` string built once, so the branches cannot
  drift in the way `assertScopeSource` was written to catch.
- The `dropEmptyOverride` extras guard (AC8) is the highest-value line in the diff: without it,
  reverting the last column correction silently destroys every custom field beside it.
- The pre-existing `orders and counts <entity> identically on both query paths` tests turned out to
  be a free tripwire for AC2 — they compare fast-path and merged-path rows key for key, so a missing
  `mapRow` default would have failed them without a new test being written.
- Not done, deliberately: custom fields are not searchable or filterable. `q` and the filter
  whitelists run over declared columns; making a free-form key searchable is a product decision
  (which keys? indexed how?) and a separate story. Nothing here forecloses it.

### File List

- `migrations/1787112000000_d365-override-extras.js` (new)
- `src/legacy/override-schema.js` (modified)
- `src/legacy/legacy-read.js` (modified)
- `src/legacy/legacy-overrides.js` (modified)
- `src/routes/admin-legacy.js` (modified)
- `test/legacy-overrides.test.js` (modified — 32 tests added, 71 → 103)
- `CLAUDE.md` (modified — seven bullets appended to *Correcting the mirror (`d365_overrides`)*)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified — new `w11-d365-corrections` epic)
- `_bmad-output/implementation-artifacts/w11-us-001-d365-custom-fields.md` (new — this story)

## Senior Developer Review (AI)

**Date:** 2026-08-11 · **Outcome:** Changes requested → **resolved in the same run** · **Approve**

Three lenses run over the diff (`src/legacy/**`, `src/routes/admin-legacy.js`, the migration and
the test): acceptance audit against the ACs above, adversarial correctness, and edge cases.
Run inline in this session rather than as subagents.

### Action Items

- [x] **[High · AC6] The field cap was per REQUEST, not per record.** The merge is
  `extras || EXCLUDED.extras`, so fifty fields at a time twice over left a hundred on the record and
  the stated bound ("≤ 50 custom fields per record") bounded nothing. The check now runs on the
  merged result returned by the upsert, inside the transaction, so a refusal rolls the write back —
  the same place and the same reasoning as the existing revert-to-empty guard, and for the same
  reason: a pre-read counts a value another transaction is about to change. Two tests, including
  one proving a replacement AT the cap still succeeds (the total does not move).
- [x] **[Med · latent, whole class] A declared column sharing a synthetic column's name was
  unguarded.** Both would have been emitted, Postgres allows the duplicate output name, and the pg
  driver keeps whichever came last — a staging value silently overwritten by a synthetic one, or
  the reverse. `SYNTHETIC_COLUMNS` now lives beside the projection that emits it, `assertEntities()`
  refuses a collision and refuses a projection it does not name, and `legacy-read.js` imports the
  list instead of keeping a second copy that could disagree about membership *or order*. This
  covers `is_local` / `archived_at` / `overridden_fields` too, which were exposed before this story.

### Checked and found correct

- `__proto__` cannot be a key — `CUSTOM_KEY_PATTERN` requires a leading `[a-z]` — so building the
  map by plain assignment onto `{}` cannot pollute a prototype.
- Suppress/restore preserves `extras`: `setLegacySuppressed`'s upsert does not name the column, and
  `dropEmptyOverride` now requires both halves empty before removing the row.
- A local record's revert-to-empty guard is unchanged and still fires with custom fields present —
  correct, and consistent with AC4: custom fields cannot identify a record.
- `revert_custom`'s `maxLength: 100` is looser than the 40-char key pattern. Deliberate: the schema
  is a shape check and `override-schema.js` is the gate, which is the house rule.
- `override.fields` / `base` / `stale_fields` are untouched by custom keys (AC10), asserted.

## Change Log

| Date | Change |
|---|---|
| 2026-08-11 | Story drafted, `ready-for-dev`. |
| 2026-08-11 | Implemented T1–T7 red-green-refactor; 29 tests added, suite 100 green, lint clean, migration idempotent up/down/up. Status → `review`. |
| 2026-08-11 | Review: 2 findings, both fixed with tests (per-record cap; synthetic-name collision assert). Suite 103 green, lint clean. Status → `done`. |
