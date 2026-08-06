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
# nobody to approve a prompt. Expect the first workstream to stall on something
# legitimate; widen this list rather than reaching for bypassPermissions.
ALLOWED=(
  "Read" "Edit" "Write" "Glob" "Grep" "TodoWrite"
  "Bash(npm run lint)" "Bash(npm test)" "Bash(npm run build)"
  "Bash(npm run migrate)" "Bash(npm run migrate:down)" "Bash(npm run migrate:create:*)"
  "Bash(npm run seed)" "Bash(npm run convert:*)" "Bash(npm run import:*)"
  "Bash(node:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(find:*)" "Bash(wc:*)"
  "Bash(git -C * status:*)" "Bash(git -C * diff:*)" "Bash(git -C * log:*)"
  "Bash(git -C * show:*)" "Bash(git -C * add:*)" "Bash(git -C * commit:*)"
  "Bash(git -C * checkout -- *)" "Bash(git -C * rev-parse:*)"
)

# Belt and braces. These must never run, whatever the prompt says.
DISALLOWED=(
  "Bash(git push:*)" "Bash(git -C * push:*)"
  "Bash(git rebase:*)" "Bash(git -C * rebase:*)"
  "Bash(git merge:*)" "Bash(git -C * merge:*)"
  "Bash(git stash:*)" "Bash(git -C * stash:*)"
  "Bash(git reset:*)" "Bash(git -C * reset:*)"
  "Bash(git switch:*)" "Bash(git -C * switch:*)"
  "Bash(git branch:*)" "Bash(git -C * branch:*)"
  "Bash(git checkout:*)"
  "Bash(rm -rf:*)" "Bash(dropdb:*)" "Bash(psql:*)"
)

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
