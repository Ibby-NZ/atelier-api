#!/bin/bash
# Ralph — autonomous per-story agent loop, Atelier "August 6th updates".
#
# Usage:  ./atelier-api/ralph/ralph.sh <workstream-slug> [max_iterations]
# Example: cd /Users/verumoffice/atelier-worktrees/w3-suppliers
#          ./atelier-api/ralph/ralph.sh w3-suppliers 11
#
# Run it from the WORKSTREAM ROOT (the directory holding the repo worktrees).
# The loop's cwd is that root, so one iteration can edit atelier-api/ and
# atelier-crm/ in the same context window. State lives beside this script, in
# the api worktree, so it is versioned on the workstream branch.
#
# Deviations from the reference ralph.sh, deliberate:
#   1. ONE script taking a workstream argument, not nine copies. Nine copies
#      drift the moment one is patched.
#   2. NO --dangerously-skip-permissions. A scoped --allowedTools list instead.
#      git push/rebase/stash/reset/switch/branch/merge are absent from the
#      allowlist AND named in --disallowedTools, so a loop cannot reach
#      main/master even if its prompt were wrong. The live sites run off those
#      branches.
#   3. A stall watchdog: if an iteration produces no commit in any repo, say so.
#      The reference wraps the CLI call in `|| true`, so an expired session or a
#      rate limit is otherwise swallowed and the loop spins its whole budget
#      doing nothing.
#   4. A BLOCKED signal surfaced at the end.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT_HINT="/Users/verumoffice/atelier-worktrees"

WS="${1:-}"
MAX_ITERATIONS="${2:-12}"

if [ -z "$WS" ]; then
  echo "Usage: $0 <workstream-slug> [max_iterations]" >&2
  echo "Workstreams: $(ls -d "$SCRIPT_DIR"/w*/ 2>/dev/null | xargs -n1 basename | tr '\n' ' ')" >&2
  exit 2
fi

STATE_DIR="$SCRIPT_DIR/$WS"
PROMPT_FILE="$STATE_DIR/CLAUDE.md"
PRD_FILE="$STATE_DIR/prd.json"
PROGRESS_FILE="$STATE_DIR/progress.txt"

for f in "$PROMPT_FILE" "$PRD_FILE"; do
  [ -f "$f" ] || { echo "Missing: $f" >&2; exit 2; }
done

if [ ! -f "$PROGRESS_FILE" ]; then
  { echo "# Ralph progress log — $WS"; echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "---"; } > "$PROGRESS_FILE"
fi

# Repos present in this workstream root. A worktree's .git is a FILE, not a
# directory, so both must be tested.
REPOS=()
for r in atelier-api atelier-crm atelier-storefront; do
  if [ -e "$r/.git" ]; then
    REPOS+=("$r")
  fi
done

