/**
 * Generates the nine workstream directories from one spec: prd.json + CLAUDE.md each.
 *
 * Run from the api repo root:  node ralph/generate.mjs
 *
 * Re-running is safe for CLAUDE.md (always rewritten from the template) and
 * DELIBERATELY NON-DESTRUCTIVE for prd.json: an existing file keeps its
 * `passes` and `notes` values, so regenerating mid-run cannot erase progress.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RALPH_DIR = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(RALPH_DIR, 'CLAUDE.template.md'), 'utf8')
const WORKTREE_ROOT = '/Users/verumoffice/atelier-worktrees'

const API = 'atelier-api'
const CRM = 'atelier-crm'
const STORE = 'atelier-storefront'

const REPO_PATHS = Object.freeze({
  [API]: '/Users/verumoffice/atelier-api',
  [CRM]: '/Users/verumoffice/atelier-crm',
  [STORE]: '/Users/verumoffice/atelier-storefront',
})

const GATES = Object.freeze({
  [API]: '( cd atelier-api && npm run lint && npm test )',
  [CRM]: '( cd atelier-crm && npm test && npm run build )',
  [STORE]: '( cd atelier-storefront && npm run lint && npm test && npm run build )',
})

/** Gates every story must end with, per repo touched. */
const gateCriteria = (repos) => repos.map((r) => `Gates green: \`${GATES[r]}\``)

const story = (id, title, description, repos, criteria = []) => ({
  id,
  title,
  description,
  acceptanceCriteria: [...criteria, ...gateCriteria(repos)],
  repos,
})

