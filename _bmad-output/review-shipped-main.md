# Shipped `main` / `master` review

**Date:** 14 September 2026  
**Scope:** atelier-api (`6646dc3`), atelier-crm (`62327f4`), atelier-storefront (`5e7d790`)  
**Against:** `prd.md` (W1–W10), `prd-august-12th.md` (W12–W22 + §4 supersessions), section-9 checklist  
**Node:** 24.18.0 (`nvm use 24`) for test runs

---

## Executive summary

The August workstreams (W12–W22) are **largely present in code on `main`**, but **tracking artifacts are stale** (`sprint-status.yaml` still marks W12–W22 pending). Two **specification failures** stand out: **Xero token encryption (FR-166)** and the **7% duty placeholder still in the CRM import path (W18 US-005)**. One **architectural deviation** is deliberate in implementation but not reflected in the PRD: **reserves use `reserve_requests` tables rather than a fifth `orders.kind` (FR-235)**.

**Security posture:** Auth, rate limits, Stripe raw-body parsing, and CORS *code* look sound; **live verification was blocked** by local database migration drift (`column "phone" does not exist` on login). **Xero tokens are stored as plain `jsonb`** — treat as a launch blocker for production Xero.

**CRM demo/live split:** Primary nav **Catalogue → `/catalogue` is still the demo library** with **no page-level disclaimer** — highest product risk for the office.

**Product sanity (office-chair flows):** Not fully exercised in-browser (password autofill blocked; API login 500 on drifted DB). Unit tests and code inspection support packing-slip-no-prices, order desk routes, PO/receipt/invoice chains, and trade-approval mail paths; **end-to-end confirmation needs a migrated database**.

---

## FR block scorecard

| Block | Verdict | Evidence / notes |
|-------|---------|------------------|
| W1–W2 Lifecycle / admin CRUD | **PASS** | `src/lifecycle/`, `useCrudScreen` consumers, delete kit tests |
| W3 Suppliers & terms | **PASS** | `/admin/suppliers`, `src/suppliers/`, backfill scripts |
| W4 + W20 Samples (round 2) | **PASS** | `/admin/samples`, loans, sample orders, showrooms |
| W5 + W21 Reporting | **PASS** | `/admin/reports/*`, `admin-reports.test.js`, finance masking |
| W6 Category sheet | **PASS** | `/admin/product-sheet`, validate/apply routes |
| W7 Featured ranking | **PASS** | `/admin/brands/featured`, `/admin/collections/featured` |
| W12 Order desk | **PASS** | `AdminOrders.jsx`, webhook mails back office on checkout |
| W13 Purchasing | **PASS** | `admin-purchase-orders.js`, receipt ledger, CRM screens |
| W14 Supplier invoices | **PASS** | Routes + `AdminSupplierInvoices`, variance join |
| W15 Xero | **PARTIAL** | Integration shipped; **FR-166 FAIL**, **FR-178 deviation** |
| W16 Freight / waterfall | **PASS*** | `waterfall.js` dollar-default; freight table empty (F1 blocked) |
| W17 Price history | **PASS** | Trigger migration + `test/price-history.test.js` |
| W18 Self-service import | **PARTIAL** | API import paths exist; **CRM `DUTY_PLACEHOLDER = 0.07` FAIL** |
| W19 Reserves / cuttings | **DEVIATION** | `reserve_requests` / `reserve_lines` — not fifth `orders.kind` |
| W22 Scanner | **PASS** | `SampleScanner.jsx`, WASM decoder, `by-barcode` API |

\*W16 US-004 freight rate table intentionally empty until client resolves F1 — matches ADR posture.

---

## §4 Supersessions (prd-august-12th.md)

| ID | Decision | Shipped state |
|----|----------|---------------|
| **X1** | Xero in scope (reverse FR-8 non-goal) | **Implemented** — routes, CRM push UI; encryption gap remains |
| **X2** | Camera scanner (supersede ADR 001 wedge-only) | **Implemented** — `scannerDecoder.js`, lazy WASM; wedge path retained |
| **X3** | Cutting / reserves un-shelved | **Partial** — reserve dockets live; `/cutting` still demo + Charlotte disclaimer |
| **X4** | Freight dollar default, not flat 8% | **Implemented** — `waterfall.js` uses `freight_basis === 'percent'` only when set |
| **X5** | Orders deletable with guards | **Implemented** — lifecycle registry + `orderGuard`; fourth PO-line blocker |

**Reversed decisions verified absent in API seed path:** `src/seed/data/pricing.js` documents removal of 7% duty from the *seed* waterfall; **CRM import path not updated** (see findings).

---

## Demo / live / mirror map (CRM)

