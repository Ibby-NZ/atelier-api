# atelier-api — transactional email

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## Transactional email (US-015)

- `src/email/` is a self-contained module. `templates.js` — pure `renderTemplate(name, data) → { subject, text }` for the lifecycle templates (`request_received`, `backoffice_new_request`, `checkout_receipt`, `order_confirmed`, `order_invoiced`, `payment_received`, `shipped`); plus the one-off letters (`contact_received`, `backoffice_new_contact`, `backoffice_new_trade_application`, the invoice-copy pair, `sample_loan_reminder`, `password_reset` — the reset link, sent by `notifyPasswordReset`; where the link points is the caller's decision, see `src/auth/password-reset.js`); `TEMPLATE_NAMES` lists them; unknown name throws. Templates do no I/O, so they unit-test directly.
- `mailer.js` — `createMailer({ transport, from, backofficeEmail, log })` returns `{ send({ template, to, data, replyTo? }), backofficeEmail }`. **`send` never throws**: a delivery failure is logged and returned as `{ ok: false, error }` so a mail problem can't fail the API request that triggered it. Transport is injected (dependency-injection, same as Stripe/pool). `replyTo` is set ONLY on the back-office alerts (new order, new enquiry, new trade application) and is the person the alert is about, so a staffer answering from the inbox reaches them instead of the no-reply sender; client-facing letters never set it.
- `transport.js` — `createMailTransport(config, logger)` builds a transport carrying **`delivers`**: real SMTP (`delivers: true`) when `SMTP_HOST` is set, otherwise a capture transport (`delivers: false`) that **prints every letter to the logger** and sends nothing, so dev/test never send real mail and a reset link can still be followed from the console. `createMailer` surfaces it as `mailer.delivers` (a transport that does not say — the tests' `{ sent: [], sendMail }` objects — counts as delivering), and the password-reset routes answer 503 when it is false: a "sent" that went nowhere is the one thing this module must never claim.
- `recipients.js` — `resolveOrderRecipient(db, { guest_email, user_id })`: guest email wins (no query); otherwise looks up `users.email`; null when neither. `db` may be a pool or an open client.
- `notifications.js` — the trigger layer. `notifyRequestReceived(mailer, { order, customerEmail })` (US-012: customer ack + back-office alert), `notifyCheckoutReceipt(mailer, db, order)` (US-011), `notifyOrderCreated(mailer, db, order)` (W12 US-004+US-005: the client's confirmation **at creation** plus the back-office alert), `notifyBackofficeNewOrder(mailer, db, order)` (W12 US-004: the alert alone, for a path that already messages the client), `notifyOrderTransition(mailer, db, order)` (US-014: maps `order.status` `confirmed→order_invoiced` / `paid→payment_received` / `shipped→shipped`, any other status is a no-op). **Every helper is a no-op when `mailer` is null** and never throws.
- **The back-office alert goes to ONE address — `mailer.backofficeEmail` — on every creation path, and `sendBackofficeAlert` is the single private sender all three routes reach.** Not a per-salesperson routing table: the restriction is the client's requirement, not an implementation detail waiting to be improved. Widen the copy there or nowhere.
- **A new trade application alerts the office, not the applicant.** `notifyTradeApplicationReceived(mailer, { user, application, crmBaseUrl })` (called by `POST /auth/trade-application` after `submitTradeApplication` commits) sends `backoffice_new_trade_application` to the same one address, Reply-To the applicant, linking `${crmBaseUrl}/#/clients/applicants`. The applicant deliberately gets nothing here: a pending account cannot sign in, and the acceptance letter on approval is their one letter — a "we received your application" would be a second template to keep in step with it for no decision it lets them make.
- **Every public mail-sending route carries a honeypot** (`src/lib/honeypot.js`): `POST /contact`, `POST /orders/request`, `POST /auth/trade-application`, `POST /auth/forgot-password`. The storefront posts a hidden `website` field a person never fills; when it is non-empty the route answers with its normal success shape (`{ enquiry: null }`, `{ order: null }`, `{ user: null }`, the 202 sentence) and stores and sends NOTHING, so the bot cannot tell it was caught. The field MUST be spread into each body schema (`...honeypotProperty`) or Ajv's `removeAdditional` strips it before the handler looks. It sits in front of the per-IP rate limits, not instead of them; `honeypotTripped` logs the hit with the IP. Guarded by the honeypot cases in `test/contact.test.js`, `test/email.test.js`, `test/trade-applications.test.js`, `test/password-reset.test.js`.
- **The `shipped` letter carries the courier link when there is one** (A4, Userback 8367567). `notifyOrderTransition` passes `tracking_url` off the order row alongside `order_number`/`xero_invoice_ref`; `POST /admin/orders/:id/ship` writes the column in the same UPDATE as the status, so the row the notifier is handed already has it. The template SPREADS the line in rather than rendering an empty one — a letter reading "Track your parcel:" with nothing after it is worse than one that never mentions tracking, and hand-delivered orders are ordinary. There is no placeholder allowlist to extend: `listEmailTemplates` renders the CODE template against a Proxy that answers every field with its own `{{ name }}`, so reading `tracking_url` in the template is what makes `{{ tracking_url }}` appear in the CRM's Letters editor. A STORED row for `shipped` cannot branch, so its tracking line would render as a dangling "Track your parcel:" on a hand-delivered order — one more reason the order-lifecycle letters still render from code only.
- **`order_confirmed` fires at CREATION and `order_invoiced` on `confirm`** (FR-120/FR-121). They were one template on one event; a confirm that re-sent the creation mail tells the client nothing they do not already have. Do not merge them back.
- Wiring: `buildApp({ ..., mailer })` (default null) passes the mailer into `orderRoutes`, `adminOrderRoutes`, `webhookRoutes`. Triggers: `POST /orders/request` → `notifyRequestReceived`; webhook after a *fresh* paid order (`result.order` truthy, i.e. not a replay) → `notifyCheckoutReceipt` **+ `notifyBackofficeNewOrder`**; `POST /admin/orders` → `notifyOrderCreated`; admin `confirm`/`mark-paid`/`ship` handlers → `notifyOrderTransition` (NOT `patch`/`decline` — patch could keep status `confirmed` and re-send). `processStripeEvent` returns `kind`/`user_id`/`guest_email`/`total_cents` on `result.order` so neither the receipt nor the alert needs an extra query.
- Config/env: `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS` (all optional), `EMAIL_FROM`, `BACKOFFICE_EMAIL` (non-secret defaults). **Setting `SMTP_HOST` without BOTH `EMAIL_FROM` and `BACKOFFICE_EMAIL` refuses to boot** (`loadConfig` throws — `test/config.test.js`): with a real relay the `.example` placeholders are a From that Postmark rejects and an alert address that bounces, and neither shows up anywhere but a relay log. This also applies to a dev `.env` that points at a real SMTP host — add the two lines rather than unset the host. Production is **Postmark over SMTP** (`smtp.postmarkapp.com:587`, `SMTP_USER` = `SMTP_PASS` = the transactional stream's Server API token, SMTP access enabled on the stream, From on the verified `atelier.co.nz` signature/domain); no Postmark SDK — nodemailer speaks SMTP and the default `outbound` stream needs no header. `server.js` builds the transport+mailer; `buildApp` in tests gets `mailer` only when a test needs to observe sends (existing suites pass no mailer → null → no-op, unchanged).

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
- Two templates read the store today: `sample_loan_reminder` (sending path, and why there is
  deliberately no scheduler behind it, in `src/samples/CLAUDE.md`) and `trade_application_approved`,
  the office's acceptance letter. `notifyTradeApproved(mailer, db, user)` renders it through
  `renderStoredTemplate` and sends verbatim; `PATCH /admin/users/:id` calls it only when
  `trade_approved` flips false → true on a trade row, so it goes out exactly once per approval.
  The order-lifecycle templates still render from code only — an edit to them in the CRM Letters
  screen is stored but not read.