const WORKSTREAMS = [
  {
    slug: 'w1-foundations',
    wsId: 'W1',
    name: 'Foundations',
    epic: 'Epic 1',
    db: 'atelier_w1',
    // storefront is here for US-006 (its CI workflow) and NOTHING else — see
    // the forbidden list. W7 remains the only workstream that may touch its src.
    repos: [API, CRM, STORE],
    goal:
      'The shared delete/archive lifecycle module in the API and the CRM CRUD kit that every ' +
      'other workstream consumes. Runs alone; nothing else starts until this merges.',
    requires: 'nothing — this is first',
    blocks: 'W2, W3, W4, W5, W6, W7',
    allowed: [
      'atelier-api: `src/lifecycle/**`, `test/lifecycle*.test.js`, the eight archive helpers ' +
        '(`src/catalogue/admin-brands.js`, `admin-products.js`, `src/pricing/admin-price-lists.js`, ' +
        '`src/orders/admin-orders.js`, `src/users/admin-users.js`, `src/contact/contact.js`) — ' +
        'ONLY to swap their UPDATE fragment for the shared one',
      'atelier-api: `.github/workflows/ci.yml`',
      'atelier-crm: `src/admin/list.js`, `useAdminList.js`, `Pagination.jsx`, `ConfirmDialog.jsx`, ' +
        '`deleteFlow.js`, `useCrudScreen.js` + their `.test.js` siblings; `src/lib/api.js` ' +
        '(append `apiDelete` only); `.github/workflows/ci.yml`',
      'atelier-storefront: `.github/workflows/ci.yml` ONLY — nothing else in that repo',
      'All three repos: `CLAUDE.md` under a `## Foundations` heading',
    ],
    forbidden: [
      'Any new route file or endpoint — W2 owns those. This workstream ships the mechanism, not its callers.',
      'Any migration — no schema change belongs here.',
      'Any CRM screen file (`src/screens/**`) — the kit is consumed by W2 onward.',
      'Anything in `atelier-storefront/src/**` — W7 owns that repo. You are here only for its CI workflow.',
    ],
    stories: [
      story('US-001', 'Lifecycle registry and deleteOrExplain', 'As the back office, I want a single mechanism that decides whether a row can be deleted, so that a delete can never silently destroy commercial history.', [API], [
        'A frozen registry declares table, id column, archivability and dependency probes per entity',
        'The parent row is locked SELECT ... FOR UPDATE (never FOR NO KEY UPDATE) before probes run',
        'Probes run as one round trip, each LIMIT 101, reporting { count: 100, capped: true } past that',
        'Probes count archived rows too',
        'A blocked delete returns status 409 with blockers and archivable; it is a return value, never a thrown error',
        'A pg 23503 is caught and mapped to the same 409 shape as a backstop',
        'Success is 200 { deleted: { entity, id } }',
      ]),
      story('US-002', 'setArchived replaces the eight duplicated archive helpers', 'As a maintainer, I want one archive implementation, so that the now()/NULL fragment and its 404 stop being copied per module.', [API], [
        'All eight callers delegate to setArchived and keep their own return shape',
        'The order state machine keeps withOrderTxn and its terminal-state guard',
        'Existing archive tests pass untouched — that is the proof this was a move, not a rewrite',
      ]),
      story('US-003', 'Registry safety tests', 'As a reviewer, I want the registry itself proven safe, so that a malformed probe cannot reach production.', [API], [
        'Every probe matches /^SELECT 1 FROM [a-z_ ]/ and contains exactly one $1',
        'Every relation name matches /^[a-z][a-z0-9_]*$/',
        'Every declared table and id column exists in information_schema.columns',
        'A test asserts no route registers an entity name from a path parameter',
      ]),
      story('US-004', 'CRM list kit: list.js, useAdminList, Pagination', 'As a CRM developer, I want one list hook and one paginator, so that eight new screens do not copy-paste a ninth.', [CRM], [
        'buildListQuery drops null, undefined and empty string so an "All" select never sends role=',
        'useAdminList depends on the serialised query string, not the filters object',
        'Changing a filter resets page to 1',
        'Emptying the last page steps back one page',
        'The active flag guards StrictMode double-mount',
        'Pagination returns null when totalPages <= 1',
        'Pure logic is unit-tested in .js siblings; the .jsx holds no rules',
      ]),
      story('US-005', 'CRM delete kit: ConfirmDialog, deleteFlow, useCrudScreen, apiDelete', 'As back-office staff, I want a blocked delete explained in place, so that I can archive instead without losing my place.', [CRM], [
        'apiDelete sends no body and no JSON content-type, so Fastify cannot answer FST_ERR_CTP_EMPTY_JSON_BODY',
        'There is no pre-flight can-I-delete request',
        'On 409 the dialog stays open and renders the blocker lines plus an Archive instead action',
        'describeBlockers falls back to messageOf when the body is missing',
        'ConfirmDialog sets role="dialog" aria-modal="true"; Escape cancels; focus lands on Cancel',
      ]),
      story('US-006', 'CI workflows for all three repos', 'As a reviewer, I want gates verified independently of the agent that wrote the code, so that a self-reported green is not the only evidence.', [API, CRM, STORE], [
        'Each workflow triggers on pull requests targeting august-6th-updates',
        'The api workflow runs a postgres:14 service container and sets DATABASE_URL',
        'The crm workflow runs npm test and npm run build (there is no ESLint in that repo)',
        'No workflow references a typecheck step',
        'No workflow can push or write to main/master',
      ]),
    ],
  },
  {
    slug: 'w2-crud',
    wsId: 'W2',
    name: 'CRUD completion',
    epic: 'Epic 2',
    db: 'atelier_w2',
    repos: [API, CRM],
    goal:
      'Every dataset the CRM shows gains full create, read, update and delete — including the ' +
      'DELETE endpoints the API has never had, and a standalone Collections screen.',
    requires: 'W1 merged into august-6th-updates in both repos',
    blocks: 'W5 (reporting reads these models)',
    allowed: [
      'atelier-api routes: `src/routes/admin-catalogue.js`, `admin-inventory.js`, `admin-orders.js`, ' +
        '`admin-price-lists.js`, `admin-users.js`, `src/routes/shipping.js`, `src/routes/contact.js`',
      'atelier-api modules — every domain whose entity you add a DELETE for, because the route ' +
        'needs its read model back: `src/catalogue/admin-products.js`, `admin-brands.js`, ' +
        '`src/inventory/**`, `src/shipping/rates.js`, `src/pricing/admin-price-lists.js`, ' +
        '`src/users/admin-users.js`, `src/contact/contact.js`',
      'atelier-api tests: `test/admin-*.test.js`, `test/shipping.test.js`, `test/contact.test.js`',
      'atelier-crm: `src/screens/AdminProducts.jsx`, `AdminStock.jsx`, `AdminOrders.jsx`, ' +
        '`AdminPriceListItems.jsx`, `ClientAccounts.jsx`, `UserManagement.jsx`, new ' +
        '`AdminCollections.jsx`, new `AdminShipping.jsx`; `src/App.jsx`, ' +
        '`src/components/layout.jsx`, `src/components/sectionTabs.jsx`',
      'Both repos: `CLAUDE.md` under a `## CRUD completion` heading',
    ],
    forbidden: [
      '`src/suppliers/**`, `src/routes/admin-suppliers.js`, CRM `AdminSuppliers.jsx` — owned by W3',
      'Anything in atelier-storefront, and `src/catalogue/brands.js` / `collections.js` public read models — owned by W7',
      '`src/admin/**` in the CRM and `src/lifecycle/**` in the API — owned by W1; consume them, do not edit them',
      'Any `src/reports/**` — owned by W5',
    ],
    stories: [
      story('US-001', 'DELETE for brand and collection', 'As back-office staff, I want to remove a house or collection created in error, so that test rows do not accumulate forever.', [API], [
        'Deleting a brand with products or collections returns 409 naming both counts',
        'Deleting a collection with products returns 409 — the FK is SET NULL, so without the probe it would silently uncollect them',
        'An unreferenced row is genuinely deleted and returns 200',
      ]),
      story('US-002', 'DELETE for product and colourway', 'As back-office staff, I want to remove a product that was never sold, so that the catalogue reflects reality.', [API], [
        'Order lines, samples and non-zero inventory each block with a named count',
        'Colourways and zero-quantity inventory cascade as owned children',
        'The order_lines RESTRICT edge is exercised by a test that proves the 23503 backstop produces the same 409 shape',
      ]),
      story('US-003', 'DELETE for price-list item and contact enquiry', 'As back-office staff, I want to remove a bad rate row or a spam enquiry.', [API], [
        'Neither has blockers',
        'The price-list response or docs warn that npm run import:pricing recreates the row, so archive is the durable removal',
      ]),
      story('US-004', 'DELETE for user with the self-delete guard', 'As an administrator, I want to remove an account that never transacted, so that a mistyped signup is not permanent.', [API], [
        'Orders, trade applications and contact enquiries each block',
        'Deleting yourself returns 403',
        'trade_account_users is an access grant and cascades; it does not block',
      ]),
      story('US-005', 'Missing admin reads: brand, collection, price-list item by id', 'As the CRM, I want to re-read a single row after a write, so that server-generated fields appear without a full list refresh.', [API], [
        'GET /admin/brands/:id returns the brand with its collections and counts',
        'GET /admin/collections/:id returns the collection with brand name and product count',
        'GET /admin/price-list-items/:id wires the already-exported getPriceListItem',
        'Unknown id returns 404',
      ]),
      story('US-006', 'Colourway list and detail endpoints', 'As back-office staff, I want to browse colourways directly, so that I can find a SKU without opening its product.', [API], [
        'GET /admin/colourways is paginated — this is the largest catalogue table',
        'Filters: product_id, brand_id, q, include_archived',
        'GET /admin/colourways/:id exports the currently-private getAdminColourway',
      ]),
      story('US-007', 'Shipping-rate CRUD with the last-tier guard', 'As back-office staff, I want to manage freight tiers without a redeploy.', [API], [
        'GET /admin/shipping-rates wires the already-exported listShippingRates, with id added',
        'POST returns 201; 409 on the (zone, threshold_qty) unique constraint',
        'PATCH accepts rate_cents ONLY — zone and threshold_qty are the identity key',
        'DELETE of the last tier for a zone returns 409, because an empty zone fails every checkout in it',
        'The existing bulk PUT is unchanged and its tests still pass',
      ]),
      story('US-008', 'Inventory create and delete', 'As back-office staff, I want to restore an inventory row that was removed, so that a colourway can sell again.', [API], [
        'POST /admin/inventory derives unit from the colourway product_type via UNIT_BY_PRODUCT_TYPE',
        'unit is never accepted from the client',
        '422 unknown colourway; 409 when a row already exists',
        'DELETE is refused with 409 when qty_reserved > 0, because the release join would then match nothing forever',
      ]),
      story('US-009', 'Delete on the products and houses screens', 'As back-office staff, I want a Delete action that explains itself when refused.', [CRM], [
        'Both screens use useCrudScreen from W1; no bespoke dialog or pagination is added',
        'A 409 keeps the dialog open and offers Archive instead',
      ]),
      story('US-010', 'Standalone AdminCollections screen', 'As back-office staff, I want collections managed on their own screen, so that they stop being buried inside houses.', [CRM], [
        'Route /admin/collections, filterable by brand_id',
        'COLLECTION_FIELDS moves out of AdminBrands with the panel',
        'AdminBrands keeps houses only and links each row through to its collections',
        'A collection slug is unique per brand, never globally — the screen must never assume otherwise',
      ]),
      story('US-011', 'AdminShipping screen', 'As back-office staff, I want to edit freight tiers in the CRM, because nothing edits them today.', [CRM], [
        'Create, edit rate, delete a tier',
        'The last-tier 409 is surfaced as a readable refusal',
      ]),
      story('US-012', 'Delete on stock, supplier rates, orders and users screens', 'As back-office staff, I want the same delete affordance everywhere.', [CRM], [
        'All four screens use useCrudScreen and the shared Pagination',
        'The five copy-pasted paginators are gone — grep proves it',
        'Orders offer archive only; there is no delete affordance for an order anywhere',
      ]),
    ],
  },
  {
    slug: 'w3-suppliers',
    wsId: 'W3',
    name: 'Suppliers',
    epic: 'Epic 3',
    db: 'atelier_w3',
    repos: [API, CRM],
    goal:
      'Suppliers become a first-class domain linkable to brands, and products gain the category ' +
      'column that unblocks W6.',
    requires: 'W1 merged into august-6th-updates in both repos',
    blocks: 'W6 (needs products.category)',
    allowed: [
      'atelier-api: `migrations/*suppliers*`, `migrations/*product-category*`, `src/suppliers/**`, ' +
        '`src/routes/admin-suppliers.js`, `src/seed/**` (supplier backfill only), ' +
        '`test/suppliers*.test.js`; `src/catalogue/products.js` FILTER_COLUMNS + the product ' +
        'update whitelist (category only)',
      'atelier-crm: new `src/screens/AdminSuppliers.jsx`, `src/lib/api.js` (append supplier calls only), ' +
        '`src/components/sectionTabs.jsx` (add suppliersTabs only)',
      'Both repos: `CLAUDE.md` under a `## Suppliers` heading',
    ],
    forbidden: [
      '`src/routes/admin-catalogue.js`, `admin-inventory.js`, `admin-orders.js`, `admin-price-lists.js` — owned by W2',
      'CRM `AdminProducts.jsx`, `AdminStock.jsx`, `AdminOrders.jsx`, `AdminCollections.jsx` — owned by W2',
      'CRM `AdminBrands.jsx`, `src/catalogue/brands.js`, atelier-storefront — owned by W7',
      'The existing demo `src/screens/Suppliers.jsx` — it stays as-is; add the live screen beside it',
    ],
    stories: [
      story('US-001', 'Migration: suppliers, aliases and the two FK columns', 'As the platform, I want a canonical supplier record, so that a house can be linked to who invoices it.', [API], [
        'suppliers has a unique name and slug, a d365_token, and archived_at with a partial live index',
        'currency is the supplier INVOICING currency, not the country default — Jim Thompson is Thailand but USD',
        'supplier_aliases is unique on lower(btrim(alias))',
        'brands.supplier_id references suppliers ON DELETE RESTRICT',
        'price_list_items.supplier_id references suppliers ON DELETE SET NULL, beside the retained free-text supplier',
        'NO cost column is added to brands — brand rows are served to anonymous visitors',
        'Re-running the migration is a no-op',
      ]),
      story('US-002', 'Migration: supplier brand terms and discount tiers', 'As the office, I want per-brand commercial terms recorded where they cannot leak.', [API], [
        'supplier_brand_terms holds discount, discount_chain (array) and markup, unique per brand',
        'A test proves a {0.4, 0.4} chain evaluates to x0.36, not -80%',
        'Terms tables are never joined into any client-facing read model',
      ]),
      story('US-003', 'Migration: products.category', 'As the office, I want products categorised on the same axis as supplier rates, so that the catalogue and the rate ledger are joinable.', [API], [
        "category is text with CHECK (category IN ('fabric','wallpaper','trimming','accessory'))",
        'It is nullable — existing products are uncategorised, not wrong',
        'It matches price_list_items.category exactly',
      ]),
      story('US-004', 'Supplier read models and admin module', 'As the CRM, I want to list and read suppliers.', [API], [
        'List supports q, include_archived and pagination',
        'The column whitelist is frozen and in-code, as buildUpdate requires',
        'Cost-bearing fields are present here (this is back-office only) but a test asserts they never appear in any /catalogue/* response',
      ]),
      story('US-005', 'Supplier routes including DELETE', 'As back-office staff, I want to manage suppliers and be told when one cannot be removed.', [API], [
        'requireRole backoffice on every route',
        'DELETE is blocked by brands and price_list_items, each with a count',
        'brands.supplier_id is RESTRICT, so the 23503 backstop is exercised by a test',
        'Duplicate name returns 409 from the database, never a pre-check',
      ]),
      story('US-006', 'Backfill suppliers from existing data', 'As the office, I want the supplier list populated from what we already hold, so that nobody retypes 40 names.', [API], [
        'Sources: SELECT DISTINCT price_list_items.supplier and src/seed/data/suppliers.js',
        'SUPPLIER_OVERRIDES (JV, JWall, C&C) become supplier_aliases rows',
        'price_list_items.supplier_id is populated by matching name then alias',
        'Rows that cannot be matched are reported, not guessed',
        'Re-running changes nothing',
      ]),
      story('US-007', 'AdminSuppliers CRM screen', 'As back-office staff, I want to manage suppliers in the CRM.', [CRM], [
        'Uses useAdminList, Pagination and useCrudScreen from W1',
        'The existing demo Suppliers screen is untouched and reachable via a suppliersTabs strip',
        'Cost fields respect CAPS.FINANCE_VIEW masking',
      ]),
    ],
  },
  {
    slug: 'w4-samples',
    wsId: 'W4',
    name: 'Samples',
    epic: 'Epic 4',
    db: 'atelier_w4',
    repos: [API, CRM],
    goal:
      'A real samples register and showroom stocking domain, replacing three demo screens that ' +
      'persist nothing.',
    requires: 'W1 merged; W3 merged (supplier FK)',
    blocks: 'nothing',
    allowed: [
      'atelier-api: `migrations/*samples*`, `src/samples/**`, `src/routes/admin-samples.js`, ' +
        '`test/samples*.test.js`',
      'atelier-crm: new `src/screens/AdminSamples.jsx`, `AdminShowrooms.jsx`, ' +
        '`AdminSampleOrders.jsx`, `src/screens/sampleFlow.js`; `src/screens/SampleScanner.jsx`; ' +
        '`src/App.jsx` (sample routes and redirects only), `src/components/sectionTabs.jsx` ' +
        '(samplesTabs only)',
      'Both repos: `CLAUDE.md` under a `## Samples` heading',
    ],
    forbidden: [
      'Any `legacy_*` table — adding a column there is destroyed by the next import:legacy',
      '`src/trade-accounts/**` and `src/routes/account.js` — the client portal keeps reading legacy_cuttings',
      'Anything in `src/inventory/**` or any write to inventory quantities',
      'Other workstreams\' screens and routes',
    ],
    stories: [
      story('US-001', 'Migration: showrooms and samples', 'As the office, I want a physical sample register, so that we know where every sample is.', [API], [
        'samples.barcode is unique; colourway_id is RESTRICT and nullable; supplier_id and showroom_id are SET NULL',
        'status is CHECK-constrained to in_library, out, missing, retired',
        'A test asserts no legacy_* table gained a column',
        'A test asserts samples are not inventory: no code path reads or writes qty_available or qty_reserved',
      ]),
      story('US-002', 'Migration: sample_loans with the one-open-loan index', 'As the office, I want loan history to be append-only and unambiguous.', [API], [
        'A partial unique index on sample_id WHERE returned_at IS NULL enforces at most one open loan',
        'holder_name is a snapshot, so history survives a trade account being unlinked or renamed',
        'sample_loans.sample_id is RESTRICT — history is a record, not an owned child',
        'A test proves two concurrent check-outs yield one loan and one 409',
      ]),
      story('US-003', 'Migration: sample_orders', 'As a showroom, I want to order sample material and track it.', [API], [
        'status is CHECK-constrained through requested, ordered, in_transit, received, displayed, cancelled',
        'Each transition has its own timestamp column',
        'showroom_id is RESTRICT; colourway_id is RESTRICT; supplier_id is SET NULL',
      ]),
      story('US-004', 'Sample read models, filters and overdue derivation', 'As the office, I want to see which samples are out and which are overdue.', [API], [
        'Overdue is DERIVED at read time, never stored',
        'Filters: q, status, showroom_id, supplier_id, overdue, include_archived; paginated',
        'Each row embeds its open loan and a loan count',
      ]),
      story('US-005', 'Sample CRUD routes and by-barcode lookup', 'As a scanner, I want one deterministic answer for a barcode.', [API], [
        'GET /admin/samples/by-barcode/:barcode returns 200 or 404, never a filtered list',
        'POST returns 409 on a duplicate barcode, detected by the database',
        'DELETE is blocked by sample_loans',
      ]),
      story('US-006', 'Check-out and check-in verb routes', 'As showroom staff, I want to send a sample out and take it back in.', [API], [
        'Both are verb routes, not a status PATCH — each writes two tables in one transaction',
        'withSampleTxn mirrors withOrderTxn: BEGIN, SELECT FOR UPDATE, run, COMMIT, re-read',
        'Already out returns 409 from a caught 23505 on the partial index, never a pre-check',
        'Check-in of a sample that is not out returns 409',
      ]),
      story('US-007', 'Sample-order lifecycle module and routes', 'As a showroom, I want to advance an order through its states.', [API], [
        'ALLOWED_TRANSITIONS and requireStatus live in a module the CRM mirrors',
        'An invalid transition returns 409',
        'DELETE is refused unless the order is requested or cancelled',
      ]),
      story('US-008', 'AdminSamples and AdminShowrooms screens', 'As the office, I want to manage the register in the CRM.', [CRM], [
        'Both use the W1 kit',
        'Overdue is shown from the API value, not recomputed in the browser',
        'legacy_cuttings.comments is never displayed — it holds third parties personal data',
      ]),
      story('US-009', 'AdminSampleOrders, live scanner, retired-route redirects', 'As showroom staff, I want the scanner to actually record a movement.', [CRM], [
        'SampleScanner calls by-barcode then check-out or check-in',
        'sampleFlow.js mirrors the API transitions so the UI never offers one that 409s',
        '/samples and /showroom-samples redirect to the live screens rather than falling into the catch-all',
      ]),
    ],
  },
  {
    slug: 'w5-reporting',
    wsId: 'W5',
    name: 'Reporting',
    epic: 'Epic 5',
    db: 'atelier_w5',
    repos: [API, CRM],
    goal:
      'Real aggregation endpoints with filter-before-export, product performance by brand, and ' +
      'server-side masking that actually fires.',
    requires: 'W2 merged (read models), W3 merged (suppliers and category)',
    blocks: 'nothing',
    allowed: [
      'atelier-api: `src/lib/csv.js`, `src/reports/**`, `src/routes/admin-reports.js`, ' +
        '`migrations/*reporting*`, `migrations/*finance-access*`, `test/admin-reports.test.js`, ' +
        '`test/report-filters.test.js`; `src/routes/auth.js` + `src/auth/user-columns.js` ' +
        '(report_access only); `src/users/admin-users.js` (can_view_finance whitelist only)',
      'atelier-crm: `src/screens/Reporting.jsx`, `ReportLibrary.jsx`, `src/utils/reportBuilders.js`, ' +
        '`src/utils/exporters.js`, `src/auth/reportPolicy.js`, `src/auth/roles.js`, ' +
        '`src/auth/AuthContext.jsx`',
      'Both repos: `CLAUDE.md` under a `## Reporting` heading',
    ],
    forbidden: [
      'Any catalogue, orders, suppliers or samples route — read them, do not change them',
      'Anything in atelier-storefront',
      '`src/pricing/trade-price-lists.js` beyond importing the extracted CSV helpers',
    ],
    stories: [
      story('US-001', 'Extract the hardened CSV writer to src/lib/csv.js', 'As a maintainer, I want one CSV writer, so that the formula-injection guard is not forked.', [API], [
        'FORMULA_PREFIXES, csvCell and csvRow move verbatim, comments included',
        'trade-price-lists.js imports them and keeps CSV_HEADER and csvFilename unchanged',
        'test/price-list-exposure.test.js passes untouched — that is the proof this was a move',
      ]),
      story('US-002', 'Migration: reporting index and finance access', 'As the platform, I want date-ranged reports to scan efficiently and finance visibility to be explicit.', [API], [
        'An index on orders.created_at — the date range is the primary scan and only user_id and status are indexed today',
        'users.can_view_finance boolean NOT NULL DEFAULT false, backfilled true for directors',
        'It joins the PATCH whitelist with the same discipline as trade_approved: moving a role off backoffice/director clears it',
      ]),
      story('US-003', 'Report filter layer', 'As back-office staff, I want to narrow a report before I export it.', [API], [
        'A frozen whitelist maps filter names to trusted columns; values are always $n placeholders',
        'Filters: from, to, brand (multi), product_type, collection, kind, status',
        'The module is pure with no database access and is unit-tested',
        'An unknown filter name is ignored; an invalid value is a 400 naming it',
      ]),
      story('US-004', 'Revenue scope CTE and the masking module', 'As a director, I want cost figures hidden from staff who may not see them.', [API], [
        'The scope CTE is the seam where future D365 line data unions in',
        'Default population is status IN (paid, shipped), all kinds, overridable by filter',
        'Request-kind lines contribute quantity at zero value with an unpriced_lines count',
        'Finance columns are DELETED from columns, every row and totals — not nulled',
        'meta.masked_columns carries labels only',
        'A finance-end-to-end report answers 403 with a reason, never 200 with an empty table',
        'Access is derived from request.user only — never a query param, header or body value',
      ]),
      story('US-005', 'Product performance by brand', 'As a director, I want to see which houses and designs sell, so that buying decisions have evidence.', [API], [
        'Grouped by brand and product, summing qty and qty x unit_price_cents',
        'The response envelope is consumable by the CRM buildReport cell pipeline without rewriting reportBuilders.js',
        'The payload states its coverage window and that historic D365 data is header-only, so no pre-launch sale is included',
        'Rate-limited',
      ]),
      story('US-006', 'Server-side CSV export', 'As back-office staff, I want the exported file to match what I filtered.', [API], [
        'The export shares one query builder with the table, so they cannot disagree',
        'It is NOT limited to the current page',
        'export.csv is its own path segment, never a suffix on a param',
        'maskReport runs before the writer sees a row; a non-finance caller gets no finance header',
        'A product name beginning = is neutralised',
        'A tighter rate-limit bucket than the read routes',
      ]),
      story('US-007', 'Stock and not-invoiced reports', 'As the office, I want the two live-data reports the current fixtures only pretend to show.', [API], [
        'Stock reads live inventory; not-invoiced reads live orders',
        'Both accept the shared filter layer and both export',
      ]),
      story('US-008', 'report_access on /auth/me and CRM consumption', 'As a director, I want the CRM to know what a login may see, because today it assumes everyone is a director.', [API, CRM], [
        'GET /auth/me returns a DERIVED report_access; it is never stored on the session',
        'accessOf prefers user.report_access and falls back to the demo caps so offline and break-glass still work',
        'The CRM reports screen reads the live endpoints and shows the masked-columns note',
        'A masked table is visibly labelled partial, never silently short',
      ]),
    ],
  },
  {
    slug: 'w6-category-export',
    readOnlyIncoming: 'colour-files',
    wsId: 'W6',
    name: 'Category export',
    epic: 'Epic 6',
    db: 'atelier_w6',
    repos: [API, CRM],
    goal:
      'A spreadsheet round trip letting the office assign product categories, generalised into a ' +
      'reusable per-brand template.',
    requires: 'W3 merged (products.category)',
    blocks: 'nothing',
    allowed: [
      'atelier-api: `src/lib/csv-text.js`, `src/products/product-sheet.js`, ' +
        '`src/routes/admin-product-sheet.js`, `scripts/lib/text.js` (re-export only), ' +
        '`test/product-sheet.test.js`',
      'atelier-crm: new `src/screens/AdminProductSheet.jsx` + a pure sibling module, ' +
        '`src/lib/api.js` (append only)',
      'Both repos: `CLAUDE.md` under a `## Category export` heading',
    ],
    forbidden: [
      '`src/reports/**` — owned by W5',
      'Any migration — products.category arrives with W3',
      'Other workstreams\' screens and routes',
      '`src/seed/data/price-lists.json` — never regenerate it in this workstream',
    ],
    stories: [
      story('US-001', 'Extract the encoding-sniffing CSV reader', 'As a maintainer, I want one CSV reader, so that the encoding sniff is not reimplemented.', [API], [
        'decodeText and csvRows move verbatim to src/lib/csv-text.js',
        'scripts/lib/text.js re-exports them',
        'test/converters.test.js passes unchanged — that is the proof this was a move',
        'npm run convert:pricing still produces a byte-identical price-lists.json',
      ]),
      story('US-002', 'Product sheet export with an empty Category column', 'As the office, I want a spreadsheet I can fill in, so that categorising products does not need a developer.', [API], [
        'Defaults to brand atelier-textiles-nz and accepts any ?brand=',
        'The header row is a documented contract, with Category present and empty',
        'A stable server key is included so re-import never depends on row order',
        'Uses the hardened CSV writer; a staff-typed name beginning = is neutralised',
        'The filename derives from the brand slug, so nothing user-typed reaches the header',
      ]),
      story('US-003', 'Re-import parse and validate', 'As the office, I want to be told exactly what is wrong before anything is written.', [API], [
        'A file saved by Excel on Windows (cp1252) parses correctly',
        'An unknown category value is reported with its row number',
        'An unmatched key is reported, not guessed',
        'Nothing is written when any row fails',
      ]),
      story('US-004', 'Apply validated categories', 'As the office, I want my edits to land.', [API], [
        'All updates run in one transaction',
        'The response reports counts changed, unchanged and skipped',
        'Re-uploading the same file changes nothing',
      ]),
      story('US-005', 'CRM export and import panel', 'As the office, I want to do this from the CRM.', [CRM], [
        'Download, then upload with a validation report shown before applying',
        'The brand selector makes the template generalisation visible',
      ]),
    ],
  },
  {
    slug: 'w7-featured',
    wsId: 'W7',
    name: 'Featured',
    epic: 'Epic 7',
    db: 'atelier_w7',
    repos: [API, CRM, STORE],
    goal:
      'The office controls which houses and collections the storefront features, replacing ' +
      'hardcoded slug arrays.',
    requires: 'W1 merged',
    blocks: 'nothing',
    allowed: [
      'atelier-api: `migrations/*featured*`, `src/catalogue/brands.js`, `src/catalogue/collections.js`, ' +
        '`src/catalogue/admin-brands.js` (featured columns and the reorder functions only), ' +
        '`src/routes/catalogue.js`, `src/routes/admin-catalogue.js` (featured endpoints only), ' +
        '`test/featured*.test.js`, `test/seed.test.js` (the reseed assertion only)',
      'atelier-crm: `src/screens/AdminBrands.jsx`, new `src/screens/featuredOrder.js` + test',
      'atelier-storefront: anything — this is the ONLY workstream permitted to touch it',
      'All three repos: `CLAUDE.md` under a `## Featured` heading',
    ],
    forbidden: [
      'CRM `AdminProducts.jsx`, `AdminStock.jsx`, `AdminOrders.jsx`, `AdminCollections.jsx` — owned by W2',
      '`src/suppliers/**` — owned by W3',
      'Any delete endpoint — owned by W2',
    ],
    stories: [
      story('US-001', 'Migration: featured_rank on brands and collections', 'As the office, I want to choose what the storefront features, in an order I control.', [API], [
        'featured_rank integer NULL on both tables, with a CHECK that it is null or positive',
        'NULL means not featured',
        'The migration seeds the storefront current hardcoded choice so nothing moves on deploy',
        'The seeding UPDATE matches on (brand_slug, slug) PAIRS — collection slugs are unique per brand, never globally',
        'A test with two houses sharing a collection slug proves only the intended one is featured',
      ]),
      story('US-002', 'Admin patch support and whole-list reorder endpoints', 'As the office, I want to set and reorder the featured lists.', [API], [
        'featured_rank joins the brand and collection update whitelists',
        'It is absent from create — a house is not featured at birth',
        'An explicit null clears it, distinct from an absent key',
        'PUT /admin/brands/featured takes slugs; PUT /admin/collections/featured takes brand+slug PAIRS',
        'An unknown slug returns 422 naming it, never a silent drop',
        'Each is one transaction that clears then re-applies',
      ]),
      story('US-003', 'Public read-model ordering', 'As a visitor, I want the featured houses and collections first.', [API], [
        'ORDER BY featured_rank ASC NULLS LAST, name ASC, id ASC — deterministic even with duplicate ranks',
        'No unique index is added',
        'Featuring interacts correctly with trade_only: a featured house a guest cannot see leaves no hole',
        'featured_rank is exposed on both public read models',
      ]),
      story('US-004', 'Seed test: featured survives a reseed', 'As the office, I want my featuring decision to outlive a catalogue reseed.', [API], [
        'featured_rank is absent from the upsert DO UPDATE set lists',
        'A test seeds, features a house, reseeds and asserts the rank is unchanged',
        'The test names the same posture as trade_only, inventory and shipping_rates',
      ]),
      story('US-005', 'CRM featured panel', 'As the office, I want to reorder featuring without a developer.', [CRM], [
        'Ordering logic is pure in featuredOrder.js with a .test.js sibling',
        'Move up and down behave correctly at the ends; duplicates are impossible; the list is capped',
        'A standing note states that featured houses appear on /brands immediately while featured collections appear at the next site build',
      ]),
      story('US-006', 'Storefront homepage reads featured', 'As the office, I want the homepage to follow my choice.', [STORE], [
        'FEATURED_COLLECTIONS, FEATURED_SLUG and LATEST_SLUGS are gone',
        'The hero takes the first three featured collections in rank order',
        'A featured collection with no committed artwork renders a defined fallback, never a broken image',
        'The page keeps prerender = true and the build still survives an API outage via safeFetch',
      ]),
      story('US-007', 'Storefront brands page reads featured', 'As a visitor, I want the In focus strip to reflect the office choice, not a derived guess.', [STORE], [
        'The In focus strip reads featured_rank instead of the is_international and design-count heuristic',
        'The full directory below stays alphabetical',
        'The artwork fallback chain applies here too',
      ]),
    ],
  },
  {
    slug: 'w10-pricing-template',
    wsId: 'W10',
    name: 'Pricing template',
    epic: 'Epic 10',
    db: 'atelier_w10',
    repos: [API],
    goal:
      'One universal pricing template for every supplier going forward: v2 as a strict superset ' +
      'of the existing 14 columns, versioned by its header row so v1 drops keep importing forever.',
    requires: 'nothing — runs in Wave 1 alongside W1; the file footprints are disjoint',
    blocks: 'W8 (its rate output is emitted in this template shape)',
    allowed: [
      'atelier-api: `scripts/lib/price-template.js`, `scripts/convert-price-lists.js`, ' +
        '`migrations/*price-list-template*`, `src/seed/price-lists.js`, ' +
        '`src/seed/import-price-lists.js`, `src/routes/admin-price-lists.js` (vocabulary + new ' +
        'columns only), `src/pricing/admin-price-lists.js` (column whitelist only), ' +
        '`test/price-template.test.js`, `test/price-lists.test.js`, `test/converters.test.js`',
      'atelier-api: `CLAUDE.md` under a `## Pricing template` heading',
    ],
    forbidden: [
      '**`src/seed/data/price-lists.json` — NEVER regenerate it in this workstream.** The committed ' +
        '8 MB file must stay byte-identical; a data refresh is a separate commit touching only that file.',
      '`scripts/convert-d365-exports.js` and `scripts/convert-colour-files.js` — the latter is W8',
      'Any route or module outside the price-list ones listed above',
      'Anything in atelier-crm or atelier-storefront',
    ],
    stories: [
      story('US-001', 'Migration: price_list_items v2 columns', 'As the office, I want the template to carry brand, pattern match and duty percent, so that the fields the client asked for have a home.', [API], [
        'Adds brand_name text, pattern_match text, duty_percent numeric(6,3), template_version text NOT NULL DEFAULT v1',
        'brand_name is TEXT and deliberately NOT a foreign key to brands — supplier names do not reliably match the 41 houses and a broken FK would fail whole imports over a naming difference',
        'Widens the freight_class CHECK to a single uppercase letter (^[A-Z]$) and adds the same for duty_class',
        'Those sets today encode a guess about a broker table we do not have; the first B from the broker would otherwise reject the client own file as a bug in ours',
        'No placeholder duty or freight VALUE is written anywhere — the letters stay raw and uninterpreted',
        'Re-running the migration is a no-op',
      ]),
      story('US-002', 'Template registry with v1 moved verbatim', 'As a maintainer, I want the accepted headers declared in one place, so that adding v3 is one entry.', [API], [
        'scripts/lib/price-template.js exports TEMPLATES as a frozen array of { version, header, map }',
        'THE HEADER ROW IS THE VERSION — no version column, no preamble line, no marker cell. A version column can be misdeclared by deleting a column; a header mismatch fails loudly',
        'matchTemplate normalises labels (lowercase, collapsed whitespace) and matches EXACTLY on length and labels; first match wins',
        'No match produces the existing loud error, now listing every accepted header',
        'mapV1 is the current normaliseRow MOVED, not rewritten — same emitted key order, same cleanMeasure/round4/generalFormat calls',
      ]),
      story('US-003', 'v2 mapping and the omit-on-v1 rule', 'As the platform, I want v2 files to import without disturbing a single v1 row.', [API], [
        'v2 appends Supplier, Brand, Pattern Match and Duty Percent to the 14 v1 columns, in that order',
        'A Supplier cell WINS over the filename, removing the most fragile input in the pipeline',
        'v2-only fields are OMITTED ENTIRELY on v1 rows, never written as null — writing null would grow all 19.5k committed records and make the next regeneration a total diff',
        'A comment states that reason at the emit site, or someone will tidy it into explicit nulls',
        'npm run convert:pricing still produces a byte-identical src/seed/data/price-lists.json',
      ]),
      story('US-004', 'Importer accepts the v2 fields', 'As the platform, I want v2 rows to land with their new columns.', [API], [
        'validatePriceListItems accepts and validates the four new fields before any SQL',
        'template_version uses COALESCE — unnest binds an explicit NULL for a missing key, which DEFEATS the column DEFAULT and would write NULL into a NOT NULL column',
        'The upsert key stays (supplier, category, code)',
        'A v1 import is unchanged; a re-import is still how new season rates land',
      ]),
      story('US-005', 'Shared vocabulary module', 'As a maintainer, I want the enum vocabularies in one place, because they are currently duplicated by hand in at least three.', [API], [
        'Item type, pack type and currency vocabularies live in price-template.js and are imported by the converter, src/seed/price-lists.js and src/routes/admin-price-lists.js',
        'Pack type gains p/hide and p/panel — both already exist in the DB CHECK with no template rows yet',
        'Currency accepts ISO codes as INPUT ALIASES only; the stored value set is NOT widened',
        'A comment lists all four places that must change in lockstep to add a currency: the DB CHECK, CURRENCIES, CURRENCY_MAP and CURRENCY_ENUM',
        'Added aliases can only ADD successful mappings — verify against the corpus that no existing row uses them, so the committed JSON is untouched',
      ]),
      story('US-006', 'Byte-pin unit test and regeneration tripwire', 'As a reviewer, I want converter drift caught without regenerating 8 MB.', [API], [
        'A test asserts dumps(mapV1(sampleRow)) equals a hardcoded string — a unit-level byte pin catching key-order or float-format drift',
        'A tripwire test asserts the first item of the committed price-lists.json carries NONE of the four v2 keys, so a buggy v2 mapper that regenerated the file fails immediately',
        'CLAUDE.md is updated: v1 output is byte-pinned and the Python-faithful float formatting stays because the 19.5k committed rows were produced by it; v2 rows are new output pinned to the Node implementation',
        'CLAUDE.md records that regenerating price-lists.json happens in its own commit, converter unchanged',
      ]),
    ],
  },
  {
    slug: 'w8-colour-files',
    readOnlyIncoming: 'colour-files',
    wsId: 'W8',
    name: 'Colour files',
    epic: 'Epic 8',
    db: 'atelier_w8',
    repos: [API],
    goal:
      'Import the 18 supplier colour spreadsheets into the colourway catalogue, with 2026 rates ' +
      'as a secondary output.',
    requires: 'W10 Pricing template merged — its rate output is emitted in that template shape',
    blocks: 'nothing',
    allowed: [
      'atelier-api: `scripts/convert-colour-files.js`, `scripts/lib/colour-adapters/**`, ' +
        '`scripts/lib/colour-sheet.js`, `src/seed/import-colourways.js`, ' +
        '`src/seed/colourways-import.js`, `test/colour-files.test.js`, `package.json` (scripts only)',
      'atelier-api: `CLAUDE.md` under a `## Colour files` heading',
    ],
    forbidden: [
      '`scripts/convert-price-lists.js` and `scripts/convert-d365-exports.js` — read them as reference, do not change them',
      '`src/seed/data/price-lists.json` — never regenerate it here',
      'Any route, any migration, any CRM file',
      '`atelier-api/incoming/**` is READ ONLY — it is the client\'s only copy',
    ],
    stories: [
      story('US-001', 'Adapter registry and the row-extraction harness', 'As the platform, I want each supplier layout declared rather than guessed.', [API], [
        'A registry keyed by filename prefix declares sheet names, header row and column map',
        'The header row is located by MATCHING LABELS, never a fixed index — Jim Thompson header is on row 2, Clarence House is buried under terms text',
        'The harness reuses scripts/lib/{zip,xml,xlsx,text}.js and adds no dependency',
        'An unknown file is reported as unsupported, never silently skipped',
      ]),
      story('US-002', 'Adapters for the single-sheet, single-brand files', 'As the platform, I want the straightforward files importing first.', [API], [
        'Covers at least Jean Monro, Madeaux, Liberty, Maria Flora and the Perennials pair',
        'Each adapter yields brand, design, supplier colour code and colour name',
        'A fixture test asserts the first three rows of each file map correctly',
      ]),
      story('US-003', 'Adapters for the multi-sheet and multi-brand files', 'As the platform, I want the awkward files handled explicitly.', [API], [
        'Colefax carries four brands in one sheet, keyed by its Brand column',
        'Jannelli & Volpi spans ten sheets and eight brands',
        'Pierre Frey carries five houses; Jim Thompson has a banner row above the header',
        'Clarence House has two sheets and a terms preamble',
        'The de Le Cuona PDF is reported as unsupported with a clear reason',
      ]),
      story('US-004', 'Normalised output, loud failure, per-file summary', 'As an operator, I want a run that either succeeds completely or tells me exactly what is wrong.', [API], [
        'Any unmappable row aborts THAT FILE with a file:sheet:row list and writes nothing',
        'A summary reports rows in, colourways out, and skips by reason',
        'Output lands under incoming/ (gitignored), never in src/seed/data/ — this is client data',
      ]),
      story('US-005', 'Rates as a secondary output', 'As the office, I want the 2026 rates these files carry, in the pricing template shape.', [API], [
        'Rate rows are emitted in the universal template column order',
        'A row with no usable rate is skipped and counted, not defaulted to zero',
        'duty and freight class letters are carried RAW and uninterpreted — no placeholder is invented',
      ]),
      story('US-006', 'Import colourways into products and colourways', 'As the platform, I want the extracted colourways in the database.', [API], [
        'Upserts on the colourway SKU, matching the existing seed posture',
        'The supplier colour code is NEVER joined to price_list_items.code — they are different codes',
        'Validation rejects the batch before any SQL, as the legacy import does',
        'The whole import is one transaction and re-running changes nothing',
        'Brands that do not exist are reported, never created silently',
      ]),
    ],
  },
  {
    slug: 'w9-scanner-spike',
    wsId: 'W9',
    name: 'Scanner spike',
    epic: 'Epic 9',
    db: 'atelier_w9',
    repos: [API],
    goal:
      'A written recommendation on sample and showroom-sample scanning. Research only — no code. ' +
      'DO NOT RUN THIS UNDER RALPH: a research task has no gates, so a loop has nothing to verify ' +
      'against. Run it as one supervised session.',
    requires: 'nothing',
    blocks: 'nothing',
    allowed: [
      'atelier-api: `_bmad-output/planning-artifacts/research-sample-scanner.md`, ' +
        '`_bmad-output/planning-artifacts/architecture.md` (append the ADR only)',
    ],
    forbidden: ['All source code, in every repo. This workstream writes documents.'],
    stories: [
      story('US-001', 'Options matrix', 'As the office, I want to know what scanning actually costs and requires.', [API], [
        'Covers off-the-shelf scanner apps, a PWA using BarcodeDetector and getUserMedia, and native',
        'Each option states hardware, offline behaviour, cost and integration effort',
        'Accounts for the existing SampleScanner.jsx phone-frame preview',
      ]),
      story('US-002', 'Recommendation', 'As the office, I want a decision I can act on.', [API], [
        'One recommendation, with the conditions under which it holds',
        'Names what would have to be true for each rejected option to win',
        'References W4 GET /admin/samples/by-barcode/:barcode as the integration point',
      ]),
      story('US-003', 'ADR appended to architecture.md', 'As a future maintainer, I want the reasoning recorded.', [API], [
        'Context, decision, consequences',
        'Dated and linked to the research document',
      ]),
    ],
  },
]

