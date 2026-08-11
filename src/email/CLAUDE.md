# atelier-api — transactional email

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## Transactional email (US-015)

- `src/email/` is a self-contained module. `templates.js` — pure `renderTemplate(name, data) → { subject, text }` for the six lifecycle templates (`request_received`, `backoffice_new_request`, `checkout_receipt`, `order_confirmed`, `payment_received`, `shipped`); `TEMPLATE_NAMES` lists them; unknown name throws. Templates do no I/O, so they unit-test directly.
- `mailer.js` — `createMailer({ transport, from, backofficeEmail, log })` returns `{ send({ template, to, data }), backofficeEmail }`. **`send` never throws**: a delivery failure is logged and returned as `{ ok: false, error }` so a mail problem can't fail the API request that triggered it. Transport is injected (dependency-injection, same as Stripe/pool).
- `transport.js` — `createMailTransport(config)` builds a nodemailer transport: real SMTP when `SMTP_HOST` is set, otherwise **`jsonTransport`** (captures + serialises the message, sends nothing) so dev/test never send real mail. Tests inject their own capture transport (`{ sent: [], sendMail }`) — no nodemailer needed.
- `recipients.js` — `resolveOrderRecipient(db, { guest_email, user_id })`: guest email wins (no query); otherwise looks up `users.email`; null when neither. `db` may be a pool or an open client.
- `notifications.js` — the trigger layer. `notifyRequestReceived(mailer, { order, customerEmail })` (US-012: customer ack + back-office alert), `notifyCheckoutReceipt(mailer, db, order)` (US-011), `notifyOrderTransition(mailer, db, order)` (US-014: maps `order.status` `confirmed→order_confirmed` / `paid→payment_received` / `shipped→shipped`, any other status is a no-op). **Every helper is a no-op when `mailer` is null** and never throws.
- Wiring: `buildApp({ ..., mailer })` (default null) passes the mailer into `orderRoutes`, `adminOrderRoutes`, `webhookRoutes`. Triggers: `POST /orders/request` → `notifyRequestReceived`; webhook after a *fresh* paid order (`result.order` truthy, i.e. not a replay) → `notifyCheckoutReceipt`; admin `confirm`/`mark-paid`/`ship` handlers → `notifyOrderTransition` (NOT `patch`/`decline` — patch could keep status `confirmed` and re-send). `processStripeEvent` now returns `user_id`/`guest_email`/`total_cents` on `result.order` so the receipt needs no extra query.
- Config/env: `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS` (all optional), `EMAIL_FROM`, `BACKOFFICE_EMAIL` (non-secret defaults). `server.js` builds the transport+mailer; `buildApp` in tests gets `mailer` only when a test needs to observe sends (existing suites pass no mailer → null → no-op, unchanged).

