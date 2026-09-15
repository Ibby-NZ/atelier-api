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
- `routes/admin-xero.js` — status/connect/callback/disconnect, contact + item
  sync, invoice push. Connect/disconnect are **director-only**; the rest is
  backoffice.

## Invariants — each one guards a real failure mode

- **Xero refresh tokens are SINGLE-USE and rotate.** Every refresh happens
  inside `withConnectionLock`, and expiry is re-checked INSIDE the lock so the
  second worker in the queue uses the fresh token instead of spending the dead
  one (which would brick the connection until a director reconnects).
- **Contacts are matched before they are created** — email first, then exact
  name (`matchContact`). Atelier's clients already exist in Xero (the old
  D365 connector put them there); create-on-miss without a search would mint
  duplicates Xero cannot merge. Contact Name is Xero's uniqueness key, so a
  name-taken refusal retries once as `Name (email)`.
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
  `mark-paid` route (the order transition NEVER fails because of Xero — a
  refusal comes back as `xero_payment.reason` for the CRM to print) and
  `pushOrderInvoice` itself when the order is already `paid`/`shipped` (a card
  checkout is born paid), where a failure is a `warning` on a push that
  succeeded. Unset account code = "recorded by hand", said in words, not an
  error.
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
  gates, the email warning path, and both sync directions.