// ---------------------------------------------------------------------------

const repoRow = (repo, slug) => `| \`${repo}/\` | ${repo} | \`aug6/${slug}\` |`

const renderPrompt = (ws) => {
  const repoTable = [
    '| Path | Repo | Branch |',
    '|---|---|---|',
    ...ws.repos.map((r) => repoRow(r, ws.slug)),
  ].join('\n')

  const extraReads = ws.repos
    .filter((r) => r !== API)
    .map((r) => `4b. \`${r}/CLAUDE.md\` — ${r === CRM ? 'CRM' : 'storefront'} conventions`)
    .join('\n')

  const gateBlock = ['```bash', ...ws.repos.map((r) => GATES[r]), '```'].join('\n')

  return TEMPLATE.replaceAll('{{WS_ID}}', ws.wsId)
    .replaceAll('{{WS_NAME}}', ws.name)
    .replaceAll('{{WS_SLUG}}', ws.slug)
    .replaceAll('{{ROOT}}', `${WORKTREE_ROOT}/${ws.slug}`)
    .replaceAll('{{REPO_TABLE}}', repoTable)
    .replaceAll('{{EXTRA_READS}}', extraReads)
    .replaceAll('{{EPIC_REF}}', ws.epic)
    .replaceAll('{{ALLOWED_PATHS}}', ws.allowed.map((p) => `- ${p}`).join('\n'))
    .replaceAll('{{FORBIDDEN_PATHS}}', ws.forbidden.map((p) => `- ${p}`).join('\n'))
    .replaceAll('{{GATE_BLOCK}}', gateBlock)
    .replaceAll('{{DB_NAME}}', ws.db)
    .replaceAll('{{SCOPE}}', ws.repos.length === 1 ? 'api' : 'api|crm|store')
    .replaceAll('{{N}}', String(ws.stories.length))
}

