# W9 Scanner spike — "August 6th updates"

A written recommendation on sample and showroom-sample scanning. Epic 9 of nine
(`_bmad-output/planning-artifacts/epics.md` § Epic 9). **Research only — no
code.** Not run under Ralph: a research task has no gates to verify against, so
a loop has nothing to stop on.

**Requires:** nothing.
**Blocks:** nothing. Informs W4, which owns the endpoint this recommends
pointing a scanner at.

Merge target: `august-6th-updates`. Delivered directly on that branch rather
than on `aug6/w9-scanner-spike` — see *Provenance* below.

---

## Stories

| # | Story | Repos | Commits |
|---|---|---|---|
| US-001 | Options matrix | api (docs) | `0fc323e` |
| US-002 | Recommendation | api (docs) | `0fc323e` |
| US-003 | ADR appended to `architecture.md` | api (docs) | `0fc323e` |

All three `passes: true`. No `BLOCKED.md`.

---

## What is in it

Two documents, no source file:

- `_bmad-output/planning-artifacts/research-sample-scanner.md` (new, 136 lines)
- `_bmad-output/planning-artifacts/architecture.md` — ADR 001 appended (35 lines,
  append only; no existing section restructured)

### The finding that shapes the answer

**`BarcodeDetector` is not implemented on iOS, in any browser.** Safari does not
have it, and because every iOS browser is WebKit underneath, Chrome and Firefox
on an iPhone or iPad do not either. The constructor is simply absent, so a web
app that calls it fails *silently* on every Apple device. Any browser-camera
option therefore carries a WebAssembly decoder — a real dependency and bundle
cost, not a footnote. If the showroom runs on iPads, which is the norm, the
native-API PWA is off the table entirely.

### The recommendation

**Start with a Bluetooth barcode scanner paired as a keyboard wedge. Keep the
WASM camera PWA as the documented fallback.**

- No camera API, no WebAssembly, no app store, no permission prompt. The web app
  needs one focused text input, which `SampleScanner.jsx` already has.
- Works on every device, so it sidesteps the iOS problem rather than working
  around it.
- Suits the physical workflow: samples are checked out and back in at a showroom
  counter, which is exactly where a wedge scanner beats a phone camera.
- Reversible. The camera path bolts on beside it later — both hit the same
  `GET /admin/samples/by-barcode/:barcode` endpoint that W4 builds, so nothing
  is wasted.
- Cost: roughly NZ$60–200 per unit, one per counter.

Each rejected option (WASM PWA, off-the-shelf inventory app, native app) carries
the condition under which it would win, so the comparison is re-runnable rather
than re-arguable.

### ADR 001

Status is **proposed, awaiting confirmation of the showroom device** — not
`accepted`. The device question is the single input that most changes the answer
and only Atelier can answer it. Consequences state the cost as well as the win:
scanning is tied to wherever the scanner sits, so shelf-walking with a phone is
not supported.

---

## Provenance and the bookkeeping gap

The handoff marks this workstream **do not run under Ralph** and it was not. It
ran as one supervised session and the deliverables were committed straight to
`august-6th-updates` as `0fc323e`, which is why there is no `aug6/w9-scanner-spike`
branch to merge.

That commit carried the two documents only. `prd.json` still read
`passes: false` on all three stories and `sprint-status.yaml` still read
`pending`, so the status board under-reported a finished workstream. A follow-up
commit closes that: the flag flips, the three `progress.txt` story entries and
this file. **No deliverable changed** — each story was re-checked against its
acceptance criteria in the committed documents before its flag was flipped.

---

## Gates

`( cd atelier-api && npm run lint && npm test )` — both exit 0.

Documents only; no source file is touched, so the suite is unchanged by this
work and green is a baseline check rather than evidence about the change.

---

## Needs human verification

1. **Confirm the showroom device (iPad vs laptop).** Flip ADR 001 to `accepted`
   once it is known; if the answer ever pushes towards the camera path, the WASM
   cost is unavoidable.
2. **Confirm the barcodes are Atelier-issued** (`ATL-0049-217` shape) and decide
   who prints them. A label printer is assumed everywhere and specified nowhere.
3. **W4 scope check.** `SampleScanner.jsx` still refers to a
   "Dataverse-vs-PWA backend call (§6.1)" as open. W4 answers it by putting the
   register in Postgres (`samples` / `sample_loans`). If Atelier still intends
   D365 to own sample tracking after cutover, re-scope W4 **before** it is
   built, not after.
