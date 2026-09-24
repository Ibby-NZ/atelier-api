# atelier-api — Xero integration (C4)

Extracted from the root CLAUDE.md (root conventions still apply). Loaded
automatically when working in this directory.

## Shape

- `xero-http.js` — the raw HTTP seam (token endpoint, /connections, one
  `accounting()` caller). Deliberately NOT the xero-node SDK: the SDK does
  OpenID discovery over the network at initialise time, and four stable
  endpoints do not justify the tree. Tests fake THIS interface, so the whole
  service runs for real above a scripted network.
- `connection-store.js` — the single `xero_connection` row (CHECK id = 1).
  `withConnectionLock` is the FOR UPDATE wrapper every refresh runs under.
- `mapping.js` — pure platform↔Xero translation. All money and truncation
  rules live here and are proven by `test/xero-mapping.test.js` with no DB.
- `service.js` — the ONE object the rest of the API sees. `buildApp({ xero })`
  takes it (null = unconfigured → routes 503, the Stripe posture);
  `server.js` builds the real one from `config.xero`.
- `routes/admin-xero.js` — status/connect/callback/disconnect, contact +
  supplier + item sync, invoice push, bill push, and the two pulls.
  Connect/disconnect are **director-only**; the rest is backoffice.

## Two directions

Platform → Xero: `/sync/contacts` (client companies + unfiled logins),
`/sync/suppliers`, `/sync/items`, one company on demand
(`ensureTradeAccountContact` — trade approval and the CRM's Add to Xero) and
its archive/reactivate (`setContactStatus`, a client's cancellation — see
`src/trade-accounts/CLAUDE.md`), `/orders/:id/invoice` (ACCREC),
`/purchase-orders/:id/bill` (ACCPAY). Xero → platform: `/pull/contacts` and
`/pull/statuses`; `pullAll()` is both, and `server.js` runs it every
`XERO_PULL_INTERVAL_MINUTES` (0 = buttons only). Three tables remember a
contact — `users`, `trade_accounts`, `suppliers` — each with its own
`xero_contact_id`; `orders.xero_invoice_id/_ref/_status` and
`purchase_orders.xero_bill_id/_ref/_status` remember the documents.

## Invariants — each one guards a real failure mode

- **Xero refresh tokens are SINGLE-USE and rotate.** Every refresh happens
  inside `withConnectionLock`, and expiry is re-checked INSIDE the lock so the
  second worker in the queue uses the fresh token instead of spending the dead
  one (which would brick the connection until a director reconnects).
- **Contacts are matched before they are created** — email first, then exact
  name (`matchContact`). Atelier's clients already exist in Xero (the old
  D365 connector put them there); create-on-miss without a search would mint
  duplicates Xero cannot merge. Contact Name is Xero's uniqueness key, so a
  name-taken refusal retries once as `Name (email)`. `pushContacts` is the
  ONE match-then-batch-create routine; `syncContacts` and `syncSuppliers`
  only differ in the rows, the payload shape and the table that remembers.
- **The COMPANY is the customer.** A login filed under a `trade_accounts` row
  (`trade_account_users`) invoices as that company's contact and is skipped by
  `syncContacts` — the person gets no contact of their own, because Xero has
  always invoiced the company. Unfiled logins and guests still invoice as
  themselves. `trade_accounts.xero_contact_id` already carried the D365 ids
  for the merged roster, which is why the company path links first.
- **A purchase order pushes as a DRAFT bill** (`XERO_BILL_STATUS`), raised
  by Send and retried by hand; anything but `cancelled` is billable, only
  with every line priced, numbered by our `po_number` in BOTH
  `InvoiceNumber` and `Reference` — the accountant overwrites the former with
  the house's own invoice number when it arrives, and the latter keeps the
  link. The bill is dated the day the order went to the house. `unit_price`
  is decimal dollars in the house's currency (`CurrencyCode` rides along); no
  cents anywhere in purchasing. A bill Xero has VOIDED/DELETED re-opens the
  push under `atelier-po-<id>-after-<deadId>`, the same rule as the invoice.
  `pullStatuses` mirrors bills through the same `mirrorBillState` the
  on-demand sync uses, so a PAID answer from either path moves the order.