/**
 * Block A as an executable script rather than a fenced block to paste.
 *
 * Pasting a fenced block into bash opens a backtick command substitution and
 * swallows the whole thing, which silently half-executes the setup: the
 * worktrees and the .env copy land, the createdb and the DATABASE_URL rewrite
 * do not, and the loop then migrates the SHARED dev database. That happened.
 * Hence: one command, `set -e`, and a final assertion.
 */
const renderSetup = (ws) => {
  const L = []
  L.push('#!/bin/bash')
  L.push(`# Setup for ${ws.wsId} ${ws.name}. Run it once, from anywhere:`)
  L.push(`#   /Users/verumoffice/atelier-api/ralph/${ws.slug}/setup.sh`)
  L.push('#')
  L.push('# Do NOT copy-paste this file into a terminal. Run it.')
  L.push('set -euo pipefail')
  L.push('')
  L.push(`WS=${ws.slug}`)
  L.push(`DB=${ws.db}`)
  L.push(`ROOT=${WORKTREE_ROOT}/$WS`)
  L.push('')
  L.push('if [ -e "$ROOT" ]; then')
  L.push('  echo "$ROOT already exists. Remove it first, or run teardown.sh." >&2')
  L.push('  exit 1')
  L.push('fi')
  L.push('mkdir -p "$ROOT"')
  L.push('')
  L.push('echo "==> worktrees"')
  for (const r of ws.repos) {
    L.push(`git -C ${REPO_PATHS[r]} worktree add -b "aug6/$WS" "$ROOT/${r}" august-6th-updates`)
  }
  L.push('')
  L.push('echo "==> node_modules symlinks (a story needing a NEW dependency must mark itself BLOCKED)"')
  for (const r of ws.repos) {
    L.push(`ln -s ${REPO_PATHS[r]}/node_modules "$ROOT/${r}/node_modules"`)
  }
  L.push('')
  L.push('echo "==> .env (gitignored, so a worktree does not inherit it)"')
  L.push(`cp ${REPO_PATHS[API]}/.env "$ROOT/atelier-api/.env"`)
  if (ws.readOnlyIncoming) {
    L.push('')
    L.push('echo "==> incoming/ as a READ-ONLY copy — the client\'s only copy of this data"')
    L.push('mkdir -p "$ROOT/atelier-api/incoming"')
    L.push(`cp -R ${REPO_PATHS[API]}/incoming/${ws.readOnlyIncoming} "$ROOT/atelier-api/incoming/"`)
    // Protect the FILES, not the directories. The converters write their
    // normalised output into a subdirectory of incoming/, so a blanket
    // `chmod -R a-w` blocks the mkdir and the run dies EACCES — which looks
    // like a converter bug and is not one.
    L.push('find "$ROOT/atelier-api/incoming" -type f -exec chmod a-w {} +')
  }
  L.push('')
  L.push('echo "==> database (never share atelier_dev between concurrent loops)"')
  L.push('createdb "$DB" 2>/dev/null || echo "    $DB already exists, reusing"')
  L.push('sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/$DB|" "$ROOT/atelier-api/.env"')
  L.push('')
  L.push('# The failure this script exists to prevent: a half-run setup leaves .env')
  L.push('# pointing at atelier_dev and the loop migrates the shared database.')
  L.push('if ! grep -q "^DATABASE_URL=postgresql://localhost:5432/$DB$" "$ROOT/atelier-api/.env"; then')
  L.push('  echo "FATAL: DATABASE_URL was not rewritten to $DB. Refusing to continue." >&2')
  L.push('  grep "^DATABASE_URL=" "$ROOT/atelier-api/.env" >&2')
  L.push('  exit 1')
  L.push('fi')
  L.push('( cd "$ROOT/atelier-api" && npm run migrate )')
  L.push('')
  L.push('echo "==> gates (must be green BEFORE the loop starts)"')
  L.push('cd "$ROOT"')
  for (const r of ws.repos) L.push(GATES[r])
  L.push('')
  L.push('echo ""')
  L.push('echo "Ready. Launch with:"')
  L.push(`echo "  cd $ROOT"`)
  L.push(`echo "  ./atelier-api/ralph/ralph.sh $WS ${Math.ceil(ws.stories.length * 1.5)}"`)
  return L.join('\n') + '\n'
}

