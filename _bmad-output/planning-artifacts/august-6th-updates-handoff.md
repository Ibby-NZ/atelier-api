# Handoff — Atelier "August 6th updates"

Nine workstreams across three repos. Each section below is self-contained: run **Block A** in a
terminal, then paste **Block B** into a fresh Claude Code instance (or just launch the Ralph loop,
which uses the same instructions from `ralph/<ws>/CLAUDE.md`).

Generated from `ralph/generate.mjs` and `ralph/CLAUDE.template.md`. To change a brief, edit the
spec and regenerate — do not hand-edit this file.

## Before anything

Wave 0 is done: the three dirty working trees are parked on branches, `august-6th-updates` exists
in all three repos, and BMAD v6.10.0 is installed. `main`/`master` are untouched and must stay that
way.

Baseline SHAs — these must be unchanged when the work is finished:

| Repo | Branch | SHA |
|---|---|---|
| atelier-api | main | `5d19d48a61885cac7939f4349c5c34f5690a765f` |
| atelier-crm | **master** | `0989524f6064fb821694998c2054ee0fd4aebe09` |
| atelier-storefront | main | `f5cfc5eae3197a3a8c58db3821138425a3c6d9d6` |

Note the CRM's default branch is `master`, not `main`. Nothing may assume otherwise.

## Ground rules

- **Nothing touches `main`/`master`.** The live sites and API run off them. `ralph.sh` blocks
  `git push`, `rebase`, `merge`, `stash`, `reset`, `switch` and `branch` at the tool level, not just
  in the prompt. A human merges into `august-6th-updates`.
- **No `--dangerously-skip-permissions`.** The loop runs a scoped allowlist. Expect W1 — which runs
  alone and supervised — to stall once or twice on a legitimate command; widen `ALLOWED` in
  `ralph.sh` rather than reaching for `bypassPermissions`.
- **One database per workstream.** The API test suite migrates a real Postgres and node-pg-migrate
  takes an advisory lock, so two loops sharing `atelier_dev` deadlock and cross-contaminate
  fixtures — failures that read as code bugs and send an agent off fixing working code.
- **There is no typecheck in any repo.** All three are plain JavaScript. Never write "Typecheck
  passes" into an acceptance criterion.
- **Concurrency cap: 3 loops.** A review-throughput limit, not a technical one.

## Wave schedule

```
Wave 1   w1-foundations   ALONE and supervised — everything depends on it
         w8-colour-files  concurrent, disjoint file footprint
         w9-scanner-spike concurrent, docs only, NOT under Ralph

Wave 2   w2-crud | w3-suppliers | w7-featured

Wave 3   w4-samples | w6-category-export

Wave 4   w5-reporting
```

Merge order within a workstream is always **api → crm → storefront**. A merged CRM screen calling a
not-yet-merged endpoint 404s, and the next workstream's agent will misdiagnose it.

## After each loop finishes

1. `./atelier-api/ralph/verify.sh <ws>` from the workstream root — commit the log. That turns
   "gates were green" from a claim into an artefact.
2. Review in a **fresh** Claude instance in the same worktree: the `bmad-code-review` skill, then
   the `code-reviewer` agent on the branch diff; add `database-reviewer` if `migrations/` changed
   and `security-reviewer` for W2, W3, W5 and W8.
3. Cross-repo drift check: every API path in the CRM/storefront diff must resolve to a route on the
   branch or on `august-6th-updates`.
4. Merge api → crm → storefront, then tear down the worktree and drop the database.

## Reference

| What | Where |
|---|---|
| Requirements | `_bmad-output/planning-artifacts/prd.md` |
| Architecture | `_bmad-output/planning-artifacts/architecture.md` |
| Epics (1:1 with workstreams) | `_bmad-output/planning-artifacts/epics.md` |
| Cross-repo rules and gates | `_bmad-output/project-context.md` |
| Status board | `_bmad-output/implementation-artifacts/sprint-status.yaml` |
| Loop mechanics | `ralph/README.md` |

## The nine briefs

---

## W1 Foundations — `w1-foundations`  ·  Wave 1  ·  6 stories

The shared delete/archive lifecycle module in the API and the CRM CRUD kit that every other workstream consumes. Runs alone; nothing else starts until this merges.

**Requires:** nothing — this is first  
**Blocks:** W2, W3, W4, W5, W6, W7  
**Repos:** atelier-api, atelier-crm, atelier-storefront

### Block A — SETUP (you run this in a terminal, once)

```bash
set -e
WS=w1-foundations
ROOT=/Users/verumoffice/atelier-worktrees/$WS
mkdir -p "$ROOT"

# worktrees
git -C /Users/verumoffice/atelier-api worktree add -b aug6/$WS "$ROOT/atelier-api" august-6th-updates
git -C /Users/verumoffice/atelier-crm worktree add -b aug6/$WS "$ROOT/atelier-crm" august-6th-updates
git -C /Users/verumoffice/atelier-storefront worktree add -b aug6/$WS "$ROOT/atelier-storefront" august-6th-updates

# node_modules symlinked — a story needing a NEW dependency must mark itself BLOCKED
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"
ln -s /Users/verumoffice/atelier-crm/node_modules "$ROOT/atelier-crm/node_modules"
ln -s /Users/verumoffice/atelier-storefront/node_modules "$ROOT/atelier-storefront/node_modules"

# gitignored files a worktree does not inherit
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

# this workstream's own database — never share atelier_dev between concurrent loops
createdb atelier_w1
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/atelier_w1|" "$ROOT/atelier-api/.env"
( cd "$ROOT/atelier-api" && npm run migrate )

# gates must be green BEFORE the loop starts (these run from the workstream root)
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
( cd atelier-storefront && npm run lint && npm test && npm run build )
```

Launch:

```bash
cd /Users/verumoffice/atelier-worktrees/w1-foundations
./atelier-api/ralph/ralph.sh w1-foundations 9
```

Teardown after merge:

```bash
git -C /Users/verumoffice/atelier-api worktree remove /Users/verumoffice/atelier-worktrees/w1-foundations/atelier-api
git -C /Users/verumoffice/atelier-crm worktree remove /Users/verumoffice/atelier-worktrees/w1-foundations/atelier-crm
git -C /Users/verumoffice/atelier-storefront worktree remove /Users/verumoffice/atelier-worktrees/w1-foundations/atelier-storefront
dropdb atelier_w1
rmdir /Users/verumoffice/atelier-worktrees/w1-foundations
```

### Block B — BRIEF (paste this whole block into a fresh Claude Code instance)

````markdown
# TASK: W1 Foundations (Atelier, "August 6th updates")

## Goal
The shared delete/archive lifecycle module in the API and the CRM CRUD kit that every other workstream consumes. Runs alone; nothing else starts until this merges.

## Where you are working
- Working directory: `/Users/verumoffice/atelier-worktrees/w1-foundations` — **not a git repo, no CLAUDE.md, nothing auto-loads**
- `atelier-api/` — worktree of /Users/verumoffice/atelier-api, branch `aug6/w1-foundations`
- `atelier-crm/` — worktree of /Users/verumoffice/atelier-crm, branch `aug6/w1-foundations`
- `atelier-storefront/` — worktree of /Users/verumoffice/atelier-storefront, branch `aug6/w1-foundations`
- Merge target: `august-6th-updates` in each repo. **Never touch `main`/`master`** — the live sites and API run off them.
- Database: `atelier_w1` (already set in atelier-api/.env). Never use `atelier_dev`; other loops use theirs.
- **These are plain-JavaScript repos. There is no typecheck anywhere. Do not look for one.**

