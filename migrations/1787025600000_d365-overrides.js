/**
 * Back-office corrections to the Dynamics-365 staging mirror, stored BESIDE it.
 *
 * WHY THIS TABLE IS NOT NAMED `legacy_overrides` AND HOLDS NO `legacy_` PREFIX.
 * `importLegacyEntity` upserts EVERY mapped column to EXCLUDED on conflict of
 * the D365 GUID (src/seed/legacy-import.js), and Atelier runs live on D365 until
 * cutover, so the import WILL re-run. Anything written onto a `legacy_*` row
 * therefore survives exactly until the next `npm run import:legacy` and then
 * vanishes with no error at all. That is the same argument `trade_accounts` and
 * the samples register were built on, and it is why this table sits outside the
 * namespace rather than inside it. The name is load-bearing twice over:
 * test/samples-schema.test.js, test/samples-loans.test.js and
 * test/samples-orders.test.js each assert that the number of live `legacy\_%`
 * tables equals the number of entries in LEGACY_TABLES, so a twelfth
 * `legacy_`-prefixed table turns three green suites red on this migration alone.
 *
 * THE INCUMBENT ALREADY MODELS THIS SPLIT. D365's own price rows carry
 * `atelier_setpricesmanually` plus the `atelier_manual*` family — a
 * calculated-value / override-value lane, live on 55 of 19,327 rows
 * (docs/d365-export-analysis.md). Corrections beside the source, never on top of
 * it, is the source system's own pattern; this is the same shape one layer out.
 *
 * `entity` HOLDS THE READ-ROUTE VOCABULARY, NOT THE IMPORT ONE. Two vocabularies
 * are live in this codebase and three of the four names differ:
 * `accounts | sales-orders | stock | prices` are what `/admin/legacy/:entity`
 * takes, while `accounts | sales_orders | stock_items | product_prices` are what
 * LEGACY_TABLES and `POST /admin/legacy/import/:entity` take. An override row
 * written under the import spelling would match no read config, apply nothing
 * and raise nothing — a silently inert correction — so the CHECK pins the read
 * spelling and test/legacy-overrides.test.js parses `pg_get_constraintdef` and
 * asserts it still equals LEGACY_ENTITIES. Seven of the eleven staging tables
 * have no read route and therefore no override capability; that is deliberate
 * and stated in CLAUDE.md rather than papered over here.
 *
 * NO FOREIGN KEY TO `legacy_*.guid`, AND THAT IS THE POINT. The staging tables
 * are re-imported wholesale, rows absent from a later export are kept, and an
 * override may legitimately be written before its record has landed (it stays
 * inert until the record arrives, which is the correct behaviour). An FK would
 * either block the import or cascade a correction away.
 *
 * `local` MARKS A RECORD THAT HAS NO D365 SOURCE AT ALL — a customer or price
 * row staff raised here. It is a boolean rather than an `origin` enum because it
 * is a two-state fact about whether a staging row exists behind the guid, and
 * the read derives which branch emits the record from `local` AND a NOT EXISTS
 * against the staging table. That pairing is what stops one guid appearing
 * twice: if a real D365 record ever lands under the same guid, the local branch
 * stops emitting and the staged branch takes over with the patch applied.
 *
 * `base` IS A SNAPSHOT OF WHAT D365 SAID WHEN THE CORRECTION WAS MADE, over all
 * of the entity's overridable columns, rewritten on every write. Without it an
 * override masks every future upstream correction to that field silently and
 * for ever: staff fix a credit limit here in March, accounts fix the same field
 * in D365 in June, the import lands the new figure, and the override keeps
 * returning the March one with nothing anywhere reporting the divergence. The
 * detail read compares `base` against the staging row and reports `stale_fields`,
 * which turns a permanent silent mask into a work queue. It is built with
 * `to_jsonb(<column>)` on both sides so the comparison is exact rather than a
 * text rendering that would disagree on numeric scale.
 *
 * `archived_at` IS SUPPRESSION, and it is the only removal that can survive a
 * re-import: a `DELETE FROM legacy_accounts` is undone by the next export.
 * Suppression hides the record from `/admin/legacy/*` ONLY — the staging row is
 * untouched and every other reader of `legacy_*` (src/trade-accounts/viewer.js,
 * client-legacy.js, admin-trade-accounts.js) writes its own SQL and is
 * deliberately unaffected. The DELETE route says so in its response rather than
 * letting a 200 imply more than happened.
 *
 * THE THREE SAFE-CAST FUNCTIONS EXIST SO ONE BAD ROW CANNOT TAKE A SCREEN DOWN.
 * The merged read evaluates `(patch->>'col')::numeric` for every row before the
 * LIMIT, so a single uncastable value — from a restored backup, a hand-written
 * UPDATE, a future importer, any path that skips the API's validation — would
 * make `GET /admin/legacy/prices` raise 22P02 for all 19,327 rows, on every page
 * and every filter, with the only recovery path being the very list that is
 * broken. Postgres 14 has no `pg_input_is_valid` (that arrived in 16), so the
 * guard is a plpgsql EXCEPTION block per non-text type, returning the STAGED
 * value on a failed cast. The API validates through Postgres's own parser at
 * write time as well, so this should be unreachable — it is the backstop, not
 * the primary defence, exactly as the 23503 catch is in src/lifecycle/delete.js.
 * A NULL input returns NULL rather than the fallback, because a JSON null is a
 * deliberate override TO null and must not silently revert to D365's value.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('d365_overrides', {
    id: 'id',
    // The READ vocabulary. See the header — this is not LEGACY_TABLES' spelling.
    entity: {
      type: 'text',
      notNull: true,
      check: "entity IN ('accounts', 'sales-orders', 'stock', 'prices')",
    },
    // The D365 record GUID, or a locally minted one when `local` is true. No FK:
    // the staging tables are re-imported wholesale and the record may not exist
    // yet.
    guid: { type: 'uuid', notNull: true },
    // Flat column -> value map. Only the keys present are overridden, which is
    // why the read tests key PRESENCE (`patch ? 'col'`) and not value nullness:
    // `->>` collapses an absent key and a JSON null into the same SQL NULL, so a
    // COALESCE could never express "clear this field".
    patch: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    // What the staging row said at the time of the last write, over ALL of the
    // entity's overridable columns. Empty for a local record — there is no
    // source to have diverged from.
    base: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    local: { type: 'boolean', notNull: true, default: false },
    archived_at: { type: 'timestamptz' },
    // An override is a business record that outlives the staff account that made
    // it and merely stops naming them — the policy trade_accounts.linked_by_user_id
    // already takes, and the reason neither is given a delete probe.
    created_by_user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    updated_by_user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // One row per record. Also the btree the merged read's join uses — the planner
  // picks it up for the `entity = $1` half, so no second index is needed.
  pgm.addConstraint('d365_overrides', 'd365_overrides_entity_guid_key', {
    unique: ['entity', 'guid'],
  })

  // Safe casts. See the header: these are the backstop that keeps one malformed
  // patch value from 500ing an entire entity listing. A failed cast degrades to
  // the staged value; a NULL input stays NULL (a deliberate override to null).
  pgm.sql(`
    CREATE FUNCTION d365_override_numeric(value text, fallback numeric)
      RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF value IS NULL THEN RETURN NULL; END IF;
      RETURN value::numeric;
    EXCEPTION WHEN others THEN
      RETURN fallback;
    END;
    $$;
  `)
  pgm.sql(`
    CREATE FUNCTION d365_override_boolean(value text, fallback boolean)
      RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF value IS NULL THEN RETURN NULL; END IF;
      RETURN value::boolean;
    EXCEPTION WHEN others THEN
      RETURN fallback;
    END;
    $$;
  `)
  // `timestamp`, not `timestamptz`, deliberately: every legacy_* time column is
  // naive because the D365 export writes Excel serials rendered in the exporting
  // user's local time, so tagging them UTC would shift every date by the NZ
  // offset. The write layer rejects a value carrying a Z or an offset for the
  // same reason — Postgres DISCARDS the offset on a ::timestamp cast rather than
  // applying it, which would silently move a corrected order date 12-13 hours.
  pgm.sql(`
    CREATE FUNCTION d365_override_timestamp(value text, fallback timestamp)
      RETURNS timestamp LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF value IS NULL THEN RETURN NULL; END IF;
      RETURN value::timestamp;
    EXCEPTION WHEN others THEN
      RETURN fallback;
    END;
    $$;
  `)
}

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql('DROP FUNCTION IF EXISTS d365_override_timestamp(text, timestamp)')
  pgm.sql('DROP FUNCTION IF EXISTS d365_override_boolean(text, boolean)')
  pgm.sql('DROP FUNCTION IF EXISTS d365_override_numeric(text, numeric)')
  pgm.dropConstraint('d365_overrides', 'd365_overrides_entity_guid_key')
  pgm.dropTable('d365_overrides')
}