const renderTeardown = (ws) => {
  const L = []
  L.push('#!/bin/bash')
  L.push(`# Teardown for ${ws.wsId} ${ws.name}. Run AFTER the branch is merged.`)
  L.push('set -euo pipefail')
  L.push('')
  L.push(`WS=${ws.slug}`)
  L.push(`DB=${ws.db}`)
  L.push(`ROOT=${WORKTREE_ROOT}/$WS`)
  L.push('')
  L.push('# Refuse to discard unmerged work.')
  for (const r of ws.repos) {
    L.push(`if [ -d "$ROOT/${r}" ]; then`)
    L.push(`  if [ -n "$(git -C "$ROOT/${r}" status --porcelain)" ]; then`)
    L.push(`    echo "${r} has uncommitted changes. Refusing." >&2; exit 1`)
    L.push('  fi')
    L.push(`  if [ -n "$(git -C "$ROOT/${r}" log --oneline august-6th-updates..HEAD)" ]; then`)
    L.push(`    echo "${r} has commits not in august-6th-updates. Merge first, or delete by hand." >&2; exit 1`)
    L.push('  fi')
    L.push('fi')
  }
  L.push('')
  // Delete the branch too. `worktree add -b` creates it, so leaving it behind
  // makes a later re-run of setup.sh fail with "branch already exists". The
  // unmerged-commit checks above are what make this safe.
  for (const r of ws.repos) {
    L.push(`git -C ${REPO_PATHS[r]} worktree remove "$ROOT/${r}" 2>/dev/null || true`)
    L.push(`git -C ${REPO_PATHS[r]} branch -D "aug6/$WS" 2>/dev/null || true`)
  }
  L.push('dropdb "$DB" 2>/dev/null || true')
  L.push('rmdir "$ROOT" 2>/dev/null || true')
  L.push('echo "Removed $ROOT and database $DB."')
  return L.join('\n') + '\n'
}

