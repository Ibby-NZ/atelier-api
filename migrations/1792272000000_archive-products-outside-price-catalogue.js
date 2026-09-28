/**
 * Archive what the deploy's merge raised again after 1792185600000.
 *
 * That migration archived the whole Dynamics catalogue and freed its slugs, and
 * the deploy script then ran `merge:legacy`, which made products of the D365
 * stock items under those free slugs — 3,582 of them back on live (28 Sep
 * 2026), beside the 21,082 the product prices built. The merge no longer makes
 * products once a price catalogue exists (src/legacy/merge.js); this puts the
 * ones it made away, the same way: archived, slug freed.
 *
 * Only where a price catalogue exists, so a database that has not imported the
 * product prices keeps its catalogue. A product built from a price row
 * (`product_price_id`) is never touched.
 *
 * DOWN DOES NOT UN-ARCHIVE — nothing records which rows this archived.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const ARCHIVE_OUTSIDE_PRICE_CATALOGUE = `
  UPDATE products
     SET archived_at = now(),
         slug = slug || '-archived-' || id
   WHERE archived_at IS NULL
     AND product_price_id IS NULL
     AND EXISTS (SELECT 1 FROM products WHERE product_price_id IS NOT NULL)
`

export const up = (pgm) => {
  pgm.sql(ARCHIVE_OUTSIDE_PRICE_CATALOGUE)
}

export const down = () => {}
