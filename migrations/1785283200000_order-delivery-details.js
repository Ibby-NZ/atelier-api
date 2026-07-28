/**
 * Adds the delivery details a card checkout collects at Stripe.
 *
 * Stripe gathers the shipping address and a contact phone during the hosted
 * checkout, but until now nothing persisted them — the back office could see a
 * paid order with no idea where to send the parcel. The webhook now copies both
 * onto the order.
 *
 * `shipping_address` is jsonb rather than flat columns because it is a verbatim
 * snapshot of what the customer entered at the time of purchase (Stripe's
 * address shape: line1/line2/city/state/postal_code/country plus the recipient
 * name); it is a record, never something we query into.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('orders', {
    shipping_address: { type: 'jsonb' },
    contact_phone: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('orders', ['shipping_address', 'contact_phone'])
}