## Read these first, in this order
1. `atelier-api/ralph/w1-foundations/progress.txt` — the `## Codebase Patterns` block at the top
2. `atelier-api/ralph/w1-foundations/prd.json` — your story list
3. `atelier-api/ralph/w1-foundations/CLAUDE.md` — your full operating instructions; this brief is a summary of it
4. `atelier-api/_bmad-output/project-context.md` — cross-repo rules and the real gates
5. `atelier-api/CLAUDE.md` and `atelier-crm/CLAUDE.md` and `atelier-storefront/CLAUDE.md`
6. `atelier-api/_bmad-output/planning-artifacts/architecture.md` — only the sections your story names

## Dependencies
- **Requires:** nothing — this is first
- **Blocks:** W2, W3, W4, W5, W6, W7

## Files you MAY touch
- atelier-api: `src/lifecycle/**`, `test/lifecycle*.test.js`, the eight archive helpers (`src/catalogue/admin-brands.js`, `admin-products.js`, `src/pricing/admin-price-lists.js`, `src/orders/admin-orders.js`, `src/users/admin-users.js`, `src/contact/contact.js`) — ONLY to swap their UPDATE fragment for the shared one
- atelier-api: `.github/workflows/ci.yml`
- atelier-crm: `src/admin/list.js`, `useAdminList.js`, `Pagination.jsx`, `ConfirmDialog.jsx`, `deleteFlow.js`, `useCrudScreen.js` + their `.test.js` siblings; `src/lib/api.js` (append `apiDelete` only); `.github/workflows/ci.yml`
- atelier-storefront: `.github/workflows/ci.yml` ONLY — nothing else in that repo
- All three repos: `CLAUDE.md` under a `## Foundations` heading

## Files you MUST NOT touch
- Any new route file or endpoint — W2 owns those. This workstream ships the mechanism, not its callers.
- Any migration — no schema change belongs here.
- Any CRM screen file (`src/screens/**`) — the kit is consumed by W2 onward.
- Anything in `atelier-storefront/src/**` — W7 owns that repo. You are here only for its CI workflow.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY. Never write, move or delete.
- Any `.env` file. `.env.example` may be edited; `.env` never.
- `package.json` dependencies — `node_modules` is a symlink to the main checkout, so adding a
  dependency corrupts every other checkout on this machine. If a story genuinely needs one, mark it
  BLOCKED and say so.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY.
- Any `.env`. Any `package.json` dependency — `node_modules` is a symlink to the main checkout.

## Gates (run before every commit; all must exit 0)
```bash
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
( cd atelier-storefront && npm run lint && npm test && npm run build )
```
Migration stories also: run `npm run migrate` twice and prove the second run is a no-op.

## How to work
One story per turn — the lowest `priority` in prd.json where `passes` is false and `notes` does not start `BLOCKED:`. Implement it, run the gates, then commit:

    feat(api): [W1-US-XXX] - <Story Title>

Use `crm`/`store` as the scope for those repos. A story touching two repos produces two commits with the SAME `[W1-US-XXX]` tag — that tag is how a reviewer reassembles a cross-repo change.

The same commit must also carry: `prd.json` `passes: true`, the `sprint-status.yaml` flip, and the `progress.txt` append block with a **Learnings:** section.

**NEVER** run `git push`, `rebase`, `merge`, `stash`, `reset`, `switch`, `branch` or any `--force`. A human merges. These are blocked at the tool level — a denial is the system working, not an obstacle to route around.

## When a story cannot pass
Two honest attempts, then set `notes: "BLOCKED: <reason>"`, write `ralph/w1-foundations/BLOCKED.md`, revert the partial code, commit only the bookkeeping, and move on. Never retry a blocked story. Anything needing a product decision — a schema shape architecture.md does not cover, a file another workstream owns, a dependency you think you need — is BLOCKED. Do not decide it yourself.

## Done means
All 6 stories `passes: true`, no BLOCKED.md, gates green, `PR-BODY.md` written, then reply with:

    <promise>COMPLETE</promise>
````


---

## W2 CRUD completion — `w2-crud`  ·  Wave 2  ·  12 stories

Every dataset the CRM shows gains full create, read, update and delete — including the DELETE endpoints the API has never had, and a standalone Collections screen.

**Requires:** W1 merged into august-6th-updates in both repos  
**Blocks:** W5 (reporting reads these models)  
**Repos:** atelier-api, atelier-crm

### Block A — SETUP (you run this in a terminal, once)

```bash
set -e
WS=w2-crud
ROOT=/Users/verumoffice/atelier-worktrees/$WS
mkdir -p "$ROOT"

# worktrees
git -C /Users/verumoffice/atelier-api worktree add -b aug6/$WS "$ROOT/atelier-api" august-6th-updates
git -C /Users/verumoffice/atelier-crm worktree add -b aug6/$WS "$ROOT/atelier-crm" august-6th-updates

# node_modules symlinked — a story needing a NEW dependency must mark itself BLOCKED
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"
ln -s /Users/verumoffice/atelier-crm/node_modules "$ROOT/atelier-crm/node_modules"

# gitignored files a worktree does not inherit
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

# this workstream's own database — never share atelier_dev between concurrent loops
createdb atelier_w2
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/atelier_w2|" "$ROOT/atelier-api/.env"
( cd "$ROOT/atelier-api" && npm run migrate )

# gates must be green BEFORE the loop starts (these run from the workstream root)
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```

Launch:

```bash
cd /Users/verumoffice/atelier-worktrees/w2-crud
./atelier-api/ralph/ralph.sh w2-crud 18
```

Teardown after merge:

```bash
git -C /Users/verumoffice/atelier-api worktree remove /Users/verumoffice/atelier-worktrees/w2-crud/atelier-api
git -C /Users/verumoffice/atelier-crm worktree remove /Users/verumoffice/atelier-worktrees/w2-crud/atelier-crm
dropdb atelier_w2
rmdir /Users/verumoffice/atelier-worktrees/w2-crud
```

### Block B — BRIEF (paste this whole block into a fresh Claude Code instance)

````markdown
# TASK: W2 CRUD completion (Atelier, "August 6th updates")

## Goal
Every dataset the CRM shows gains full create, read, update and delete — including the DELETE endpoints the API has never had, and a standalone Collections screen.

## Where you are working
- Working directory: `/Users/verumoffice/atelier-worktrees/w2-crud` — **not a git repo, no CLAUDE.md, nothing auto-loads**
- `atelier-api/` — worktree of /Users/verumoffice/atelier-api, branch `aug6/w2-crud`
- `atelier-crm/` — worktree of /Users/verumoffice/atelier-crm, branch `aug6/w2-crud`
- Merge target: `august-6th-updates` in each repo. **Never touch `main`/`master`** — the live sites and API run off them.
- Database: `atelier_w2` (already set in atelier-api/.env). Never use `atelier_dev`; other loops use theirs.
- **These are plain-JavaScript repos. There is no typecheck anywhere. Do not look for one.**

## Read these first, in this order
1. `atelier-api/ralph/w2-crud/progress.txt` — the `## Codebase Patterns` block at the top
2. `atelier-api/ralph/w2-crud/prd.json` — your story list
3. `atelier-api/ralph/w2-crud/CLAUDE.md` — your full operating instructions; this brief is a summary of it
4. `atelier-api/_bmad-output/project-context.md` — cross-repo rules and the real gates
5. `atelier-api/CLAUDE.md` and `atelier-crm/CLAUDE.md`
6. `atelier-api/_bmad-output/planning-artifacts/architecture.md` — only the sections your story names

## Dependencies
- **Requires:** W1 merged into august-6th-updates in both repos
- **Blocks:** W5 (reporting reads these models)

## Files you MAY touch
- atelier-api: `src/routes/admin-catalogue.js`, `admin-inventory.js`, `admin-orders.js`, `admin-price-lists.js`, `src/routes/shipping.js`; `src/catalogue/admin-products.js`, `admin-brands.js`; `src/inventory/**`, `src/shipping/rates.js`; `test/admin-*.test.js`
- atelier-crm: `src/screens/AdminProducts.jsx`, `AdminStock.jsx`, `AdminOrders.jsx`, `AdminPriceListItems.jsx`, `ClientAccounts.jsx`, `UserManagement.jsx`, new `AdminCollections.jsx`, new `AdminShipping.jsx`; `src/App.jsx`, `src/components/layout.jsx`, `src/components/sectionTabs.jsx`
- Both repos: `CLAUDE.md` under a `## CRUD completion` heading