const renderPrd = (ws, existing) => {
  const priorState = new Map(
    (existing?.userStories ?? []).map((s) => [s.id, { passes: s.passes, notes: s.notes }]),
  )
  return {
    project: `Atelier — August 6th updates — ${ws.wsId} ${ws.name}`,
    branchName: `aug6/${ws.slug}`,
    description:
      `${ws.goal}\n\n` +
      `Epic: _bmad-output/planning-artifacts/epics.md (${ws.epic})\n` +
      `Architecture: _bmad-output/planning-artifacts/architecture.md\n` +
      `Requires: ${ws.requires}\n` +
      `Blocks: ${ws.blocks}`,
    userStories: ws.stories.map((s, i) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      repos: s.repos,
      priority: i + 1,
      passes: priorState.get(s.id)?.passes ?? false,
      notes: priorState.get(s.id)?.notes ?? '',
    })),
  }
}

let written = 0
for (const ws of WORKSTREAMS) {
  const dir = join(RALPH_DIR, ws.slug)
  mkdirSync(dir, { recursive: true })

  const prdPath = join(dir, 'prd.json')
  const existing = existsSync(prdPath) ? JSON.parse(readFileSync(prdPath, 'utf8')) : null
  writeFileSync(prdPath, `${JSON.stringify(renderPrd(ws, existing), null, 2)}\n`)
  writeFileSync(join(dir, 'CLAUDE.md'), renderPrompt(ws))
  for (const [file, body] of [['setup.sh', renderSetup(ws)], ['teardown.sh', renderTeardown(ws)]]) {
    const path = join(dir, file)
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }
  written += 4

  const total = ws.stories.length
  console.log(
    `${ws.slug.padEnd(20)} ${String(total).padStart(2)} stories  ` +
      `repos: ${ws.repos.map((r) => r.replace('atelier-', '')).join('+')}  ` +
      `db: ${ws.db}  suggested max_iterations: ${Math.ceil(total * 1.5)}`,
  )
}
console.log(`\n${written} files written across ${WORKSTREAMS.length} workstreams.`)
console.log(`Total stories: ${WORKSTREAMS.reduce((n, w) => n + w.stories.length, 0)}`)
