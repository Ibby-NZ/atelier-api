# Ralph loops — Atelier "August 6th updates"

Nine workstreams, three repos, one integration branch per repo (`august-6th-updates`).
Each workstream runs as an autonomous per-story loop against a BMAD-authored epic.

## Safety posture — read this first

**Nothing here may touch `main` or `master`.** The live sites and API run off them.
`ralph.sh` enforces it at the tool level, not just in the prompt: `git push`, `rebase`, `merge`,
`stash`, `reset`, `switch` and `branch` are absent from `--allowedTools` **and** named in
`--disallowedTools`. A human merges.

**This loop does not use `--dangerously-skip-permissions.`** It runs a scoped allowlist under
`--permission-mode acceptEdits`. In `--print` mode there is nobody to approve a prompt, so an
unlisted tool call is denied. Expect W1 — which runs alone and supervised — to stall once or twice
on something legitimate; widen `ALLOWED` in `ralph.sh` rather than reaching for `bypassPermissions`.

**One database per workstream.** The API test suite runs migrations against a real Postgres and
node-pg-migrate takes an advisory lock, so two loops sharing `atelier_dev` produce
"Another migration is already running" plus cross-contaminated fixtures — failures that read as
code bugs and send an autonomous agent off fixing working code.

## Layout

```
ralph/
  ralph.sh              one script, takes a workstream slug (not nine copies — nine copies drift)
  verify.sh             the CI stand-in; writes a committed gate log
  generate.mjs          regenerates every prd.json + CLAUDE.md from one spec
  CLAUDE.template.md    the iteration prompt template
  <workstream>/
    prd.json            story list and pass state — the loop's index
    CLAUDE.md           the rendered iteration prompt (this IS the loop's whole input)
    progress.txt        append-only log; `## Codebase Patterns` at the top
    PR-BODY.md          written by the loop when it completes
    BLOCKED.md          exists only when a story needs a human
    verify-<utc>.log    committed gate evidence
```

`generate.mjs` is safe to re-run: `CLAUDE.md` is always rewritten from the template, and existing
`prd.json` files keep their `passes` and `notes`, so regenerating mid-run cannot erase progress.

## Wave schedule

```
Wave 1   w1-foundations  (ALONE — everything depends on it; also calibrates the allowlist)
         w8-colour-files (concurrent — disjoint file footprint)
         w9-scanner-spike (concurrent — docs only; do NOT run under Ralph)

Wave 2   w2-crud | w3-suppliers | w7-featured

Wave 3   w4-samples | w6-category-export

Wave 4   w5-reporting
```

Concurrency cap: **3 loops.** That is a review-throughput limit, not a technical one.

## Running one

```bash
# Setup (human, once — see the handoff document for the full Block A)
WS=w3-suppliers
ROOT=/Users/verumoffice/atelier-worktrees/$WS
# ... worktrees, node_modules symlinks, .env copy, createdb ...

# Launch, from the WORKSTREAM ROOT
cd $ROOT
./atelier-api/ralph/ralph.sh $WS 11
```

`$SCRIPT_DIR` resolves to the versioned state directory inside the api worktree; the loop's cwd is
the workstream root, where every repo is reachable. Both hold at once — that is the pivot the whole
layout turns on.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | every story passed |
| 1 | hit max iterations without finishing |
| 3 | stopped because remaining stories are BLOCKED — see `BLOCKED.md` |
| 4 | three consecutive iterations produced no commit — likely an expired session, a rate limit, or a denied tool call |

## When a loop finishes

1. `./atelier-api/ralph/verify.sh <ws>` from the workstream root — commit the log.
2. Review in a **fresh** Claude instance in the same worktree: `bmad-code-review`, then the
   `code-reviewer` agent on the branch diff, plus `database-reviewer` if `migrations/` changed and
   `security-reviewer` for W2, W3, W5 and W8.
3. Check the cross-repo drift grep: every API path in the CRM diff must resolve to a route that
   exists on the branch or on `august-6th-updates`.
4. Merge **api → crm → storefront**, always in that order. A merged CRM screen calling a
   not-yet-merged endpoint 404s, and the next workstream's agent will misdiagnose it.

## Definition of done

Checkable without reading code: every story `passes: true`; no `BLOCKED.md`; a `verify-*.log`
dated after the last code commit with all exit codes 0; a review record; one commit per story per
repo, each carrying `[W<N>-US-XXX]`; `progress.txt` complete with a `Learnings` block per story;
and the "needs human verification" digest walked through.