## Files you MUST NOT touch
- `src/suppliers/**`, `src/routes/admin-suppliers.js`, CRM `AdminSuppliers.jsx` — owned by W3
- Anything in atelier-storefront, and `src/catalogue/brands.js` / `collections.js` public read models — owned by W7
- `src/admin/**` in the CRM and `src/lifecycle/**` in the API — owned by W1; consume them, do not edit them
- Any `src/reports/**` — owned by W5
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY. Never write, move or delete.
- Any `.env` file. `.env.example` may be edited; `.env` never.
- `package.json` dependencies — `node_modules` is a symlink to the main checkout, so adding a
  dependency corrupts every other checkout on this machine. If a story genuinely needs one, mark it
  BLOCKED and say so.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY.
- Any `.env`. Any `package.json` dependency — `node_modules` is a symlink to the main checkout.

## Gates (run before every commit; all must exit 0)
```bash
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```
Migration stories also: run `npm run migrate` twice and prove the second run is a no-op.

## How to work
One story per turn — the lowest `priority` in prd.json where `passes` is false and `notes` does not start `BLOCKED:`. Implement it, run the gates, then commit:

    feat(api): [W2-US-XXX] - <Story Title>

Use `crm`/`store` as the scope for those repos. A story touching two repos produces two commits with the SAME `[W2-US-XXX]` tag — that tag is how a reviewer reassembles a cross-repo change.

The same commit must also carry: `prd.json` `passes: true`, the `sprint-status.yaml` flip, and the `progress.txt` append block with a **Learnings:** section.

**NEVER** run `git push`, `rebase`, `merge`, `stash`, `reset`, `switch`, `branch` or any `--force`. A human merges. These are blocked at the tool level — a denial is the system working, not an obstacle to route around.

## When a story cannot pass
Two honest attempts, then set `notes: "BLOCKED: <reason>"`, write `ralph/w2-crud/BLOCKED.md`, revert the partial code, commit only the bookkeeping, and move on. Never retry a blocked story. Anything needing a product decision — a schema shape architecture.md does not cover, a file another workstream owns, a dependency you think you need — is BLOCKED. Do not decide it yourself.

## Done means
All 12 stories `passes: true`, no BLOCKED.md, gates green, `PR-BODY.md` written, then reply with:

    <promise>COMPLETE</promise>
````


---

## W3 Suppliers — `w3-suppliers`  ·  Wave 2  ·  7 stories

Suppliers become a first-class domain linkable to brands, and products gain the category column that unblocks W6.

**Requires:** W1 merged into august-6th-updates in both repos  
**Blocks:** W6 (needs products.category)  
**Repos:** atelier-api, atelier-crm

### Block A — SETUP (you run this in a terminal, once)

```bash
set -e
WS=w3-suppliers
ROOT=/Users/verumoffice/atelier-worktrees/$WS
mkdir -p "$ROOT"

# worktrees
git -C /Users/verumoffice/atelier-api worktree add -b aug6/$WS "$ROOT/atelier-api" august-6th-updates
git -C /Users/verumoffice/atelier-crm worktree add -b aug6/$WS "$ROOT/atelier-crm" august-6th-updates

# node_modules symlinked — a story needing a NEW dependency must mark itself BLOCKED
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"
ln -s /Users/verumoffice/atelier-crm/node_modules "$ROOT/atelier-crm/node_modules"

# gitignored files a worktree does not inherit
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

# this workstream's own database — never share atelier_dev between concurrent loops
createdb atelier_w3
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/atelier_w3|" "$ROOT/atelier-api/.env"
( cd "$ROOT/atelier-api" && npm run migrate )

# gates must be green BEFORE the loop starts (these run from the workstream root)
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```

Launch:

```bash
cd /Users/verumoffice/atelier-worktrees/w3-suppliers
./atelier-api/ralph/ralph.sh w3-suppliers 11
```

Teardown after merge:

```bash
git -C /Users/verumoffice/atelier-api worktree remove /Users/verumoffice/atelier-worktrees/w3-suppliers/atelier-api
git -C /Users/verumoffice/atelier-crm worktree remove /Users/verumoffice/atelier-worktrees/w3-suppliers/atelier-crm
dropdb atelier_w3
rmdir /Users/verumoffice/atelier-worktrees/w3-suppliers
```

### Block B — BRIEF (paste this whole block into a fresh Claude Code instance)

````markdown
# TASK: W3 Suppliers (Atelier, "August 6th updates")

## Goal
Suppliers become a first-class domain linkable to brands, and products gain the category column that unblocks W6.

## Where you are working
- Working directory: `/Users/verumoffice/atelier-worktrees/w3-suppliers` — **not a git repo, no CLAUDE.md, nothing auto-loads**
- `atelier-api/` — worktree of /Users/verumoffice/atelier-api, branch `aug6/w3-suppliers`
- `atelier-crm/` — worktree of /Users/verumoffice/atelier-crm, branch `aug6/w3-suppliers`
- Merge target: `august-6th-updates` in each repo. **Never touch `main`/`master`** — the live sites and API run off them.
- Database: `atelier_w3` (already set in atelier-api/.env). Never use `atelier_dev`; other loops use theirs.
- **These are plain-JavaScript repos. There is no typecheck anywhere. Do not look for one.**

## Read these first, in this order
1. `atelier-api/ralph/w3-suppliers/progress.txt` — the `## Codebase Patterns` block at the top
2. `atelier-api/ralph/w3-suppliers/prd.json` — your story list
3. `atelier-api/ralph/w3-suppliers/CLAUDE.md` — your full operating instructions; this brief is a summary of it
4. `atelier-api/_bmad-output/project-context.md` — cross-repo rules and the real gates
5. `atelier-api/CLAUDE.md` and `atelier-crm/CLAUDE.md`
6. `atelier-api/_bmad-output/planning-artifacts/architecture.md` — only the sections your story names

## Dependencies
- **Requires:** W1 merged into august-6th-updates in both repos
- **Blocks:** W6 (needs products.category)

## Files you MAY touch
- atelier-api: `migrations/*suppliers*`, `migrations/*product-category*`, `src/suppliers/**`, `src/routes/admin-suppliers.js`, `src/seed/**` (supplier backfill only), `test/suppliers*.test.js`; `src/catalogue/products.js` FILTER_COLUMNS + the product update whitelist (category only)
- atelier-crm: new `src/screens/AdminSuppliers.jsx`, `src/lib/api.js` (append supplier calls only), `src/components/sectionTabs.jsx` (add suppliersTabs only)
- Both repos: `CLAUDE.md` under a `## Suppliers` heading

## Files you MUST NOT touch
- `src/routes/admin-catalogue.js`, `admin-inventory.js`, `admin-orders.js`, `admin-price-lists.js` — owned by W2
- CRM `AdminProducts.jsx`, `AdminStock.jsx`, `AdminOrders.jsx`, `AdminCollections.jsx` — owned by W2
- CRM `AdminBrands.jsx`, `src/catalogue/brands.js`, atelier-storefront — owned by W7
- The existing demo `src/screens/Suppliers.jsx` — it stays as-is; add the live screen beside it
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY. Never write, move or delete.
- Any `.env` file. `.env.example` may be edited; `.env` never.
- `package.json` dependencies — `node_modules` is a symlink to the main checkout, so adding a
  dependency corrupts every other checkout on this machine. If a story genuinely needs one, mark it
  BLOCKED and say so.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY.
- Any `.env`. Any `package.json` dependency — `node_modules` is a symlink to the main checkout.

## Gates (run before every commit; all must exit 0)
```bash
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```
Migration stories also: run `npm run migrate` twice and prove the second run is a no-op.