| Route / nav | Kind | Disclaimer? | Risk |
|-------------|------|-------------|------|
| SideNav **Catalogue** → `/catalogue` | **Demo** (`Catalogue.jsx`, localStorage) | **No** | **HIGH** — primary nav |
| `/admin/products`, `/admin/brands`, … | Live | — | OK |
| `/import` (Catalogue tab) | Live API wizard | — | OK |
| `/cutting` | Demo | Yes (“Preview — cutting process owed…”) | Medium |
| `/sales-orders`, Dynamics tabs | Mirror (GET-only) | “Dynamics (historical)” | OK |
| `/sales-orders/new`, `/clients/new` | Demo (orphan routes) | No | Low (bookmark only) |
| Orders → **New sales order** | Live `/admin/orders/new` | — | OK |

---

## Security pass / fail

| Control | Result | Notes |
|---------|--------|-------|
| CORS closed allowlist | **PASS** | `test/cors.test.js` 8/8 on Node 24 |
| CORS live preflight | **PASS*** | With `CRM_BASE_URL=http://localhost:5273` + `PORT=3001`; wrong env returns storefront origin |
| Rate limit `global: false` | **PASS** | Contact, order request, checkout, lookups opt in |
| Session / archived / pending trade | **PASS** (code) | `SESSION_USER_CONDITION`; not re-tested on drifted DB |
| Stripe webhook raw body | **PASS** | `webhooks.js` Buffer parser |
| Cost exposure to trade | **PASS** | `price-list-exposure.test.js`; reports masked separately in report tests |
| Reports in exposure suite | **GAP** | `/admin/reports/*` not in `price-list-exposure.test.js` (covered elsewhere) |
| Xero token encryption FR-166 | **FAIL** | `xero_connection.token_set` plain `jsonb`; no `XERO_TOKEN_KEY` |
| Xero commit-before-call FR-178 | **DEVIATION** | POST invoice then `UPDATE orders`; idempotency key + `WHERE xero_invoice_id IS NULL` |
| Secrets in repo | **PASS** | `.env.example` placeholders only |
| `legacy_cuttings` PII | **PASS** | `comments` excluded from `CUTTING_COLUMNS` |

---

## Engineering standards

| Check | Result |
|-------|--------|
| Migrations ESM | Mixed template vs shipped — team convention documented |
| Local `atelier_dev` vs migrations | **FAIL** — login 500 `phone` missing; test runner `image_url` duplicate |
| CRM direct `fetch` in screens | **PASS** — `api.js` only |
| Large files | `AdminOrders.jsx` **1130** lines (watch); PO routes **389** |
| Mailer no-throw | Pattern present in notifications |
| Numeric coercion | Documented; pg `numeric` as string |

---

## Findings by severity

### Blocker

1. **FR-166 — Xero tokens not encrypted at rest**  
   - `migrations/1789412800000_xero-connection.js` stores `token_set` as plain `jsonb`.  
   - No `aes-256-gcm` / `XERO_TOKEN_KEY` in `src/xero/`.  
   - **Action:** Implement encryption in `connection-store.js` before production Xero credentials.

### High

2. **W18 US-005 — 7% duty placeholder survives in CRM**  
   - `crm/src/utils/importer.js`: `DUTY_PLACEHOLDER = 0.07`  
   - `crm/src/data/pricing.js`: `duty: 0.07` (demo pricing waterfall)  
   - API seed explicitly removed this; PRD §4 / W18 require deletion.  
   - **Action:** Remove placeholder; surface “duty not set” in preview/import.

3. **Demo Catalogue on primary nav without disclaimer**  
   - `layout.jsx` lists Catalogue beside live admin routes; `/catalogue` uses demo data.  
   - **Action:** Banner, redirect to `/admin/products`, or demote nav item.

4. **Local database migration drift** — **RESOLVED for review** (see Retest appendix)  
   - **Root cause:** the old `atelier` DB was migrated under renamed migration filenames (`1788926400000_brand-image` applied, but `main` ships `1789489200000_brand-image.js`), so `npm run migrate` stalled and left `users.phone` missing.  
   - **Fix used:** fresh `atelier_review` DB + all 64 migrations + seed. Use `DATABASE_URL=postgresql://strapi:strapi@localhost:5432/atelier_review` in `api/.env`.

### Medium

5. **FR-178 / architecture — Xero sync log & commit order**  
   - `pushOrderInvoice` calls Xero POST before local `UPDATE`; no `xero_sync_log` table.  
   - Mitigated by idempotency key and duplicate `xero_invoice_id` gate; does not match PRD wording.

6. **FR-235 — Reserves not fifth `orders.kind`**  
   - `migrations/1789358400000_reserve-dockets.js` creates `reserve_requests` / `reserve_lines`.  
   - Functionally may be fine; PRD/ADR 003 and sprint tracker still describe widened CHECK.

7. **`sprint-status.yaml` stale vs `main`**  
   - W12–W22 marked `pending` while code is merged.  
   - **Action:** Refresh status or archive tracker to avoid false “not shipped” signal.

