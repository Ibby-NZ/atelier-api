# atelier-api — transactional email

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## Transactional email (US-015)

- `src/email/` is a self-contained module. `templates.js` — pure `renderTemplate(name, data) → { subject, text }` for the lifecycle templates (`request_received`, `backoffice_new_request`, `checkout_receipt`, `order_confirmed`, `order_invoiced`, `payment_received`, `shipped`); `TEMPLATE_NAMES` lists them; unknown name throws. Templates do no I/O, so they unit-test directly.
- `mailer.js` — `createMailer({ transport, from, backofficeEmail, log })` returns `{ send({ template, to, data }), backofficeEmail }`. **`send` never throws**: a delivery failure is logged and returned as `{ ok: false, error }` so a mail problem can't fail the API request that triggered it. Transport is injected (dependency-injection, same as Stripe/pool).
- `transport.js` — `createMailTransport(config)` builds a nodemailer transport: real SMTP when `SMTP_HOST` is set, otherwise **`jsonTransport`** (captures + serialises the message, sends nothing) so dev/test never send real mail. Tests inject their own capture transport (`{ sent: [], sendMail }`) — no nodemailer needed.
- `recipients.js` — `resolveOrderRecipient(db, { guest_email, user_id })`: guest email wins (no query); otherwise looks up `users.email`; null when neither. `db` may be a pool or an open client.
- `notifications.js` — the trigger layer. `notifyRequestReceived(mailer, { order, customerEmail })` (US-012: customer ack + back-office alert), `notifyCheckoutReceipt(mailer, db, order)` (US-011), `notifyOrderCreated(mailer, db, order)` (W12 US-004+US-005: the client's confirmation **at creation** plus the back-office alert), `notifyBackofficeNewOrder(mailer, db, order)` (W12 US-004: the alert alone, for a path that already messages the client), `notifyOrderTransition(mailer, db, order)` (US-014: maps `order.status` `confirmed→order_invoiced` / `paid→payment_received` / `shipped→shipped`, any other status is a no-op). **Every helper is a no-op when `mailer` is null** and never throws.
- **The back-office alert goes to ONE address — `mailer.backofficeEmail` — on every creation path, and `sendBackofficeAlert` is the single private sender all three routes reach.** Not a per-salesperson routing table: the restriction is the client's requirement, not an implementation detail waiting to be improved. Widen the copy there or nowhere.
- **`order_confirmed` fires at CREATION and `order_invoiced` on `confirm`** (FR-120/FR-121). They were one template on one event; a confirm that re-sent the creation mail tells the client nothing they do not already have. Do not merge them back.
- Wiring: `buildApp({ ..., mailer })` (default null) passes the mailer into `orderRoutes`, `adminOrderRoutes`, `webhookRoutes`. Triggers: `POST /orders/request` → `notifyRequestReceived`; webhook after a *fresh* paid order (`result.order` truthy, i.e. not a replay) → `notifyCheckoutReceipt` **+ `notifyBackofficeNewOrder`**; `POST /admin/orders` → `notifyOrderCreated`; admin `confirm`/`mark-paid`/`ship` handlers → `notifyOrderTransition` (NOT `patch`/`decline` — patch could keep status `confirmed` and re-send). `processStripeEvent` returns `kind`/`user_id`/`guest_email`/`total_cents` on `result.order` so neither the receipt nor the alert needs an extra query.
- Config/env: `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS` (all optional), `EMAIL_FROM`, `BACKOFFICE_EMAIL` (non-secret defaults). `server.js` builds the transport+mailer; `buildApp` in tests gets `mailer` only when a test needs to observe sends (existing suites pass no mailer → null → no-op, unchanged).

## The template store (W20-US-003 / US-006)

- `template-store.js` — `renderStoredTemplate(db, name, data, { log })` returns the same
  `{ subject, text }` `renderTemplate` does plus `source: 'database'|'code'`. It **prefers the
  `email_templates` row and falls back to the code template**, and the fallback is TOTAL: a deleted
  row, an empty table, an unmigrated database, a query that throws — every one of them returns the
  code letter, logged, never thrown. That is what makes **DELETE the revert button** rather than a
  destructive act, and it is why `src/email/templates.js` keeps a copy of every letter a row may
  override.
- **A stored template is TEXT WITH `{{ placeholders }}`, not code.** It cannot branch, format or
  throw; a code template does all three (`formatCents`, the `xero_invoice_ref ? … : …` arm), which
  is why the code copy stays the DEFAULT and the row is only an override. An unknown or null
  placeholder renders **empty** — a staffer's typo becomes a visible gap in the draft they are about
  to read before sending, which compose-before-send already catches, where a throw would 500 a work
  queue.
- **A row may only exist for a name the code also renders.** `/admin/email-templates/:name` spends
  `TEMPLATE_NAMES` as a schema enum, so an unknown name is a 400 and never an orphan row. The check
  is NOT a CHECK constraint: the vocabulary is JavaScript's and moves with a deploy, so a constraint
  would have to be migrated in lockstep or start refusing rows the code is willing to render.
- `listEmailTemplates` renders an un-overridden letter against a Proxy that answers every field with
  its own `{{ name }}`, so the CRM's editor opens on the default text with its placeholders visible
  rather than on an empty box or on `undefined`.
- **`mailer.send` now takes two forms**: `{ template, data }` (rendered here, every order-lifecycle
  notification) and `{ subject, text }` (sent VERBATIM). The second is what compose-before-send
  needs — the body a staffer approved is the body that goes, and re-rendering it at send time would
  deliver a different letter from the one on screen. `send` still never throws: a caller supplying
  neither form comes back as `{ ok: false }` like any other failure.
- Routes: `GET /admin/email-templates`, `PUT|DELETE /admin/email-templates/:name`
  (`src/routes/admin-email-templates.js`, backoffice-only — a letter that goes out over Atelier's
  name is not something a client edits). PUT is an upsert, so saving twice is one row and never a
  409 a staffer has to interpret.
- The one template using the store today is `sample_loan_reminder`; the sending path, and why there
  is deliberately no scheduler behind it, live in `src/samples/CLAUDE.md`.