# Empty-array expansion is an "unbound variable" error under `set -u` in the
# bash 3.2 that macOS ships, so catch this here with a message that says what
# is actually wrong — you are almost certainly in the wrong directory.
if [ ${#REPOS[@]} -eq 0 ]; then
  echo "No repo worktrees found in $PWD." >&2
  echo "Run this from the WORKSTREAM ROOT, e.g. $WORKTREE_ROOT_HINT/$WS" >&2
  exit 2
fi

commit_count() {
  local total=0
  local r
  for r in "${REPOS[@]}"; do
    total=$(( total + $(git -C "$r" rev-list --count HEAD 2>/dev/null || echo 0) ))
  done
  echo "$total"
}

# Scoped permissions. Anything not listed is DENIED — in --print mode there is
# nobody to approve a prompt.
#
# NOTE ON SYNTAX, learned the hard way: these are PREFIX rules. `Bash(cmd:*)`
# means "any command starting with `cmd`". A `*` in the MIDDLE is not a glob —
# `Bash(git -C * add:*)` requires the literal string "git -C * add" and matches
# nothing, so every git write was denied on the first run. Each repo therefore
# gets its own explicit prefix, and the bare forms cover an agent that has cd'd
# into a repo first.
ALLOWED=(
  "Read" "Edit" "Write" "Glob" "Grep" "TodoWrite"
  "Bash(npm run lint)" "Bash(npm test)" "Bash(npm run build)"
  "Bash(npm run migrate)" "Bash(npm run migrate:down)" "Bash(npm run migrate:create:*)"
  "Bash(npm run seed)" "Bash(npm run convert:*)" "Bash(npm run import:*)"
  "Bash(node:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(find:*)" "Bash(wc:*)"
  "Bash(grep:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(sed:*)" "Bash(diff:*)"
  "Bash(mkdir:*)" "Bash(cd:*)" "Bash(pwd)" "Bash(echo:*)" "Bash(chmod:*)"
  # git reads
  "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)"
  "Bash(git rev-parse:*)" "Bash(git ls-files:*)" "Bash(git check-ignore:*)"
  # git writes — staging, committing and reverting a file only
  "Bash(git add:*)" "Bash(git commit:*)" "Bash(git checkout --:*)" "Bash(git restore:*)"
)
# Per-repo forms, because the loop's cwd is the workstream root and the prompt
# tells agents to use `git -C <repo> ...`.
for _r in atelier-api atelier-crm atelier-storefront; do
  for _v in status diff log show rev-parse ls-files check-ignore add commit restore; do
    ALLOWED+=("Bash(git -C $_r $_v:*)")
  done
  ALLOWED+=("Bash(git -C $_r checkout --:*)")
done

# Deny rules take precedence over allow rules. The pre-push hook installed below
# is the real guarantee — these are the cheap second line.
DISALLOWED=()
for _p in "" "-C atelier-api " "-C atelier-crm " "-C atelier-storefront "; do
  for _v in push rebase merge stash reset switch branch "cherry-pick" "remote" "clean"; do
    DISALLOWED+=("Bash(git ${_p}${_v}:*)")
  done
done
DISALLOWED+=("Bash(rm -rf:*)" "Bash(dropdb:*)" "Bash(createdb:*)" "Bash(psql:*)")

# The deterministic guard. Permission strings are matched by prefix, so a
# compound command could in principle slip past them; a hook cannot be talked
# around. Refuses every push from a loop worktree, and any push to main/master
# from anywhere. Hooks live in the common dir, so one install covers every
# worktree of that repo.
for _repo in /Users/verumoffice/atelier-api /Users/verumoffice/atelier-crm /Users/verumoffice/atelier-storefront; do
  [ -d "$_repo/.git" ] || continue
  _hook="$_repo/.git/hooks/pre-push"
  if [ ! -f "$_hook" ]; then
    cat > "$_hook" <<'HOOK'
#!/bin/bash
# Installed by ralph.sh. The live sites and API run off main/master; no
# autonomous loop may push anywhere, and nobody may push to those two.
while read -r local_ref _ remote_ref _; do
  case "$remote_ref" in
    refs/heads/main|refs/heads/master)
      echo "pre-push: refusing to push to ${remote_ref#refs/heads/} — the live site runs off it." >&2
      exit 1 ;;
  esac
  case "$local_ref" in
    refs/heads/aug6/*)
      echo "pre-push: refusing to push $local_ref — workstream branches are local until reviewed." >&2
      exit 1 ;;
  esac
done
exit 0
HOOK
    chmod +x "$_hook"
    echo "installed pre-push guard in $_repo"
  fi
done

echo "Ralph — $WS"
echo "  root         : $PWD"
echo "  repos        : ${REPOS[*]:-none}"
echo "  state        : $STATE_DIR"
echo "  iterations   : $MAX_ITERATIONS"
echo "  permissions  : scoped allowlist (NOT --dangerously-skip-permissions)"
echo ""

STALLED=0

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo ""
  echo "==============================================================="
  echo "  Iteration $i of $MAX_ITERATIONS — $WS"
  echo "==============================================================="

  BEFORE=$(commit_count)

  OUTPUT=$(claude --print \
    --permission-mode acceptEdits \
    --add-dir "$PWD" \
    --allowedTools "${ALLOWED[@]}" \
    --disallowedTools "${DISALLOWED[@]}" \
    < "$PROMPT_FILE" 2>&1 | tee /dev/stderr) || true

  AFTER=$(commit_count)

  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    if echo "$OUTPUT" | grep -q "^BLOCKED:"; then
      echo "STOPPED — blocked stories need a human."
      echo "See $STATE_DIR/BLOCKED.md"
      osascript -e "display notification \"Ralph blocked\" with title \"$WS\"" 2>/dev/null || true
      exit 3
    fi
    echo "All stories passed, at iteration $i of $MAX_ITERATIONS."
    exit 0
  fi

  if [ "$AFTER" -eq "$BEFORE" ]; then
    STALLED=$(( STALLED + 1 ))
    echo "WARNING: iteration $i produced no commit (stall $STALLED)."
    if [ "$STALLED" -ge 3 ]; then
      echo "Three consecutive iterations produced nothing — stopping."
      echo "Likely an expired session, a rate limit, or a permission denial."
      echo "Check the output above for a denied tool call and widen ALLOWED."
      osascript -e "display notification \"Ralph stalled\" with title \"$WS\"" 2>/dev/null || true
      exit 4
    fi
  else
    STALLED=0
  fi

  echo "Iteration $i complete."
  sleep 2
done

echo ""
echo "Reached max iterations ($MAX_ITERATIONS) without completing."
echo "Check $PROGRESS_FILE"
exit 1
