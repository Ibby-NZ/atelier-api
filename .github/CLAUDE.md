# atelier-api — CI

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

## CI

- `.github/workflows/ci.yml` runs `npm run lint` then `npm test` on every pull request into `main` (and into the older `august-6th-updates` integration branch — it was the ONLY trigger until 2026-08-24, so a PR into main ran no gates at all), with `permissions: contents: read` so the job token cannot push, tag or write to `main`. **No typecheck step — there is no TypeScript in this repo**; a template that adds one is wrong.
- **The job needs a real Postgres and two env vars.** There are no database mocks here: every suite runs the migrations through node-pg-migrate against a live server, so the workflow declares a `postgres:14` service (pinned to match local Homebrew — a newer server would let a query through CI that fails in production) with a `pg_isready` healthcheck, or the first migration races startup and the connection-refused reads as a code fault. `DATABASE_URL` and a throwaway 32-character `COOKIE_SECRET` are set in `env:`, because `loadConfig` throws without either and nothing in the suite can build an app.
- **Node 22, not 20**: node-pg-migrate `require()`s the ESM migration files, which is only unflagged from 22.12 (and 20.19). That is the same `ExperimentalWarning` the local test run prints.
- `npm ci` cannot be rehearsed from a worktree on the dev machine — every worktree's `node_modules` is a symlink to the main checkout, so running it would rebuild the shared tree and break every other loop. The first PR run is what proves that step.

