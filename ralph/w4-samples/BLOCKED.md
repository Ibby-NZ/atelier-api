# BLOCKED — W4 Samples

A human clears a block by removing the `BLOCKED:` prefix from that story's `notes` in
`ralph/w4-samples/prd.json`. A Ralph iteration never retries one by itself.

---

## W4-US-005 — Sample CRUD routes and by-barcode lookup

**Blocked:** 2026-08-06. Nothing was written; the working tree is clean at
`9d06df4 feat(api): [W4-US-004]`.

### What the story needs

| Acceptance criterion | Status |
|---|---|
| `GET /admin/samples/by-barcode/:barcode` returns 200 or 404, never a filtered list | needs a **registered** route |
| `POST` returns 409 on a duplicate barcode, detected by the database | needs a **registered** route |
| `DELETE` is blocked by `sample_loans` | needs a `sample` **registry entry** |
| Gates green | — |

### The two files it needs, both outside this workstream's allowed file list

**1. `src/app.js` — nothing registers a sample route, so a route file would be dead code.**

```
$ grep -n "routes/" src/app.js
… 18 route modules, none of them samples …
$ ls src/routes/ | grep -i sample
(no output)
```

There is no plugin auto-loader in this repo: every route module is an explicit
`api.register(<module>, { pool })` inside `buildApp`. A `src/routes/admin-samples.js` that
`buildApp` never registers is unreachable — `app.inject()` would 404 every path in it, so none of
the three status-code criteria above can even be asserted, and nothing would ship.

Standing up a bare Fastify instance in the test instead does not work either: the route needs
`app.guards.requireRole('backoffice')`, and `guards` is decorated onto the instance by `buildApp`
(`src/app.js:60`, `app.decorate('guards', createGuards(pool))`). A hand-rolled test app has no
guards, so it would prove the handlers work while proving nothing about the authorisation every
other `/admin/*` route in this API carries.

**2. `src/lifecycle/registry.js` — there is no `sample` entry, so the DELETE blocker cannot exist.**

```
$ grep -n "sample" src/lifecycle/registry.js
27:// Entities whose tables do not exist yet (samples, sample orders and sample
$ grep -n "^  [a-z_]*: {" src/lifecycle/registry.js
brand, collection, product, colourway, inventory, price_list_item,
supplier, user, shipping_rate, contact_enquiry, order          (11 entries, no sample)
```

`deleteOrExplain(pool, 'sample', …)` resolves through `requireEntity`, which throws a plain Error
(a **500**) for an unknown name. So the delete route cannot be written against the shared module
until the entry exists.

### Why this is a decision and not a tidy-up

The two sources of record disagree about who owns the registry:

- `src/lifecycle/registry.js:27-30` and `atelier-api/CLAUDE.md` (§ CRUD completion) both say the
  workstream that **creates** the tables adds the entries — that is E4, this workstream.
- This loop's file list gives E4 `migrations/*samples*`, `src/samples/**`,
  `src/routes/admin-samples.js` and `test/samples*.test.js` only. `src/lifecycle/` is E2's.

W4-US-001, US-002 and US-004 each flagged this in `progress.txt` and deliberately left the registry
alone. US-005 is the story that cannot route around it.

The workaround a reviewer might propose — catch the RESTRICT FK's 23503 on `sample_loans_sample_id_fkey`
and answer 409 from inside `src/samples/` — is refused here on purpose. `atelier-api/CLAUDE.md`
states that the probe is the primary defence and the 23503 catch is only the backstop, and the 409
envelope (`{ message, blockers: [{ relation, label, count, capped }], archivable }`) is a shared
contract the CRM's `describeBlockers` / `ConfirmDialog` kit consumes. A second, divergent
implementation of it inside a domain folder is exactly the kind of thing a human should sign off,
not an autonomous iteration.

### What a human must decide

1. **Widen this workstream's allowed files to include `src/app.js`** (one `import` + one
   `api.register(adminSampleRoutes, { pool })`), or nominate who adds the registration.
   **US-006 and US-007 need this too** — they are also route stories — so deciding it once
   unblocks three stories rather than one.
2. **Widen it to include `src/lifecycle/registry.js`**, or hand E2 the four entries the delete
   policy in `architecture.md` calls for:
   - `sample` — probe `sample_loans`, `archivable: true` (the column exists)
   - `sample order` — guard: 409 unless `requested`/`cancelled` (US-007)
   - `sample loan` — guard: 409 while `returned_at IS NULL` (US-006)
   - a `samples` probe added to the existing `product` and `colourway` entries, which
     `atelier-api/CLAUDE.md` records as owed since the tables did not exist when E2 ran
3. Or **rewrite US-005's third criterion** to accept the bare 23503 catch, accepting that the
   samples domain answers a delete refusal in a shape the CRM delete kit does not understand.

Option 1 + 2 is one edit each and keeps every house rule intact.
