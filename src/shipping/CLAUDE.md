# atelier-api — shipping

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## Shipping

- `GET /shipping/quote?zone=&qty=` (`src/routes/shipping.js` + `src/shipping/rates.js`) — public flat-rate quote. `getShippingQuote` picks the highest tier whose `threshold_qty` floor is `<= qty` for the zone. Response `{ zone, qty, threshold_qty, rate_cents }`. Unknown zone (no rows) → 400 with a clear message; missing/invalid `zone`/`qty` → 400 by schema (Fastify coerces the querystring `qty` to a number). Boundary rule: at `qty == threshold` the higher tier applies (`<=`).
- `PUT /admin/shipping-rates` (backoffice) — body `{ rates: [{ zone, threshold_qty, rate_cents }] }`; `upsertShippingRates` upserts on `(zone, threshold_qty)` in one transaction (edit rate or add a tier without redeploy) and returns the full `{ rates }` list. Note: seed inserts rates `DO NOTHING`, so admin edits here are the mutation path and survive reseeds.

