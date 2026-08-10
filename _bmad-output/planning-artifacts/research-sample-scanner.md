# Sample scanner — options and recommendation

**Workstream:** W9 · **Date:** 2026-08-06 · **Status:** decision required
**Deliverable of:** Epic 9. Research only — no code.

## The question

Atelier needs to scan physical samples in and out: the client loan register (a designer borrows a
cutting, returns it) and showroom stocking. The CRM already has a phone-frame preview at
`/sample-scanner` (`src/screens/SampleScanner.jsx`) that writes nothing — its own header records
that the backend choice was still open.

W4 gives it something real to call: `GET /admin/samples/by-barcode/:barcode`, which returns one
deterministic 200 or 404 rather than a filtered list, plus the `check-out` / `check-in` verb routes.
So the integration point is settled. What is not settled is **what does the scanning**.

Existing barcode format in the demo register is `ATL-0049-217` — an internal, Atelier-issued code,
not a supplier EAN. That matters: Atelier controls the symbology, so the scanner never has to cope
with damaged retail barcodes.

---

## The finding that shapes everything

**`BarcodeDetector` is not available on iOS.** Safari does not implement it, and because every iOS
browser is WebKit underneath, Chrome and Firefox on an iPhone do not either. A web app that calls
`BarcodeDetector` fails on every iPhone and iPad — and fails *silently*, because the constructor
simply isn't there.

Any option below that says "PWA" therefore means "PWA **plus** a WebAssembly decoder", not the
native browser API. That is an extra dependency and a real bundle-size cost, not a footnote.

If the showroom runs on iPads — which is the norm for a design showroom — the native-API PWA is off
the table entirely.

---

## Options

### A. Bluetooth scanner as a keyboard wedge — *recommended*

A cheap Bluetooth barcode scanner pairs as a keyboard. Focus a text input, pull the trigger, the
code arrives as typed characters followed by Enter. **No camera API, no WebAssembly, no app store,
no permissions prompt.**

- **Works everywhere** — iPad, iPhone, Android, laptop. The web app needs one focused input.
- **Integration:** near zero. `SampleScanner.jsx` already has the UI; point it at the by-barcode
  endpoint and let a keystroke sequence fill the field.
- **Hardware:** roughly NZ$60–200 per unit for a reputable 1D/2D model. One per showroom counter.
- **Ergonomics:** genuinely better than a camera for repetitive counter work — faster, works in poor
  light, no focus hunting, and staff can hold the sample in the other hand.
- **Weakness:** tethered to wherever the scanner is. Useless for walking a shelf with a phone.

### B. PWA with a WebAssembly decoder

Camera scanning in the browser, using a WASM build of a decoder (ZXing-family or a commercial SDK)
rather than `BarcodeDetector`.

- **Works on iOS** — that is the whole reason for the WASM dependency.
- **No app store**, installs to the home screen, updates when the site updates.
- **Cost:** open-source decoders are free but noticeably worse in poor light and at angles;
  commercial SDKs are reliable but licensed per year, typically four figures.
- **Weakness:** camera permission prompt, battery use, and decode quality is the thing staff will
  complain about. Adds a large dependency to a repo that currently has none for this.

### C. Off-the-shelf inventory app

A commercial asset-tracking app with its own scanner.

- **Fast to start**, no build.
- **Weakness, and it is decisive:** the sample register is not a generic asset list. It joins to
  `colourways`, `trade_accounts` and showrooms, and the loan history is a business record the trade
  portal reads. Either the app becomes a second source of truth that must be reconciled, or it needs
  an integration written anyway — at which point option A is cheaper and keeps one database.
- Also puts client names (the loan holder) into a third-party system, which is a privacy question
  nobody has asked yet.

### D. Native app

- **Best camera performance**, offline capable.
- **Weakness:** an app store presence, two platforms, signing, review cycles and a release process,
  for a feature used at a counter. Disproportionate.

---

## Recommendation

**Start with A (Bluetooth keyboard-wedge scanner). Keep B as the documented fallback.**

Reasoning:

1. It is the only option with **no software dependency at all** — no WASM bundle, no SDK licence, no
   app store, no camera permission. The web app needs one focused text input, which the existing
   screen already has.
2. It sidesteps the iOS problem completely rather than working around it.
3. The physical workflow is counter-based. Samples are checked out when a designer is at the
   showroom desk and checked in when they come back to it. That is exactly where a wedge scanner
   wins and a phone camera loses.
4. It is reversible. If Atelier later wants shelf-walking with a phone, option B bolts on beside it —
   both paths hit the same `by-barcode` endpoint, so nothing is wasted.

**What would have to be true for each rejected option to win:**

- **B wins** if staff need to scan away from a counter — stocktaking a wall, or a second showroom
  without hardware. Revisit if that becomes routine.
- **C wins** if Atelier decides sample tracking should live outside the platform entirely. That is a
  strategy decision, not a technical one, and it contradicts W4.
- **D wins** only with offline scanning in a place with no Wi-Fi. No such requirement has been stated.

---

## What this needs from Atelier

1. **Confirm the showroom device.** If iPads, option B's native-API path is impossible and the WASM
   cost is unavoidable should you ever choose B. This is the single question that most changes the
   answer.
2. **Confirm barcodes are Atelier-issued** (`ATL-0049-217` shape) and decide who prints them. A
   label printer is a separate small purchase and is assumed, not specified, anywhere.
3. **Decide whether loan holders may be named in a third-party system** — only relevant if C is
   revisited.

## Open dependency

The `/sample-scanner` screen's own comment refers to a "Dataverse-vs-PWA backend call (§6.1)" as
still open. W4 answers it for this platform: the register lives in `samples` / `sample_loans` in
Postgres, not in Dataverse. If Atelier still intends D365 to own sample tracking after cutover, W4
should be re-scoped before it is built — say so now rather than after.

---

## Sources

- [Barcode Detection API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API)
- [BarcodeDetector support table — Can I use](https://caniuse.com/mdn-api_barcodedetector)
- [Barcode scanning on iOS: the missing web API and a WebAssembly solution](https://dev.to/ilhannegis/barcode-scanning-on-ios-the-missing-web-api-and-a-webassembly-solution-2in2)
- [Barcode Detection API tutorial — Scanbot SDK](https://scanbot.io/techblog/barcode-detection-api-tutorial/)
