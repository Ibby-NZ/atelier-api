/**
 * The order the D365 staging entities are imported in, shared by every import
 * path (the local CLI `npm run import:legacy` and the remote push
 * `npm run push:legacy`).
 *
 * Product prices and stock items are the catalogue spine; everything else
 * references them conceptually, so they go first. Nothing here is enforced by a
 * foreign key — the staging tables are deliberately unrelated (see
 * docs/d365-export-analysis.md) — but a partial import that lands the spine
 * first reads sensibly in the CRM while the rest is still arriving.
 */
export const LEGACY_ENTITY_ORDER = Object.freeze([
  'product_prices',
  'stock_items',
  'item_locations',
  'accounts',
  'contacts',
  'sales_orders',
  'sales_invoices',
  'purchase_orders',
  'purchase_invoices',
  'reserves',
  'cuttings',
])