## How to work
One story per turn — the lowest `priority` in prd.json where `passes` is false and `notes` does not start `BLOCKED:`. Implement it, run the gates, then commit:

    feat(api): [W3-US-XXX] - <Story Title>

Use `crm`/`store` as the scope for those repos. A story touching two repos produces two commits with the SAME `[W3-US-XXX]` tag — that tag is how a reviewer reassembles a cross-repo change.

The same commit must also carry: `prd.json` `passes: true`, the `sprint-status.yaml` flip, and the `progress.txt` append block with a **Learnings:** section.

**NEVER** run `git push`, `rebase`, `merge`, `stash`, `reset`, `switch`, `branch` or any `--force`. A human merges. These are blocked at the tool level — a denial is the system working, not an obstacle to route around.

## When a story cannot pass
Two honest attempts, then set `notes: "BLOCKED: <reason>"`, write `ralph/w3-suppliers/BLOCKED.md`, revert the partial code, commit only the bookkeeping, and move on. Never retry a blocked story. Anything needing a product decision — a schema shape architecture.md does not cover, a file another workstream owns, a dependency you think you need — is BLOCKED. Do not decide it yourself.

## Done means
All 7 stories `passes: true`, no BLOCKED.md, gates green, `PR-BODY.md` written, then reply with:

    <promise>COMPLETE</promise>
````


---

## W4 Samples — `w4-samples`  ·  Wave 3  ·  9 stories

A real samples register and showroom stocking domain, replacing three demo screens that persist nothing.

**Requires:** W1 merged; W3 merged (supplier FK)  
**Blocks:** nothing  
**Repos:** atelier-api, atelier-crm

### Block A — SETUP (you run this in a terminal, once)

```bash
set -e
WS=w4-samples
ROOT=/Users/verumoffice/atelier-worktrees/$WS
mkdir -p "$ROOT"

# worktrees
git -C /Users/verumoffice/atelier-api worktree add -b aug6/$WS "$ROOT/atelier-api" august-6th-updates
git -C /Users/verumoffice/atelier-crm worktree add -b aug6/$WS "$ROOT/atelier-crm" august-6th-updates

# node_modules symlinked — a story needing a NEW dependency must mark itself BLOCKED
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"
ln -s /Users/verumoffice/atelier-crm/node_modules "$ROOT/atelier-crm/node_modules"

# gitignored files a worktree does not inherit
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

# this workstream's own database — never share atelier_dev between concurrent loops
createdb atelier_w4
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/atelier_w4|" "$ROOT/atelier-api/.env"
( cd "$ROOT/atelier-api" && npm run migrate )

# gates must be green BEFORE the loop starts (these run from the workstream root)
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```

Launch:

```bash
cd /Users/verumoffice/atelier-worktrees/w4-samples
./atelier-api/ralph/ralph.sh w4-samples 14
```

Teardown after merge:

```bash
git -C /Users/verumoffice/atelier-api worktree remove /Users/verumoffice/atelier-worktrees/w4-samples/atelier-api
git -C /Users/verumoffice/atelier-crm worktree remove /Users/verumoffice/atelier-worktrees/w4-samples/atelier-crm
dropdb atelier_w4
rmdir /Users/verumoffice/atelier-worktrees/w4-samples
```

### Block B — BRIEF (paste this whole block into a fresh Claude Code instance)

````markdown
# TASK: W4 Samples (Atelier, "August 6th updates")

## Goal
A real samples register and showroom stocking domain, replacing three demo screens that persist nothing.

## Where you are working
- Working directory: `/Users/verumoffice/atelier-worktrees/w4-samples` — **not a git repo, no CLAUDE.md, nothing auto-loads**
- `atelier-api/` — worktree of /Users/verumoffice/atelier-api, branch `aug6/w4-samples`
- `atelier-crm/` — worktree of /Users/verumoffice/atelier-crm, branch `aug6/w4-samples`
- Merge target: `august-6th-updates` in each repo. **Never touch `main`/`master`** — the live sites and API run off them.
- Database: `atelier_w4` (already set in atelier-api/.env). Never use `atelier_dev`; other loops use theirs.
- **These are plain-JavaScript repos. There is no typecheck anywhere. Do not look for one.**

## Read these first, in this order
1. `atelier-api/ralph/w4-samples/progress.txt` — the `## Codebase Patterns` block at the top
2. `atelier-api/ralph/w4-samples/prd.json` — your story list
3. `atelier-api/ralph/w4-samples/CLAUDE.md` — your full operating instructions; this brief is a summary of it
4. `atelier-api/_bmad-output/project-context.md` — cross-repo rules and the real gates
5. `atelier-api/CLAUDE.md` and `atelier-crm/CLAUDE.md`
6. `atelier-api/_bmad-output/planning-artifacts/architecture.md` — only the sections your story names

## Dependencies
- **Requires:** W1 merged; W3 merged (supplier FK)
- **Blocks:** nothing

## Files you MAY touch
- atelier-api: `migrations/*samples*`, `src/samples/**`, `src/routes/admin-samples.js`, `test/samples*.test.js`
- atelier-crm: new `src/screens/AdminSamples.jsx`, `AdminShowrooms.jsx`, `AdminSampleOrders.jsx`, `src/screens/sampleFlow.js`; `src/screens/SampleScanner.jsx`; `src/App.jsx` (sample routes and redirects only), `src/components/sectionTabs.jsx` (samplesTabs only)
- Both repos: `CLAUDE.md` under a `## Samples` heading

## Files you MUST NOT touch
- Any `legacy_*` table — adding a column there is destroyed by the next import:legacy
- `src/trade-accounts/**` and `src/routes/account.js` — the client portal keeps reading legacy_cuttings
- Anything in `src/inventory/**` or any write to inventory quantities
- Other workstreams' screens and routes
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY. Never write, move or delete.
- Any `.env` file. `.env.example` may be edited; `.env` never.
- `package.json` dependencies — `node_modules` is a symlink to the main checkout, so adding a
  dependency corrupts every other checkout on this machine. If a story genuinely needs one, mark it
  BLOCKED and say so.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY.
- Any `.env`. Any `package.json` dependency — `node_modules` is a symlink to the main checkout.

## Gates (run before every commit; all must exit 0)
```bash
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```
Migration stories also: run `npm run migrate` twice and prove the second run is a no-op.

## How to work
One story per turn — the lowest `priority` in prd.json where `passes` is false and `notes` does not start `BLOCKED:`. Implement it, run the gates, then commit:

    feat(api): [W4-US-XXX] - <Story Title>

Use `crm`/`store` as the scope for those repos. A story touching two repos produces two commits with the SAME `[W4-US-XXX]` tag — that tag is how a reviewer reassembles a cross-repo change.

The same commit must also carry: `prd.json` `passes: true`, the `sprint-status.yaml` flip, and the `progress.txt` append block with a **Learnings:** section.

**NEVER** run `git push`, `rebase`, `merge`, `stash`, `reset`, `switch`, `branch` or any `--force`. A human merges. These are blocked at the tool level — a denial is the system working, not an obstacle to route around.

## When a story cannot pass
Two honest attempts, then set `notes: "BLOCKED: <reason>"`, write `ralph/w4-samples/BLOCKED.md`, revert the partial code, commit only the bookkeeping, and move on. Never retry a blocked story. Anything needing a product decision — a schema shape architecture.md does not cover, a file another workstream owns, a dependency you think you need — is BLOCKED. Do not decide it yourself.

## Done means
All 9 stories `passes: true`, no BLOCKED.md, gates green, `PR-BODY.md` written, then reply with:

    <promise>COMPLETE</promise>
````


---

## W5 Reporting — `w5-reporting`  ·  Wave 4  ·  8 stories

Real aggregation endpoints with filter-before-export, product performance by brand, and server-side masking that actually fires.

