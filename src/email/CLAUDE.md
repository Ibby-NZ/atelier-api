# atelier-api — transactional email

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## Transactional email (US-015)

- `src/email/` is a self-contained module. `templates.js` — pure `renderTemplate(name, data) → { subject, text }` for the lifecycle templates (`request_received`, `backoffice_new_request`, `checkout_receipt`, `order_confirmed`, `quote_sent`, `order_back_ordered`, `order_invoiced`, `payment_received`, `shipped`, `order_cancelled`, `backoffice_quote_answered`, and `order_details`, the on-demand whole order); plus the one-off letters (`contact_received`, `backoffice_new_contact`, `backoffice_new_trade_application`, the invoice-copy pair, `sample_loan_reminder`, `password_reset` — the reset link, sent by `notifyPasswordReset`; where the link points is the caller's decision, see `src/auth/password-reset.js`); `TEMPLATE_NAMES` lists them; unknown name throws. Templates do no I/O, so they unit-test directly.
- `mailer.js` — `createMailer({ transport, from, backofficeEmail, log })` returns `{ send({ template, to, data, replyTo? }), backofficeEmail }`. **`send` never throws**: a delivery failure is logged and returned as `{ ok: false, error }` so a mail problem can't fail the API request that triggered it. Transport is injected (dependency-injection, same as Stripe/pool). `replyTo` is set ONLY on the back-office alerts (new order, new enquiry, new trade application) and is the person the alert is about, so a staffer answering from the inbox reaches them instead of the no-reply sender; client-facing letters never set it.
- `transport.js` — `createMailTransport(config, logger)` builds a transport carrying **`delivers`**: real SMTP (`delivers: true`) when `SMTP_HOST` is set, otherwise a capture transport (`delivers: false`) that **prints every letter to the logger** and sends nothing, so dev/test never send real mail and a reset link can still be followed from the console. `createMailer` surfaces it as `mailer.delivers` (a transport that does not say — the tests' `{ sent: [], sendMail }` objects — counts as delivering), and the password-reset routes answer 503 when it is false: a "sent" that went nowhere is the one thing this module must never claim.
- `recipients.js` — `resolveOrderRecipient(db, { guest_email, user_id })`: guest email wins (no query); otherwise looks up `users.email`; null when neither. `db` may be a pool or an open client.
- `notifications.js` — the trigger layer. `notifyRequestReceived(mailer, { order, customerEmail })` (US-012: customer ack + back-office alert), `notifyCheckoutReceipt(mailer, db, order)` (US-011), `notifyOrderCreated(mailer, db, order)` (W12 US-004+US-005: the client's confirmation **at creation** plus the back-office alert), `notifyBackofficeNewOrder(mailer, db, order)` (W12 US-004: the alert alone, for a path that already messages the client), `notifyOrderTransition(mailer, db, order, extra?)` (US-014, widened 24 Sep 2026: maps `order.status` `quote_sent→quote_sent` / `back_order→order_back_ordered` / `pending_payment→order_invoiced` / `paid→payment_received` / `shipped→shipped` / `cancelled→order_cancelled`; every other status — `quote_requested` (creation), the client's own `quote_accepted`/`quote_rejected`, and the bookkeeping `processing`/`completed`/`refunded` — is a no-op. `extra` is spread into the data: the status route passes `{ quote_url }`, which exists only there. See the status-letter bullet below for who receives them), `notifyQuoteAnswered(mailer, db, order, { accepted, reason })` (the client answered a quote on the storefront: `backoffice_quote_answered` to `mailer.backofficeEmail` AND the order's rep, Reply-To the client; the client gets nothing). **Every helper is a no-op when `mailer` is null** and never throws.
- **The back-office alert goes to ONE address — `mailer.backofficeEmail` — on every creation path, and `sendBackofficeAlert` is the single private sender all three routes reach.** Not a per-salesperson routing table: the restriction is the client's requirement, not an implementation detail waiting to be improved. Widen the copy there or nowhere.
- **A status letter goes to everyone the order names — the client, the sales rep, and the order's Emails list — one letter each, each address once** (23 Sep 2026: "when the status changes on a sales order, an email is sent to the client and sent to the sales rep", plus "an email section in a sales order to let admin add emails"). `notifyOrderTransition` reads `sales_rep_email` and `notify_emails` off the ADMIN order shape every caller already hands it (the status route, the purchase-order generator's back order, and both Xero directions — the push's `pending_payment` and the pull's `paid`, through the service's injected `notifyOrderTransition`) and dedupes client + rep + list through `uniqueEmails` (`src/orders/notify-emails.js`, case- and space-insensitive), so a rep who is also the client gets one letter. **Separate letters, never CC**: `send` takes one `to` and the redirect valve rewrites exactly that, and the client's accounts desk has no business reading the rep's address in a header. A client with no address no longer silences the rest. `sales_rep_email` is NULL for a rep whose login is ARCHIVED — someone who has left must not keep receiving a client's orders. This is NOT the creation alert: `sendBackofficeAlert` still goes to the one configured address and never to a rep (the bullet below). **The packing slip is never emailed** — it is printed in the CRM and travels with the goods; there is no template for it and there should not be one.
- **Jenette is copied on every sales-order letter, and the order page can send one on demand** (24 Sep 2026: "send order details to the customer or resend the order notification — make sure jenettec@atelier.co.nz is always in the loop"). `orderLetterRecipients(mailer, db, order)` in `notifications.js` is the ONE list — client, rep, `notify_emails`, then `mailer.orderCopyEmail` — shared by `notifyOrderTransition` and `order-letters.js`, so a status change and a button reach the same people. The copy is `ORDER_COPY_EMAIL` (`config.orderCopyEmail`, default `jenettec@atelier.co.nz`, empty string = nobody) handed to `createMailer`; a mailer built without it (every test's) copies nobody, so no older assertion moved. It is NOT on the creation alert, which stays the one `BACKOFFICE_EMAIL`. `POST /admin/orders/:id/email { letter: 'details'|'status' }` (`src/routes/admin-orders.js`, backoffice, any status incl. archived — nothing moves) sends `order_details` (lines, totals on the order's GST basis, delivery — every block pre-formatted by `orderDetailsData`) or re-sends the letter for where the order stands (`currentStatusTemplate`: the transition letter, or for `quote_requested` the creation letter — `order_confirmed` for a manual order, `request_received` for a storefront request; a re-sent `quote_sent` issues a FRESH quote link, because only the old token's hash is kept, which retires the link in the earlier letter). **The letter IS the act, so it refuses rather than no-ops**: 503 with no delivering mailer, 422 for details while a line is $0.00 (`unpricedLineCount`), 422 for a resend at a status with no letter of its own (`quote_accepted`/`quote_rejected`/`processing`/`completed`/`refunded` — `currentStatusTemplate` answers null), 502 when every address failed, 422 when there is nobody to send to; 200 answers `{ template, sent, failed }`. Single-order responses carry `order_copy_email` (added in the route's `preSerialization` hook — a deployment setting, not a column) so the CRM names the copy from config. Guarded by `test/order-letters.test.js` (pure) and the `POST /admin/orders/:id/email` block of `test/email.test.js`.
- **A new trade application alerts the office, not the applicant.** `notifyTradeApplicationReceived(mailer, { user, application, crmBaseUrl })` (called by `POST /auth/trade-application` after `submitTradeApplication` commits) sends `backoffice_new_trade_application` to the same one address, Reply-To the applicant, linking `${crmBaseUrl}/#/clients/accounts?pending=true` (the Accounts screen narrowed to the review queue — the Applicants tab is gone; see the trade-application bullet in the root CLAUDE.md). The applicant deliberately gets nothing here: a pending account cannot sign in, and the acceptance letter on approval is their one letter — a "we received your application" would be a second template to keep in step with it for no decision it lets them make.
- **Every public mail-sending route carries a honeypot** (`src/lib/honeypot.js`): `POST /contact`, `POST /orders/request`, `POST /auth/trade-application`, `POST /auth/forgot-password`. The storefront posts a hidden `website` field a person never fills; when it is non-empty the route answers with its normal success shape (`{ enquiry: null }`, `{ order: null }`, `{ user: null }`, the 202 sentence) and stores and sends NOTHING, so the bot cannot tell it was caught. The field MUST be spread into each body schema (`...honeypotProperty`) or Ajv's `removeAdditional` strips it before the handler looks. It sits in front of the per-IP rate limits, not instead of them; `honeypotTripped` logs the hit with the IP. Guarded by the honeypot cases in `test/contact.test.js`, `test/email.test.js`, `test/trade-applications.test.js`, `test/password-reset.test.js`.
- **The `shipped` letter carries the courier link when there is one** (A4, Userback 8367567). `notifyOrderTransition` passes `tracking_url` off the order row alongside `order_number`/`xero_invoice_ref`; `POST /admin/orders/:id/status { status: 'shipped', tracking_url }` writes the column in the same UPDATE as the status, so the row the notifier is handed already has it. **`quote_sent` reads `quote_url` the same way** (always present on the real path; the spread only guards a caller that omits it), so `{{ quote_url }}` shows in the Letters editor. The template SPREADS the line in rather than rendering an empty one — a letter reading "Track your parcel:" with nothing after it is worse than one that never mentions tracking, and hand-delivered orders are ordinary. There is no placeholder allowlist to extend: `listEmailTemplates` renders the CODE template against a Proxy that answers every field with its own `{{ name }}`, so reading `tracking_url` in the template is what makes `{{ tracking_url }}` appear in the CRM's Letters editor. A STORED row for `shipped` cannot branch, so its tracking line would render as a dangling "Track your parcel:" on a hand-delivered order — one more reason the order-lifecycle letters still render from code only.
- **`order_confirmed` fires at CREATION and `order_invoiced` on the move to `pending_payment`** (FR-120/FR-121). They were one template on one event; a confirm that re-sent the creation mail tells the client nothing they do not already have. Do not merge them back.
- Wiring: `buildApp({ ..., mailer })` (default null) passes the mailer into `orderRoutes`, `adminOrderRoutes`, `webhookRoutes`. Triggers: `POST /orders/request` → `notifyRequestReceived`; webhook after a *fresh* paid order (`result.order` truthy, i.e. not a replay) → `notifyCheckoutReceipt` **+ `notifyBackofficeNewOrder`**; `POST /admin/orders` → `notifyOrderCreated`; `POST /admin/orders/:id/status` → `notifyOrderTransition` (NOT `patch` — patch never moves the status and must not re-send; `cancelled` joined on 23 Sep 2026 with `order_cancelled`, the letter the CRM's Cancel dialog had long promised); `POST /orders/quote/:token/accept|reject` and `/orders/mine/:order_number/accept|reject` → `notifyQuoteAnswered`. `processStripeEvent` returns `kind`/`user_id`/`guest_email`/`total_cents` on `result.order` so neither the receipt nor the alert needs an extra query.
- Config/env: `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS` (all optional), `EMAIL_FROM`, `BACKOFFICE_EMAIL` (non-secret defaults). **Setting `SMTP_HOST` without BOTH `EMAIL_FROM` and `BACKOFFICE_EMAIL` refuses to boot** (`loadConfig` throws — `test/config.test.js`): with a real relay the `.example` placeholders are a From that Postmark rejects and an alert address that bounces, and neither shows up anywhere but a relay log. This also applies to a dev `.env` that points at a real SMTP host — add the two lines rather than unset the host. Production is **Postmark over SMTP** (`smtp.postmarkapp.com:587`, `SMTP_USER` = `SMTP_PASS` = the transactional stream's Server API token, SMTP access enabled on the stream, From on the verified `atelier.co.nz` signature/domain); no Postmark SDK — nodemailer speaks SMTP and the default `outbound` stream needs no header. `server.js` builds the transport+mailer; `buildApp` in tests gets `mailer` only when a test needs to observe sends (existing suites pass no mailer → null → no-op, unchanged).

- **`order_stock_arrived`** (24 Sep 2026) tells the client their goods are in: `notifyStockArrived`,
  from `POST /admin/orders/:id/stock-arrived` (the bulk order's receive screen), to everyone a status
  letter goes to (`orderLetterRecipients`), resolving to who it reached.

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

## Purchasing and reserves — the letters that leave the building (W13 / W24)

These are the first notifications addressed to a **counterparty** rather than a client or the
office: a purchase order goes to a fabric house, a reserve request asks a mill to hold stock. That
one fact drives everything below.

- **`EMAIL_REDIRECT_TO` is the test-drive valve, and it lives in `createMailer`.** Set it and EVERY
  letter — client, `BACKOFFICE_EMAIL`, and a supplier's `po_email` alike — is delivered to that one
  address instead, with the real recipient in the subject (`[to: …]`) and a banner above the body.
  It is in the mailer, not in each route, deliberately: a valve a caller has to remember to open is
  a valve that gets forgotten exactly once, and a half-finished template reaching a mill is not
  recallable. Being there, it also covers every notification added later without anyone being told
  about it. `server.js` warns loudly on boot while it is set; `mailer.redirectTo` surfaces it but is
  never read to decide WHETHER to send — a redirected letter is still a letter sent. Guarded by
  `test/email-redirect.test.js`, which tests the BEHAVIOUR and deliberately asserts nothing about
  the ambient environment: a test reading `loadConfig().emailRedirectTo` passes for whoever wrote it
  and fails in CI, which has no `.env` and needs none. **Unsetting it is what makes suppliers start
  receiving real purchase orders**, and the thing that keeps that from being forgotten is the boot
  warning in `server.js`, printed on every start while the valve is open.
- **The house is told what a PERSON did, never what arithmetic says.** The purchase-order letters
  hang off Send PO (`pending_payment`), `paid`, a SHORT `completed` and `cancelled` — moves in
  `src/purchasing/po-states.js` (24 Sep 2026) — plus ONE `purchase_order_bulk_sent` for a bulk order,
  and every one also goes to the purchase order's own Emails list (`notify_emails`); and
  the reserve letters off a raised line and a cancelled one. The DERIVED receipt state
  (`none|part|full|over`) mails the back office ONLY: it changes every time a roll is scanned, and a
  house that got "your order is now part-received" each time would filter us.
- **A draft mails nobody.** `draft` is the state a purchase order is created in; nothing has left
  the building and the person who typed it is looking at it. The FIRST letter is `send`, which is
  exactly what that button means. Same rule on the reserve side: the trigger is the write that
  raises the lines.
- **No address is not an error.** `purchase_orders.po_email` is a nullable snapshot, so a house with
  nothing on file cannot be emailed — and the move still succeeds, because refusing to mark a
  purchase order sent when the office phones that house instead would make the status lie. The
  back-office copy says `NO ADDRESS ON FILE`, which is the only place that fact can usefully appear.
- **The supplier letter carries PRICES whoever pressed Send.** The route re-reads the order with
  `finance: true` for the notification while the RESPONSE stays masked. A purchase order without
  prices is not a purchase order, the house quoted them in the first place, and finance masking
  exists so a staffer without cost access does not read costs *on screen* — this letter is composed
  server-side for the house and the one configured back-office address.
- **A reserve line's house is FREE TEXT** (`reserve_lines.supplier`, no foreign key, a D365
  carry-over). `resolveSupplierEmail` in `recipients.js` matches it against `suppliers.name`
  case-insensitively and trimmed, and **nothing fuzzier**: a near-match resolved by guesswork
  addresses a commercial conversation to the wrong mill, which is worse than sending nothing. When
  it resolves to null no supplier letter goes out, and the back-office copy — which is sent either
  way — says `NO SUPPLIER MATCH`. That copy is the only record that a house was never actually asked.
- **The unit of sending is (house × kind), and only the lines THIS request raised.** A docket spans
  houses (a client rings about cloth from three mills), so one save is several letters; and "hold
  this" (`supplier_reserve_request`) is a different ask from "post us a cutting"
  (`supplier_cutting_request`) — a house that receives them merged answers one of them. The notifier
  is handed `request.body.lines`, never the docket's full list, because a docket the office adds to
  next week must not re-ask a house for what it already holds.
- **Only `cancelled` writes to the house after the request.** `confirmed` is the house telling US,
  `arrived` is our warehouse, `dispatched` is our courier. A cancellation is the one move that costs
  the house money if the letter never arrives: cloth stays held against a client who walked away.
- **`supplier_invoice_request` is the one letter where the LETTER IS THE ACT.** Every other
  counterparty letter hangs off a move that stands on its own — a purchase order is sent whether or
  not the relay was up, and `po_email` being null is not an error. The statement asks a house for one
  bill covering several purchase orders and there is no state change behind it, so
  `src/purchasing/invoice-statements.js` refuses rather than no-ops: **422** with no address on file,
  **503** with no mailer configured, and the attach's own **409/422** for an order already billed or
  raised for another house — all BEFORE anything is sent. A statement is refused WHOLE and never
  narrowed: a letter that went out missing an order the staffer ticked is worse than one that did not
  go, because nothing on screen says so.
- Templates: `purchase_order_sent` / `_paid` / `_bulk_sent` / `_closed` / `_cancelled`, `supplier_invoice_request` and
  `supplier_reserve_request` / `supplier_cutting_request` / `supplier_reserve_cancelled` go OUT;
  `backoffice_purchase_order_sent` / `_received`, `backoffice_supplier_invoice_request` and
  `backoffice_reserve_request` stay in. Triggers
  live in `purchasing-notifications.js` and `reserve-notifications.js` (separate files from
  `notifications.js`, which is the order lifecycle); both are no-ops when `mailer` is null and
  neither throws. Wiring: `buildApp` passes `mailer` into `adminPurchaseOrderRoutes`,
  `adminSupplierInvoiceRoutes` (for the statement route alone) and
  `adminReserveRoutes`. Guarded by `test/purchasing-email.test.js`, `test/reserves-email.test.js` and
  `test/supplier-invoice-statement.test.js`.
- All of them appear in the CRM's Emails screen automatically (`TEMPLATE_NAMES` is `Object.keys`), so a
  stored row can override any of them. Every list (`lines_text`) is PRE-FORMATTED by the notifier,
  the `sample_request_received` precedent — a stored override cannot do arithmetic or currency, so
  the code template must not either, or the two copies drift.
