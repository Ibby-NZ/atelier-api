/**
 * Two columns the September 2026 feedback round asked for.
 *
 * `users.phone` — the storefront's order-request form asks for a phone every
 * time and forgets it every time; the number went into the free-text notes and
 * nowhere else. It belongs on the account, so a returning client gets it back
 * prefilled (src/orders/order-request.js writes it through on a request by a
 * signed-in user; `PATCH /auth/me` edits it). Nullable — guests have no row and
 * a phone has never been required to hold an account.
 *
 * `orders.tracking_url` — shipping an order emailed the client "it has been
 * shipped" and nothing else. The office ships hand-delivered orders too, so the
 * column is nullable and the ship route takes it optionally; when it is set the
 * shipped letter carries it (src/email/templates.js).
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('users', { phone: { type: 'text' } })
  pgm.addColumns('orders', { tracking_url: { type: 'text' } })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('orders', ['tracking_url'])
  pgm.dropColumns('users', ['phone'])
}