- **The pull never renames.** `pullContacts` refreshes email/phone/address
  by `COALESCE(xero, ours)` on rows already linked by id, links unlinked rows
  by email then exact name, and only then creates — a Xero customer becomes a
  client company, a Xero supplier a supplier, an unflagged contact is counted
  as `skipped`. `trade_accounts.legacy_customer_name` is what the client
  portal matches invoice history on, so a rename from Xero would silently
  empty a client's history. ARCHIVED Xero contacts are ignored.
- **Xero's status word is stored, not derived, and it re-opens a push.**
  `pullStatuses` reads every unsettled pushed document (`GET Invoices?IDs=`)
  and writes `xero_invoice_status` / `xero_bill_status`. PAID on an invoice
  runs `markOrderPaid` (the same `setOrderStatus` move and letter as the
  CRM's status dropdown, audit row `actor_kind: 'xero'`, letter via the
  injected `notifyOrderTransition`) from any status the machine lets move to
  `paid` (`back_order`, `processing`, `pending_payment`); an order already
  paid/shipped/completed is left alone, and one the machine will not move (a
  quote, a cancelled order) is reported in `failed`, not forced. VOIDED/DELETED (`isDeadInXero`) lets `pushOrderInvoice` /
  `pushPurchaseOrderBill` run again under the key
  `atelier-order-<id>-after-<deadId>` — Xero's idempotency window is 24h,
  so the plain key would hand the voided invoice straight back. PAID /
  VOIDED / DELETED are terminal and are not re-read.
- **Invoice pushes are idempotent at both ends**: `Idempotency-Key
  atelier-order-<id>` makes Xero return the SAME invoice on a retry, and
  `orders.xero_invoice_id` (now in the admin order shape — that's the
  duplicate gate) 409s a second push. The push also fills `xero_invoice_ref`
  with Xero's InvoiceNumber, so the confirm flow's manual field fills itself;
  confirm itself is untouched and still accepts a typed ref.
- **The push refuses an unpriced line, not just a zero total** — `unpricedLineCount(order.lines)` from `src/orders/order-states.js`, the same predicate `confirm` uses, so an order with one priced and one $0.00 line (positive total) no longer reaches Xero as a nil item. The `total_cents <= 0` clause stays for the one case the lines cannot catch, a 100% discount. **`orders.discount_pct` rides on every goods line as Xero's own `DiscountRate`** (`lineItemForOrderLine`, omitted at 0; never on the freight line, because the discount is off the goods per `src/orders/discounts.js`) — the mapping used to ignore it and a discounted order invoiced at full price. Xero rounds each line to the cent where `recomputeOrderMoney` rounds the discounted subtotal once, so the invoice may differ from `total_cents` by at most half a cent per goods line; the invoice is the legal figure and the GST block already derives rather than stores. Guarded by `test/xero-mapping.test.js` (exact fixture agrees with `discountedTotalCents`) and `test/admin-xero.test.js`.
- **The OAuth `state` nonce is single-use**: `takePendingState` reads AND
  clears in one statement, so a replayed callback matches nothing. The
  callback route answers with REDIRECTS to the CRM (`?connected=1/0`), never
  JSON — it is a browser navigation, not an API call.
- **Item sync keys on SKU** (`POST /Items` upserts on Code) — re-running is a
  refresh, never a duplicate. Code truncates to 30 chars, Name to 50.