**Requires:** W2 merged (read models), W3 merged (suppliers and category)  
**Blocks:** nothing  
**Repos:** atelier-api, atelier-crm

### Block A — SETUP (you run this in a terminal, once)

```bash
set -e
WS=w5-reporting
ROOT=/Users/verumoffice/atelier-worktrees/$WS
mkdir -p "$ROOT"

# worktrees
git -C /Users/verumoffice/atelier-api worktree add -b aug6/$WS "$ROOT/atelier-api" august-6th-updates
git -C /Users/verumoffice/atelier-crm worktree add -b aug6/$WS "$ROOT/atelier-crm" august-6th-updates

# node_modules symlinked — a story needing a NEW dependency must mark itself BLOCKED
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"
ln -s /Users/verumoffice/atelier-crm/node_modules "$ROOT/atelier-crm/node_modules"

# gitignored files a worktree does not inherit
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

# this workstream's own database — never share atelier_dev between concurrent loops
createdb atelier_w5
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/atelier_w5|" "$ROOT/atelier-api/.env"
( cd "$ROOT/atelier-api" && npm run migrate )

# gates must be green BEFORE the loop starts (these run from the workstream root)
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```

Launch:

```bash
cd /Users/verumoffice/atelier-worktrees/w5-reporting
./atelier-api/ralph/ralph.sh w5-reporting 12
```

Teardown after merge:

```bash
git -C /Users/verumoffice/atelier-api worktree remove /Users/verumoffice/atelier-worktrees/w5-reporting/atelier-api
git -C /Users/verumoffice/atelier-crm worktree remove /Users/verumoffice/atelier-worktrees/w5-reporting/atelier-crm
dropdb atelier_w5
rmdir /Users/verumoffice/atelier-worktrees/w5-reporting
```

### Block B — BRIEF (paste this whole block into a fresh Claude Code instance)

````markdown
# TASK: W5 Reporting (Atelier, "August 6th updates")

## Goal
Real aggregation endpoints with filter-before-export, product performance by brand, and server-side masking that actually fires.

## Where you are working
- Working directory: `/Users/verumoffice/atelier-worktrees/w5-reporting` — **not a git repo, no CLAUDE.md, nothing auto-loads**
- `atelier-api/` — worktree of /Users/verumoffice/atelier-api, branch `aug6/w5-reporting`
- `atelier-crm/` — worktree of /Users/verumoffice/atelier-crm, branch `aug6/w5-reporting`
- Merge target: `august-6th-updates` in each repo. **Never touch `main`/`master`** — the live sites and API run off them.
- Database: `atelier_w5` (already set in atelier-api/.env). Never use `atelier_dev`; other loops use theirs.
- **These are plain-JavaScript repos. There is no typecheck anywhere. Do not look for one.**

## Read these first, in this order
1. `atelier-api/ralph/w5-reporting/progress.txt` — the `## Codebase Patterns` block at the top
2. `atelier-api/ralph/w5-reporting/prd.json` — your story list
3. `atelier-api/ralph/w5-reporting/CLAUDE.md` — your full operating instructions; this brief is a summary of it
4. `atelier-api/_bmad-output/project-context.md` — cross-repo rules and the real gates
5. `atelier-api/CLAUDE.md` and `atelier-crm/CLAUDE.md`
6. `atelier-api/_bmad-output/planning-artifacts/architecture.md` — only the sections your story names

## Dependencies
- **Requires:** W2 merged (read models), W3 merged (suppliers and category)
- **Blocks:** nothing

## Files you MAY touch
- atelier-api: `src/lib/csv.js`, `src/reports/**`, `src/routes/admin-reports.js`, `migrations/*reporting*`, `migrations/*finance-access*`, `test/admin-reports.test.js`, `test/report-filters.test.js`; `src/routes/auth.js` + `src/auth/user-columns.js` (report_access only); `src/users/admin-users.js` (can_view_finance whitelist only)
- atelier-crm: `src/screens/Reporting.jsx`, `ReportLibrary.jsx`, `src/utils/reportBuilders.js`, `src/utils/exporters.js`, `src/auth/reportPolicy.js`, `src/auth/roles.js`, `src/auth/AuthContext.jsx`
- Both repos: `CLAUDE.md` under a `## Reporting` heading

## Files you MUST NOT touch
- Any catalogue, orders, suppliers or samples route — read them, do not change them
- Anything in atelier-storefront
- `src/pricing/trade-price-lists.js` beyond importing the extracted CSV helpers
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY. Never write, move or delete.
- Any `.env` file. `.env.example` may be edited; `.env` never.
- `package.json` dependencies — `node_modules` is a symlink to the main checkout, so adding a
  dependency corrupts every other checkout on this machine. If a story genuinely needs one, mark it
  BLOCKED and say so.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY.
- Any `.env`. Any `package.json` dependency — `node_modules` is a symlink to the main checkout.

## Gates (run before every commit; all must exit 0)
```bash
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```
Migration stories also: run `npm run migrate` twice and prove the second run is a no-op.

## How to work
One story per turn — the lowest `priority` in prd.json where `passes` is false and `notes` does not start `BLOCKED:`. Implement it, run the gates, then commit:

    feat(api): [W5-US-XXX] - <Story Title>

Use `crm`/`store` as the scope for those repos. A story touching two repos produces two commits with the SAME `[W5-US-XXX]` tag — that tag is how a reviewer reassembles a cross-repo change.

The same commit must also carry: `prd.json` `passes: true`, the `sprint-status.yaml` flip, and the `progress.txt` append block with a **Learnings:** section.

**NEVER** run `git push`, `rebase`, `merge`, `stash`, `reset`, `switch`, `branch` or any `--force`. A human merges. These are blocked at the tool level — a denial is the system working, not an obstacle to route around.

## When a story cannot pass
Two honest attempts, then set `notes: "BLOCKED: <reason>"`, write `ralph/w5-reporting/BLOCKED.md`, revert the partial code, commit only the bookkeeping, and move on. Never retry a blocked story. Anything needing a product decision — a schema shape architecture.md does not cover, a file another workstream owns, a dependency you think you need — is BLOCKED. Do not decide it yourself.

## Done means
All 8 stories `passes: true`, no BLOCKED.md, gates green, `PR-BODY.md` written, then reply with:

    <promise>COMPLETE</promise>
````


---

## W6 Category export — `w6-category-export`  ·  Wave 3  ·  5 stories

A spreadsheet round trip letting the office assign product categories, generalised into a reusable per-brand template.

**Requires:** W3 merged (products.category)  
**Blocks:** nothing  
**Repos:** atelier-api, atelier-crm

### Block A — SETUP (you run this in a terminal, once)

```bash
set -e
WS=w6-category-export
ROOT=/Users/verumoffice/atelier-worktrees/$WS
mkdir -p "$ROOT"

# worktrees
git -C /Users/verumoffice/atelier-api worktree add -b aug6/$WS "$ROOT/atelier-api" august-6th-updates
git -C /Users/verumoffice/atelier-crm worktree add -b aug6/$WS "$ROOT/atelier-crm" august-6th-updates

# node_modules symlinked — a story needing a NEW dependency must mark itself BLOCKED
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"
ln -s /Users/verumoffice/atelier-crm/node_modules "$ROOT/atelier-crm/node_modules"

# gitignored files a worktree does not inherit
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

# READ-ONLY copy — incoming/ is the client's only copy of this data
mkdir -p "$ROOT/atelier-api/incoming"
cp -R /Users/verumoffice/atelier-api/incoming/colour-files "$ROOT/atelier-api/incoming/"
chmod -R a-w "$ROOT/atelier-api/incoming"

# this workstream's own database — never share atelier_dev between concurrent loops
createdb atelier_w6
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/atelier_w6|" "$ROOT/atelier-api/.env"
( cd "$ROOT/atelier-api" && npm run migrate )

# gates must be green BEFORE the loop starts (these run from the workstream root)
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```