8. **Product sanity flows — API-verified; CRM UI not walked**  
   - Flow 5 (archive kills session): **PASS** live — `POST /admin/users/:id/archive` then `/auth/me` → 401.  
   - Flow 4 (trade approve → Clients): **PASS** live — applicant appears in `segment=clients` after `trade_approved: true`.  
   - Flows 1–3: **PASS** via test suites (`admin-orders`, `purchasing`, `supplier-invoices`, `orderPackingSlip`).  
   - Acceptance letter on approve: **not delivered** without SMTP (503 by design).  
   - CRM browser walk-through: not done (login form only; use staff credentials locally).

### Low

9. **Orphan demo routes** `/sales-orders/new`, `/clients/new` — bookmark confusion.  
10. **Cost exposure test scope** — add `/admin/reports/*` to `price-list-exposure.test.js` for parity.  
11. **Stale comment** in legacy client module still referencing pre-X1 Xero constraint (documentation only).

---

## Office-chair flows (planned vs observed)

| # | Flow | Code / test support | Live run (atelier_review) |
|---|------|---------------------|---------------------------|
| 1 | Find/filter/confirm/print SO without prices; web order alert | `admin-orders.test.js` (78), `orderPackingSlip.test.js` (17) | **PASS** (tests) |
| 2 | PO from confirmed → receipt → supplier invoice → double-bill | `purchasing.test.js` (84), `supplier-invoices.test.js` (50) | **PASS** (tests) |
| 3 | Supplier discount → `/pricing` waterfall labels | `pricing-parameters.test.js` (23); live route needs `can_view_finance` | **PASS** (tests) |
| 4 | Approve trade applicant → Clients + acceptance letter | Live: approve → in `segment=clients`; letter needs SMTP | **PASS** (partial — no mail) |
| 5 | Archive signed-in trade user → session dead | Live: archive → `/auth/me` 401 | **PASS** (live) |

---

## Tests executed

| Suite | Node | Result |
|-------|------|--------|
| `test/cors.test.js` | 24 | **8 passed** |
| Targeted security/commerce (6 files) | 24 | **218 passed** |
| Order desk + trade + price history (3 files) | 24 | **131 passed** |
| **Full `npm test`** | 24 | **2920 passed** (95 files) |
| CRM `orderPackingSlip.test.js` | 24 | **17 passed** |
| Live login + CORS preflight | 24 | **PASS** (`access-control-allow-origin: http://localhost:5273`) |
| CRM browser walk-through | — | Not completed (sign in manually at `http://localhost:5273`) |

---

## Recommendations (priority order)

1. Encrypt Xero `token_set` (FR-166) before any production Xero connection.  
2. Remove CRM `DUTY_PLACEHOLDER` and demo `duty: 0.07` (W18 US-005).  
3. Label or replace demo **Catalogue** on primary navigation.  
4. Update `sprint-status.yaml` (or replace with release checklist) to match `main`.  
5. Decide whether to amend PRD for `reserve_requests` model or refactor to fifth `orders.kind`.  
6. Optional: add `xero_sync_log` + commit-before-call if FR-178 remains a hard requirement.  
7. Keep using **`atelier_review`** (or drop/recreate `atelier`) — do not point the API at the old drifted `atelier` DB without repair.

---

## Sign-off posture

| Area | Verdict |
|------|---------|
| Feature completeness vs PRD | **Mostly shipped** — gaps above |
| Security for production | **Not ready** until Xero encryption (FR-166) |
| Engineering / test gate | **PASS** on fresh DB — 2920 API tests green |
| Office usability | **At risk** from demo Catalogue on main nav |
| Local dev setup | **PASS** — `atelier_review` + `.env` files written |

*Review performed against merged `main`/`master` only; branch `august-12th-updates` not separately diffed.*

---

## Retest appendix (14 Sep 2026, fresh DB)

### Environment written

| App | File | Key values |
|-----|------|------------|
| **api** | `api/.env` | `DATABASE_URL=postgresql://strapi:strapi@localhost:5432/atelier_review`, `PORT=3001`, `CRM_BASE_URL=http://localhost:5273`, `STORE_BASE_URL=http://localhost:4321` |
| **crm** | `crm/.env` | `VITE_API_BASE_URL=http://localhost:3001` |
| **storefront** | `storefront/.env` | `PUBLIC_API_BASE_URL=http://localhost:3001`, `SITE_URL=http://localhost:4321` |

### Database bootstrap

```bash
nvm use 24
PGPASSWORD=strapi createdb -h localhost -U strapi atelier_review   # once
cd api && npm run migrate && npm run seed && npm run seed:staff
```

Staff login: `elizabethd@atelier.co.nz` / `AtelierTemp2026!`

### Servers (review session)

- API: `http://127.0.0.1:3001` (`node src/server.js` from `api/`)
- CRM: `http://localhost:5273` (`npm run dev` from `crm/`)
