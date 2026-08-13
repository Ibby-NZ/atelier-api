/**
 * ██  THERE IS A DATABASE TRIGGER ON price_list_items.wholesale_rate AND ON
 * ██  products.retail_price_cents / trade_price_cents. IF YOU ARE READING THIS
 * ██  BECAUSE A WRITE FAILED WITH SQLSTATE AT001, THAT IS THIS FILE.
 *
 * Every price change on either table is recorded in the matching *_price_history
 * table by an AFTER UPDATE trigger, and a change that declares no source is
 * REFUSED — the whole statement aborts. Declare one by setting three
 * transaction-local settings before the write; `src/pricing/price-history.js`
 * (`withChangeContext` / `setChangeContext`) is the only thing that should ever
 * do it by hand.
 *
 *   SELECT set_config('atelier.change_source',  'manual', true),   -- or 'import'
 *          set_config('atelier.change_reason',  'Exchange rate', true),
 *          set_config('atelier.change_user_id', '7', true),
 *          set_config('atelier.change_source_file', '', true);     -- products only
 *
 * The third argument is `is_local = true`, so the declaration dies with the
 * transaction. It MUST stay true: pooled connections are reused, and a
 * session-level setting would silently label the next unrelated write "manual"
 * with a stale reason attached.
 *
 * WHY A TRIGGER RATHER THAN APPLICATION CODE (architecture.md ADR 007). The
 * importer writes in chunked `unnest` upserts, and `RETURNING` after
 * `ON CONFLICT DO UPDATE` hands back the NEW row, not the old — so computing the
 * delta in JS needs a second query per chunk AND only ever covers the writers
 * somebody remembered to instrument. `OLD` is free here and catches every
 * writer: the CRM, the importer, the AdminJS panel, a hand-run psql UPDATE, a
 * migration, a future route nobody has written yet.
 *
 * THE COST OF A TRIGGER IS INVISIBILITY, which this comment and one test pay
 * for: `test/price-history.test.js` issues a BARE SQL UPDATE on a raw pool
 * connection — no application code anywhere in the path — and asserts a history
 * row appeared. That assertion is the only thing that makes "every writer" true
 * rather than aspirational. It also asserts the same UPDATE with no declared
 * source raises AT001 and writes nothing.
 *
 * ONLY AN UPDATE IS CAPTURED, NEVER AN INSERT, and that is deliberate twice
 * over. A new row has no old price, so its history entry would restate
 * `price_list_items` exactly and carry no information — 19,514 rows of it on the
 * first import. And because the history FK is `ON DELETE RESTRICT`, capturing
 * inserts would make every price-list item permanently undeletable from the
 * moment it landed; refusing to delete an item whose price HAS moved is the
 * intended protection, refusing every item is a dead route. Consequence to know:
 * the as-at lookup answers out of recorded CHANGES, so an item whose rate has
 * never moved 404s and says so.
 *
 * A currency switch that leaves the NUMBER unchanged is not captured — the WHEN
 * clause watches the rate alone.
 * ponytail: widen the WHEN to the (rate, currency) pair and add old_currency /
 * new_currency columns the first time a house re-denominates without repricing.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // A price change with no declared source fails the write. AT001 is this
  // platform's own SQLSTATE (Postgres reserves the numeric classes; 'AT' is
  // free), so `src/pricing/price-history.js` maps exactly this one condition to
  // a 422 instead of catching every RAISE the database might ever make.
  pgm.sql(`
    CREATE FUNCTION capture_price_list_item_price_change()
      RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      declared_source text := NULLIF(btrim(COALESCE(current_setting('atelier.change_source', true), '')), '');
      declared_reason text := NULLIF(btrim(COALESCE(current_setting('atelier.change_reason', true), '')), '');
      declared_user   text := NULLIF(btrim(COALESCE(current_setting('atelier.change_user_id', true), '')), '');
    BEGIN
      IF declared_source IS NULL THEN
        RAISE EXCEPTION
          'Price-list item % changed rate with no declared change source, so the change cannot be recorded.',
          OLD.id
          USING ERRCODE = 'AT001',
                HINT = 'Set atelier.change_source (see src/pricing/price-history.js) in the same transaction.';
      END IF;

      -- An import cannot type a reason 19,500 times, so it gets one built from
      -- the row's own provenance. A MANUAL edit does not: leaving the reason
      -- NULL here is what lets the table's CHECK refuse it, which is the
      -- backstop behind the API's own 422.
      IF declared_reason IS NULL AND declared_source <> 'manual' THEN
        declared_reason := format(
          '%s said so (effective %s)',
          NEW.source_file,
          COALESCE(NEW.date_effective::text, 'no date stated')
        );
      END IF;

      INSERT INTO price_list_item_price_history (
        price_list_item_id, old_rate, new_rate, currency, date_effective,
        source, source_file, reason, changed_by_user_id
      ) VALUES (
        NEW.id, OLD.wholesale_rate, NEW.wholesale_rate, NEW.currency,
        NEW.date_effective, declared_source, NEW.source_file, declared_reason,
        declared_user::int
      );
      RETURN NULL;
    END;
    $$;
  `)

  // WHEN in the trigger, not an IF in the function: an import re-landing 19,500
  // unchanged rows must not pay for a function call per row.
  pgm.sql(`
    CREATE TRIGGER price_list_items_capture_price_change
      AFTER UPDATE ON price_list_items
      FOR EACH ROW
      WHEN (NEW.wholesale_rate IS DISTINCT FROM OLD.wholesale_rate)
      EXECUTE FUNCTION capture_price_list_item_price_change();
  `)

  // The product side. `source_file` has no column to come off here, so it is
  // declared alongside the source (the seed says 'seed'); everything else is
  // the same rule.
  pgm.sql(`
    CREATE FUNCTION capture_product_price_change()
      RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      declared_source text := NULLIF(btrim(COALESCE(current_setting('atelier.change_source', true), '')), '');
      declared_reason text := NULLIF(btrim(COALESCE(current_setting('atelier.change_reason', true), '')), '');
      declared_user   text := NULLIF(btrim(COALESCE(current_setting('atelier.change_user_id', true), '')), '');
      declared_file   text := NULLIF(btrim(COALESCE(current_setting('atelier.change_source_file', true), '')), '');
    BEGIN
      IF declared_source IS NULL THEN
        RAISE EXCEPTION
          'Product % changed price with no declared change source, so the change cannot be recorded.',
          OLD.id
          USING ERRCODE = 'AT001',
                HINT = 'Set atelier.change_source (see src/pricing/price-history.js) in the same transaction.';
      END IF;

      IF declared_reason IS NULL AND declared_source <> 'manual' THEN
        declared_reason := format('%s said so', COALESCE(declared_file, 'an import'));
      END IF;

      INSERT INTO product_price_history (
        product_id,
        old_retail_price_cents, new_retail_price_cents,
        old_trade_price_cents, new_trade_price_cents,
        currency, source, source_file, reason, changed_by_user_id
      ) VALUES (
        NEW.id,
        OLD.retail_price_cents, NEW.retail_price_cents,
        OLD.trade_price_cents, NEW.trade_price_cents,
        NEW.currency, declared_source, declared_file, declared_reason,
        declared_user::int
      );
      RETURN NULL;
    END;
    $$;
  `)

  pgm.sql(`
    CREATE TRIGGER products_capture_price_change
      AFTER UPDATE ON products
      FOR EACH ROW
      WHEN (
        NEW.retail_price_cents IS DISTINCT FROM OLD.retail_price_cents
        OR NEW.trade_price_cents IS DISTINCT FROM OLD.trade_price_cents
      )
      EXECUTE FUNCTION capture_product_price_change();
  `)
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS products_capture_price_change ON products')
  pgm.sql('DROP FUNCTION IF EXISTS capture_product_price_change()')
  pgm.sql(
    'DROP TRIGGER IF EXISTS price_list_items_capture_price_change ON price_list_items'
  )
  pgm.sql('DROP FUNCTION IF EXISTS capture_price_list_item_price_change()')
}