Launch:

```bash
cd /Users/verumoffice/atelier-worktrees/w6-category-export
./atelier-api/ralph/ralph.sh w6-category-export 8
```

Teardown after merge:

```bash
git -C /Users/verumoffice/atelier-api worktree remove /Users/verumoffice/atelier-worktrees/w6-category-export/atelier-api
git -C /Users/verumoffice/atelier-crm worktree remove /Users/verumoffice/atelier-worktrees/w6-category-export/atelier-crm
dropdb atelier_w6
rmdir /Users/verumoffice/atelier-worktrees/w6-category-export
```

### Block B — BRIEF (paste this whole block into a fresh Claude Code instance)

````markdown
# TASK: W6 Category export (Atelier, "August 6th updates")

## Goal
A spreadsheet round trip letting the office assign product categories, generalised into a reusable per-brand template.

## Where you are working
- Working directory: `/Users/verumoffice/atelier-worktrees/w6-category-export` — **not a git repo, no CLAUDE.md, nothing auto-loads**
- `atelier-api/` — worktree of /Users/verumoffice/atelier-api, branch `aug6/w6-category-export`
- `atelier-crm/` — worktree of /Users/verumoffice/atelier-crm, branch `aug6/w6-category-export`
- Merge target: `august-6th-updates` in each repo. **Never touch `main`/`master`** — the live sites and API run off them.
- Database: `atelier_w6` (already set in atelier-api/.env). Never use `atelier_dev`; other loops use theirs.
- **These are plain-JavaScript repos. There is no typecheck anywhere. Do not look for one.**

## Read these first, in this order
1. `atelier-api/ralph/w6-category-export/progress.txt` — the `## Codebase Patterns` block at the top
2. `atelier-api/ralph/w6-category-export/prd.json` — your story list
3. `atelier-api/ralph/w6-category-export/CLAUDE.md` — your full operating instructions; this brief is a summary of it
4. `atelier-api/_bmad-output/project-context.md` — cross-repo rules and the real gates
5. `atelier-api/CLAUDE.md` and `atelier-crm/CLAUDE.md`
6. `atelier-api/_bmad-output/planning-artifacts/architecture.md` — only the sections your story names

## Dependencies
- **Requires:** W3 merged (products.category)
- **Blocks:** nothing

## Files you MAY touch
- atelier-api: `src/lib/csv-text.js`, `src/products/product-sheet.js`, `src/routes/admin-product-sheet.js`, `scripts/lib/text.js` (re-export only), `test/product-sheet.test.js`
- atelier-crm: new `src/screens/AdminProductSheet.jsx` + a pure sibling module, `src/lib/api.js` (append only)
- Both repos: `CLAUDE.md` under a `## Category export` heading

## Files you MUST NOT touch
- `src/reports/**` — owned by W5
- Any migration — products.category arrives with W3
- Other workstreams' screens and routes
- `src/seed/data/price-lists.json` — never regenerate it in this workstream
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY. Never write, move or delete.
- Any `.env` file. `.env.example` may be edited; `.env` never.
- `package.json` dependencies — `node_modules` is a symlink to the main checkout, so adding a
  dependency corrupts every other checkout on this machine. If a story genuinely needs one, mark it
  BLOCKED and say so.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY.
- Any `.env`. Any `package.json` dependency — `node_modules` is a symlink to the main checkout.

## Gates (run before every commit; all must exit 0)
```bash
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
```
Migration stories also: run `npm run migrate` twice and prove the second run is a no-op.

## How to work
One story per turn — the lowest `priority` in prd.json where `passes` is false and `notes` does not start `BLOCKED:`. Implement it, run the gates, then commit:

    feat(api): [W6-US-XXX] - <Story Title>

Use `crm`/`store` as the scope for those repos. A story touching two repos produces two commits with the SAME `[W6-US-XXX]` tag — that tag is how a reviewer reassembles a cross-repo change.

The same commit must also carry: `prd.json` `passes: true`, the `sprint-status.yaml` flip, and the `progress.txt` append block with a **Learnings:** section.

**NEVER** run `git push`, `rebase`, `merge`, `stash`, `reset`, `switch`, `branch` or any `--force`. A human merges. These are blocked at the tool level — a denial is the system working, not an obstacle to route around.

## When a story cannot pass
Two honest attempts, then set `notes: "BLOCKED: <reason>"`, write `ralph/w6-category-export/BLOCKED.md`, revert the partial code, commit only the bookkeeping, and move on. Never retry a blocked story. Anything needing a product decision — a schema shape architecture.md does not cover, a file another workstream owns, a dependency you think you need — is BLOCKED. Do not decide it yourself.

## Done means
All 5 stories `passes: true`, no BLOCKED.md, gates green, `PR-BODY.md` written, then reply with:

    <promise>COMPLETE</promise>
````


---

## W7 Featured — `w7-featured`  ·  Wave 2  ·  7 stories

The office controls which houses and collections the storefront features, replacing hardcoded slug arrays.

**Requires:** W1 merged  
**Blocks:** nothing  
**Repos:** atelier-api, atelier-crm, atelier-storefront

### Block A — SETUP (you run this in a terminal, once)

```bash
set -e
WS=w7-featured
ROOT=/Users/verumoffice/atelier-worktrees/$WS
mkdir -p "$ROOT"

# worktrees
git -C /Users/verumoffice/atelier-api worktree add -b aug6/$WS "$ROOT/atelier-api" august-6th-updates
git -C /Users/verumoffice/atelier-crm worktree add -b aug6/$WS "$ROOT/atelier-crm" august-6th-updates
git -C /Users/verumoffice/atelier-storefront worktree add -b aug6/$WS "$ROOT/atelier-storefront" august-6th-updates

# node_modules symlinked — a story needing a NEW dependency must mark itself BLOCKED
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"
ln -s /Users/verumoffice/atelier-crm/node_modules "$ROOT/atelier-crm/node_modules"
ln -s /Users/verumoffice/atelier-storefront/node_modules "$ROOT/atelier-storefront/node_modules"

# gitignored files a worktree does not inherit
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

# this workstream's own database — never share atelier_dev between concurrent loops
createdb atelier_w7
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/atelier_w7|" "$ROOT/atelier-api/.env"
( cd "$ROOT/atelier-api" && npm run migrate )

# gates must be green BEFORE the loop starts (these run from the workstream root)
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
( cd atelier-storefront && npm run lint && npm test && npm run build )
```

Launch:

```bash
cd /Users/verumoffice/atelier-worktrees/w7-featured
./atelier-api/ralph/ralph.sh w7-featured 11
```

Teardown after merge:

```bash
git -C /Users/verumoffice/atelier-api worktree remove /Users/verumoffice/atelier-worktrees/w7-featured/atelier-api
git -C /Users/verumoffice/atelier-crm worktree remove /Users/verumoffice/atelier-worktrees/w7-featured/atelier-crm
git -C /Users/verumoffice/atelier-storefront worktree remove /Users/verumoffice/atelier-worktrees/w7-featured/atelier-storefront
dropdb atelier_w7
rmdir /Users/verumoffice/atelier-worktrees/w7-featured
```

### Block B — BRIEF (paste this whole block into a fresh Claude Code instance)

````markdown
# TASK: W7 Featured (Atelier, "August 6th updates")

## Goal
The office controls which houses and collections the storefront features, replacing hardcoded slug arrays.

## Where you are working
- Working directory: `/Users/verumoffice/atelier-worktrees/w7-featured` — **not a git repo, no CLAUDE.md, nothing auto-loads**
- `atelier-api/` — worktree of /Users/verumoffice/atelier-api, branch `aug6/w7-featured`
- `atelier-crm/` — worktree of /Users/verumoffice/atelier-crm, branch `aug6/w7-featured`
- `atelier-storefront/` — worktree of /Users/verumoffice/atelier-storefront, branch `aug6/w7-featured`
- Merge target: `august-6th-updates` in each repo. **Never touch `main`/`master`** — the live sites and API run off them.
- Database: `atelier_w7` (already set in atelier-api/.env). Never use `atelier_dev`; other loops use theirs.
- **These are plain-JavaScript repos. There is no typecheck anywhere. Do not look for one.**

