#!/bin/bash
# Teardown for W9 Scanner spike. Run AFTER the branch is merged.
set -euo pipefail

WS=w9-scanner-spike
DB=atelier_w9
ROOT=/Users/verumoffice/atelier-worktrees/$WS

# Refuse to discard unmerged work.
if [ -d "$ROOT/atelier-api" ]; then
  if [ -n "$(git -C "$ROOT/atelier-api" status --porcelain)" ]; then
    echo "atelier-api has uncommitted changes. Refusing." >&2; exit 1
  fi
  if [ -n "$(git -C "$ROOT/atelier-api" log --oneline august-6th-updates..HEAD)" ]; then
    echo "atelier-api has commits not in august-6th-updates. Merge first, or delete by hand." >&2; exit 1
  fi
fi

git -C /Users/verumoffice/atelier-api worktree remove "$ROOT/atelier-api" 2>/dev/null || true
git -C /Users/verumoffice/atelier-api branch -D "aug6/$WS" 2>/dev/null || true
dropdb "$DB" 2>/dev/null || true
rmdir "$ROOT" 2>/dev/null || true
echo "Removed $ROOT and database $DB."