- **The invoice follows the order to PAID.** `recordOrderPayment(orderId)` PUTs
  a Payment against the pushed invoice for exactly Xero's own `AmountDue` (read
  back first, never recomputed from our cents — rounding between our totals and
  Xero's tax lines would otherwise leave a cent outstanding), against the BANK
  account `XERO_PAYMENT_ACCOUNT_CODE` names. Idempotent by construction: a
  second call finds nothing due and records nothing. Two callers: the
  status route on a move to `paid` (the order transition NEVER fails because
  of Xero — a refusal comes back as `xero_payment.reason` for the CRM to
  print) and `pushOrderInvoice` itself when the order is already
  `paid`/`shipped`/`completed` (a card checkout is born paid), where a
  failure is a `warning` on a push that succeeded.
- **The push is the invoice going out, so it moves the order** (24 Sep
  2026). Only `INVOICEABLE_STATUSES` (quote_accepted → completed) may be
  pushed — an unaccepted quote or a cancelled order is a 409 naming its
  status. After the invoice is stored, an order the machine lets move goes to
  `pending_payment` through `setOrderStatus` (actor = the staffer the route
  passes; letter via the injected `notifyOrderTransition`); one already
  pending, or paid and beyond, keeps its status. A refused move is a
  `warning`, never a rollback of a push Xero already holds. Unset account code = "recorded by hand", said in words, not an
  error.
- **A purchase order becomes a BILL (ACCPAY) against its supplier when it is
  SENT** (22 Sep 2026). `pushPurchaseOrderBill` mirrors the invoice push:
  supplier contact matched (PO email, then name) before created and remembered
  on `suppliers.xero_contact_id`; `Idempotency-Key atelier-po-<id>` at Xero
  and `purchase_orders.xero_bill_id` here (409 on a second push); lines go
  across in the SUPPLIER'S currency as `numeric(12,4)` with `CurrencyCode` set
  (the org must have that currency enabled), against
  `XERO_PURCHASES_ACCOUNT_CODE` (default 300); an unpriced line refuses. The
  send route calls it and NEVER fails because of Xero — the answer travels as
  `xero_bill: { raised, number | reason }`, the status route's `xero_payment` posture — and
  `POST /admin/xero/purchase-orders/:id/bill` is the retry. **"Paid" reaches
  the platform by POLL, not webhook**: `POST …/bill/sync` re-reads the bill and
  mirrors `Status` / `FullyPaidOnDate` onto `xero_bill_status` /
  `xero_bill_paid_at`, and a `PAID` answer moves the order's own `status` to
  `paid` through `payPurchaseOrder` where the machine allows it (sent/closed).
  The CRM syncs when it opens an order whose bill is unsettled. Guarded by the "purchase orders as
  bills" block of `test/admin-xero.test.js`.
- `expires_at_ms` in the stored token set is OUR computed absolute expiry
  (minted-at + expires_in); Xero itself only sends the relative form.

## Config

All under `config.xero` (null unless BOTH `XERO_CLIENT_ID` and
`XERO_CLIENT_SECRET` are set — see `.env.example` for the full list).
`XERO_GRANT_TYPE=authorization_code` (default; any free Xero app, director
consents once via the CRM) or `client_credentials` (paid Custom Connection, no
consent step, `status()` reports connected as soon as it is configured).
`XERO_REDIRECT_URI` must EXACTLY match a URI registered on the Xero app.
Money posture: `XERO_LINE_AMOUNT_TYPES=Exclusive` (NZ trade convention) and
`XERO_SALES_ACCOUNT_CODE=200` — confirm both with the accountant before
production. `XERO_INVOICE_STATUS=DRAFT` exists for a cautious rollout, but
Xero cannot EMAIL a draft, so the email-on-push option degrades to a warning.

## Tests

- `test/xero-mapping.test.js` — pure, runs anywhere.
- `test/admin-xero.test.js` — real service + real DB + `createFakeXero()`
  scripting the HTTP seam (`findLast` so a test's script shadows the
  defaults). Covers the state nonce, rotation-under-expiry, both duplicate
  gates, the email warning path, company-as-customer, supplier sync, the
  bill push, both pulls and the void-then-re-push cycle. New tests raise
  orders through `POST /admin/orders` (`raisePricedOrder`), not the public
  request route — its 10-per-15-min bucket is spent by the earlier cases.