## Read these first, in this order
1. `atelier-api/ralph/w7-featured/progress.txt` — the `## Codebase Patterns` block at the top
2. `atelier-api/ralph/w7-featured/prd.json` — your story list
3. `atelier-api/ralph/w7-featured/CLAUDE.md` — your full operating instructions; this brief is a summary of it
4. `atelier-api/_bmad-output/project-context.md` — cross-repo rules and the real gates
5. `atelier-api/CLAUDE.md` and `atelier-crm/CLAUDE.md` and `atelier-storefront/CLAUDE.md`
6. `atelier-api/_bmad-output/planning-artifacts/architecture.md` — only the sections your story names

## Dependencies
- **Requires:** W1 merged
- **Blocks:** nothing

## Files you MAY touch
- atelier-api: `migrations/*featured*`, `src/catalogue/brands.js`, `src/catalogue/collections.js`, `src/catalogue/admin-brands.js` (featured columns and the reorder functions only), `src/routes/catalogue.js`, `src/routes/admin-catalogue.js` (featured endpoints only), `test/featured*.test.js`, `test/seed.test.js` (the reseed assertion only)
- atelier-crm: `src/screens/AdminBrands.jsx`, new `src/screens/featuredOrder.js` + test
- atelier-storefront: anything — this is the ONLY workstream permitted to touch it
- All three repos: `CLAUDE.md` under a `## Featured` heading

## Files you MUST NOT touch
- CRM `AdminProducts.jsx`, `AdminStock.jsx`, `AdminOrders.jsx`, `AdminCollections.jsx` — owned by W2
- `src/suppliers/**` — owned by W3
- Any delete endpoint — owned by W2
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY. Never write, move or delete.
- Any `.env` file. `.env.example` may be edited; `.env` never.
- `package.json` dependencies — `node_modules` is a symlink to the main checkout, so adding a
  dependency corrupts every other checkout on this machine. If a story genuinely needs one, mark it
  BLOCKED and say so.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY.
- Any `.env`. Any `package.json` dependency — `node_modules` is a symlink to the main checkout.

## Gates (run before every commit; all must exit 0)
```bash
( cd atelier-api && npm run lint && npm test )
( cd atelier-crm && npm test && npm run build )
( cd atelier-storefront && npm run lint && npm test && npm run build )
```
Migration stories also: run `npm run migrate` twice and prove the second run is a no-op.

## How to work
One story per turn — the lowest `priority` in prd.json where `passes` is false and `notes` does not start `BLOCKED:`. Implement it, run the gates, then commit:

    feat(api): [W7-US-XXX] - <Story Title>

Use `crm`/`store` as the scope for those repos. A story touching two repos produces two commits with the SAME `[W7-US-XXX]` tag — that tag is how a reviewer reassembles a cross-repo change.

The same commit must also carry: `prd.json` `passes: true`, the `sprint-status.yaml` flip, and the `progress.txt` append block with a **Learnings:** section.

**NEVER** run `git push`, `rebase`, `merge`, `stash`, `reset`, `switch`, `branch` or any `--force`. A human merges. These are blocked at the tool level — a denial is the system working, not an obstacle to route around.

## When a story cannot pass
Two honest attempts, then set `notes: "BLOCKED: <reason>"`, write `ralph/w7-featured/BLOCKED.md`, revert the partial code, commit only the bookkeeping, and move on. Never retry a blocked story. Anything needing a product decision — a schema shape architecture.md does not cover, a file another workstream owns, a dependency you think you need — is BLOCKED. Do not decide it yourself.

## Done means
All 7 stories `passes: true`, no BLOCKED.md, gates green, `PR-BODY.md` written, then reply with:

    <promise>COMPLETE</promise>
````


---

## W8 Colour files — `w8-colour-files`  ·  Wave 1  ·  6 stories

Import the 18 supplier colour spreadsheets into the colourway catalogue, with 2026 rates as a secondary output.

**Requires:** nothing — runs in Wave 1 alongside W1; the file footprints are disjoint  
**Blocks:** nothing  
**Repos:** atelier-api

### Block A — SETUP (you run this in a terminal, once)

```bash
set -e
WS=w8-colour-files
ROOT=/Users/verumoffice/atelier-worktrees/$WS
mkdir -p "$ROOT"

# worktrees
git -C /Users/verumoffice/atelier-api worktree add -b aug6/$WS "$ROOT/atelier-api" august-6th-updates

# node_modules symlinked — a story needing a NEW dependency must mark itself BLOCKED
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"

# gitignored files a worktree does not inherit
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

# READ-ONLY copy — incoming/ is the client's only copy of this data
mkdir -p "$ROOT/atelier-api/incoming"
cp -R /Users/verumoffice/atelier-api/incoming/colour-files "$ROOT/atelier-api/incoming/"
chmod -R a-w "$ROOT/atelier-api/incoming"

# this workstream's own database — never share atelier_dev between concurrent loops
createdb atelier_w8
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/atelier_w8|" "$ROOT/atelier-api/.env"
( cd "$ROOT/atelier-api" && npm run migrate )

# gates must be green BEFORE the loop starts (these run from the workstream root)
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )
```

Launch:

```bash
cd /Users/verumoffice/atelier-worktrees/w8-colour-files
./atelier-api/ralph/ralph.sh w8-colour-files 9
```

Teardown after merge:

```bash
git -C /Users/verumoffice/atelier-api worktree remove /Users/verumoffice/atelier-worktrees/w8-colour-files/atelier-api
dropdb atelier_w8
rmdir /Users/verumoffice/atelier-worktrees/w8-colour-files
```

### Block B — BRIEF (paste this whole block into a fresh Claude Code instance)

````markdown
# TASK: W8 Colour files (Atelier, "August 6th updates")

## Goal
Import the 18 supplier colour spreadsheets into the colourway catalogue, with 2026 rates as a secondary output.

## Where you are working
- Working directory: `/Users/verumoffice/atelier-worktrees/w8-colour-files` — **not a git repo, no CLAUDE.md, nothing auto-loads**
- `atelier-api/` — worktree of /Users/verumoffice/atelier-api, branch `aug6/w8-colour-files`
- Merge target: `august-6th-updates` in each repo. **Never touch `main`/`master`** — the live sites and API run off them.
- Database: `atelier_w8` (already set in atelier-api/.env). Never use `atelier_dev`; other loops use theirs.
- **These are plain-JavaScript repos. There is no typecheck anywhere. Do not look for one.**

## Read these first, in this order
1. `atelier-api/ralph/w8-colour-files/progress.txt` — the `## Codebase Patterns` block at the top
2. `atelier-api/ralph/w8-colour-files/prd.json` — your story list
3. `atelier-api/ralph/w8-colour-files/CLAUDE.md` — your full operating instructions; this brief is a summary of it
4. `atelier-api/_bmad-output/project-context.md` — cross-repo rules and the real gates
5. `atelier-api/CLAUDE.md`
6. `atelier-api/_bmad-output/planning-artifacts/architecture.md` — only the sections your story names

## Dependencies
- **Requires:** nothing — runs in Wave 1 alongside W1; the file footprints are disjoint
- **Blocks:** nothing

## Files you MAY touch
- atelier-api: `scripts/convert-colour-files.js`, `scripts/lib/colour-adapters/**`, `scripts/lib/colour-sheet.js`, `src/seed/import-colourways.js`, `src/seed/colourways-import.js`, `test/colour-files.test.js`, `package.json` (scripts only)
- atelier-api: `CLAUDE.md` under a `## Colour files` heading

