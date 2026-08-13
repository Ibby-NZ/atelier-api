/**
 * Fields Dynamics does not have, on a record Dynamics does (or one the office
 * raised itself).
 *
 * WHY THIS IS ITS OWN COLUMN AND NOT MORE KEYS IN `patch`. `patch` is keyed on
 * D365 COLUMN NAMES, and three separate mechanisms read it that way:
 * `overridden_fields` is `jsonb_object_keys(patch)`, `base` is a snapshot of the
 * staging row taken per written key, and `stale_fields` compares the two. A
 * custom key inside `patch` would therefore be reported to the CRM as an
 * overridden D365 field, would make `baseSnapshotSql` throw (it refuses a column
 * outside the whitelist, deliberately), and would never be projected at all —
 * `mergedProjection` emits the entity's declared columns and nothing else. So a
 * custom field is a different KIND of fact and gets its own lane, which is the
 * same argument that put `d365_overrides` beside the staging tables rather than
 * on top of them.
 *
 * NO CHECK ON THE SHAPE, AND NO GENERATED COLUMNS. The keys are free-form by
 * definition — that is the feature — so there is no set to constrain them to.
 * Validation is at the API boundary (src/legacy/override-schema.js): key
 * pattern, scalar-only values, length and count caps. A jsonb value also needs
 * none of the three `d365_override_*` safe-cast functions the typed patch
 * columns need: it is read out as jsonb and handed to the CRM as jsonb, so no
 * value stored here can raise 22P02 and take an entity's whole listing down.
 *
 * NOT NULL DEFAULT '{}' so every reader can treat it as an object without a
 * COALESCE, and so the merged read's two UNION branches can emit it identically.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('d365_overrides', {
    extras: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
  })
}

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.dropColumns('d365_overrides', ['extras'])
}
