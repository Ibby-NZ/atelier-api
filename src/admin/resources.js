import { RedactedSqlResource } from './redacted-resource.js'

// Orders flow through the API state machine (/admin/orders endpoints), which
// keeps inventory reservations in sync — raw table edits would desync stock,
// so order tables are list/show only in the panel.
const READ_ONLY_ACTIONS = Object.freeze({
  new: { isAccessible: false },
  edit: { isAccessible: false },
  delete: { isAccessible: false },
  bulkDelete: { isAccessible: false },
})

const CATALOGUE = { name: 'Catalogue', icon: 'Layers' }
const STOCK = { name: 'Stock & shipping', icon: 'Package' }
const ORDERS = { name: 'Orders', icon: 'ShoppingCart' }
const PEOPLE = { name: 'People', icon: 'Users' }
const SUPPLIERS = { name: 'Suppliers', icon: 'Truck' }

export const buildAdminResources = (db) => [
  { resource: db.table('brands'), options: { navigation: CATALOGUE } },
  { resource: db.table('collections'), options: { navigation: CATALOGUE } },
  { resource: db.table('products'), options: { navigation: CATALOGUE } },
  { resource: db.table('colourways'), options: { navigation: CATALOGUE } },
  { resource: db.table('inventory'), options: { navigation: STOCK } },
  { resource: db.table('shipping_rates'), options: { navigation: STOCK } },
  { resource: db.table('price_list_items'), options: { navigation: SUPPLIERS } },
  {
    // password_hash is stripped at the query layer, not merely hidden in the UI
    // (`isVisible: false` still ships the value to the browser). Accounts are
    // created through the API so the panel cannot mint hashless users.
    resource: new RedactedSqlResource(db.table('users'), ['password_hash']),
    options: {
      navigation: PEOPLE,
      actions: { new: { isAccessible: false } },
    },
  },
  // The login → D365 customer link behind the trade client portal.
  //
  // The JSON API at /admin/trade-accounts is the intended path and belongs on
  // the CRM's Users → Applicants screen next to the approve checkbox — but that
  // screen lives in another repo, and until it exists NOTHING can create a link,
  // which leaves the portal's samples, invoices and account-manager panels
  // permanently unreachable for every client. These two resources are the
  // stopgap so the back office can operate the feature from /panel today.
  //
  // Editable, unlike orders: there is no state machine here to desync, and
  // `name_is_ambiguous` being hand-editable is safe because the client-facing
  // reads re-derive the collision check live (see trade-accounts/viewer.js)
  // rather than trusting the stored flag.
  { resource: db.table('trade_accounts'), options: { navigation: PEOPLE } },
  { resource: db.table('trade_account_users'), options: { navigation: PEOPLE } },
  { resource: db.table('orders'), options: { navigation: ORDERS, actions: READ_ONLY_ACTIONS } },
  { resource: db.table('order_lines'), options: { navigation: ORDERS, actions: READ_ONLY_ACTIONS } },
  { resource: db.table('webhook_events'), options: { navigation: ORDERS, actions: READ_ONLY_ACTIONS } },
]
