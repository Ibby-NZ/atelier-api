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
  { resource: db.table('orders'), options: { navigation: ORDERS, actions: READ_ONLY_ACTIONS } },
  { resource: db.table('order_lines'), options: { navigation: ORDERS, actions: READ_ONLY_ACTIONS } },
  { resource: db.table('webhook_events'), options: { navigation: ORDERS, actions: READ_ONLY_ACTIONS } },
]