## Files you MUST NOT touch
- `scripts/convert-price-lists.js` and `scripts/convert-d365-exports.js` — read them as reference, do not change them
- `src/seed/data/price-lists.json` — never regenerate it here
- Any route, any migration, any CRM file
- `atelier-api/incoming/**` is READ ONLY — it is the client's only copy
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY. Never write, move or delete.
- Any `.env` file. `.env.example` may be edited; `.env` never.
- `package.json` dependencies — `node_modules` is a symlink to the main checkout, so adding a
  dependency corrupts every other checkout on this machine. If a story genuinely needs one, mark it
  BLOCKED and say so.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY.
- Any `.env`. Any `package.json` dependency — `node_modules` is a symlink to the main checkout.

## Gates (run before every commit; all must exit 0)
```bash
( cd atelier-api && npm run lint && npm test )
```
Migration stories also: run `npm run migrate` twice and prove the second run is a no-op.

## How to work
One story per turn — the lowest `priority` in prd.json where `passes` is false and `notes` does not start `BLOCKED:`. Implement it, run the gates, then commit:

    feat(api): [W8-US-XXX] - <Story Title>

Use `crm`/`store` as the scope for those repos. A story touching two repos produces two commits with the SAME `[W8-US-XXX]` tag — that tag is how a reviewer reassembles a cross-repo change.

The same commit must also carry: `prd.json` `passes: true`, the `sprint-status.yaml` flip, and the `progress.txt` append block with a **Learnings:** section.

**NEVER** run `git push`, `rebase`, `merge`, `stash`, `reset`, `switch`, `branch` or any `--force`. A human merges. These are blocked at the tool level — a denial is the system working, not an obstacle to route around.

## When a story cannot pass
Two honest attempts, then set `notes: "BLOCKED: <reason>"`, write `ralph/w8-colour-files/BLOCKED.md`, revert the partial code, commit only the bookkeeping, and move on. Never retry a blocked story. Anything needing a product decision — a schema shape architecture.md does not cover, a file another workstream owns, a dependency you think you need — is BLOCKED. Do not decide it yourself.

## Done means
All 6 stories `passes: true`, no BLOCKED.md, gates green, `PR-BODY.md` written, then reply with:

    <promise>COMPLETE</promise>
````


---

## W9 Scanner spike — `w9-scanner-spike`  ·  Wave 1  ·  3 stories

A written recommendation on sample and showroom-sample scanning. Research only — no code. DO NOT RUN THIS UNDER RALPH: a research task has no gates, so a loop has nothing to verify against. Run it as one supervised session.

**Requires:** nothing  
**Blocks:** nothing  
**Repos:** atelier-api

> **Do not run this one under Ralph.** A research task has no gates, so a loop has nothing
> to verify against and would burn its budget. Run it as one supervised session on
> `aug6/w9-scanner-spike` in the main api checkout.

### Block A — SETUP (you run this in a terminal, once)

```bash
set -e
WS=w9-scanner-spike
ROOT=/Users/verumoffice/atelier-worktrees/$WS
mkdir -p "$ROOT"

# worktrees
git -C /Users/verumoffice/atelier-api worktree add -b aug6/$WS "$ROOT/atelier-api" august-6th-updates

# node_modules symlinked — a story needing a NEW dependency must mark itself BLOCKED
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"

# gitignored files a worktree does not inherit
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

# this workstream's own database — never share atelier_dev between concurrent loops
createdb atelier_w9
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/atelier_w9|" "$ROOT/atelier-api/.env"
( cd "$ROOT/atelier-api" && npm run migrate )

# gates must be green BEFORE the loop starts (these run from the workstream root)
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )
```

Launch:

```bash
cd /Users/verumoffice/atelier-worktrees/w9-scanner-spike
./atelier-api/ralph/ralph.sh w9-scanner-spike 5
```

Teardown after merge:

```bash
git -C /Users/verumoffice/atelier-api worktree remove /Users/verumoffice/atelier-worktrees/w9-scanner-spike/atelier-api
dropdb atelier_w9
rmdir /Users/verumoffice/atelier-worktrees/w9-scanner-spike
```

### Block B — BRIEF (paste this whole block into a fresh Claude Code instance)

````markdown
# TASK: W9 Scanner spike (Atelier, "August 6th updates")

## Goal
A written recommendation on sample and showroom-sample scanning. Research only — no code. DO NOT RUN THIS UNDER RALPH: a research task has no gates, so a loop has nothing to verify against. Run it as one supervised session.

## Where you are working
- Working directory: `/Users/verumoffice/atelier-worktrees/w9-scanner-spike` — **not a git repo, no CLAUDE.md, nothing auto-loads**
- `atelier-api/` — worktree of /Users/verumoffice/atelier-api, branch `aug6/w9-scanner-spike`
- Merge target: `august-6th-updates` in each repo. **Never touch `main`/`master`** — the live sites and API run off them.
- Database: `atelier_w9` (already set in atelier-api/.env). Never use `atelier_dev`; other loops use theirs.
- **These are plain-JavaScript repos. There is no typecheck anywhere. Do not look for one.**

## Read these first, in this order
1. `atelier-api/ralph/w9-scanner-spike/progress.txt` — the `## Codebase Patterns` block at the top
2. `atelier-api/ralph/w9-scanner-spike/prd.json` — your story list
3. `atelier-api/ralph/w9-scanner-spike/CLAUDE.md` — your full operating instructions; this brief is a summary of it
4. `atelier-api/_bmad-output/project-context.md` — cross-repo rules and the real gates
5. `atelier-api/CLAUDE.md`
6. `atelier-api/_bmad-output/planning-artifacts/architecture.md` — only the sections your story names

## Dependencies
- **Requires:** nothing
- **Blocks:** nothing

## Files you MAY touch
- atelier-api: `_bmad-output/planning-artifacts/research-sample-scanner.md`, `_bmad-output/planning-artifacts/architecture.md` (append the ADR only)

## Files you MUST NOT touch
- All source code, in every repo. This workstream writes documents.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY. Never write, move or delete.
- Any `.env` file. `.env.example` may be edited; `.env` never.
- `package.json` dependencies — `node_modules` is a symlink to the main checkout, so adding a
  dependency corrupts every other checkout on this machine. If a story genuinely needs one, mark it
  BLOCKED and say so.
- `atelier-api/incoming/**` — the client's only copy of real data. READ ONLY.
- Any `.env`. Any `package.json` dependency — `node_modules` is a symlink to the main checkout.

## Gates (run before every commit; all must exit 0)
```bash
( cd atelier-api && npm run lint && npm test )
```
Migration stories also: run `npm run migrate` twice and prove the second run is a no-op.

## How to work
One story per turn — the lowest `priority` in prd.json where `passes` is false and `notes` does not start `BLOCKED:`. Implement it, run the gates, then commit:

    feat(api): [W9-US-XXX] - <Story Title>

Use `crm`/`store` as the scope for those repos. A story touching two repos produces two commits with the SAME `[W9-US-XXX]` tag — that tag is how a reviewer reassembles a cross-repo change.

The same commit must also carry: `prd.json` `passes: true`, the `sprint-status.yaml` flip, and the `progress.txt` append block with a **Learnings:** section.

**NEVER** run `git push`, `rebase`, `merge`, `stash`, `reset`, `switch`, `branch` or any `--force`. A human merges. These are blocked at the tool level — a denial is the system working, not an obstacle to route around.

## When a story cannot pass
Two honest attempts, then set `notes: "BLOCKED: <reason>"`, write `ralph/w9-scanner-spike/BLOCKED.md`, revert the partial code, commit only the bookkeeping, and move on. Never retry a blocked story. Anything needing a product decision — a schema shape architecture.md does not cover, a file another workstream owns, a dependency you think you need — is BLOCKED. Do not decide it yourself.

## Done means
All 3 stories `passes: true`, no BLOCKED.md, gates green, `PR-BODY.md` written, then reply with:

    <promise>COMPLETE</promise>
````
