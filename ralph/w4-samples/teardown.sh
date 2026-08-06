#!/bin/bash
# Teardown for W4 Samples. Run AFTER the branch is merged.
set -euo pipefail

WS=w4-samples
DB=atelier_w4
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
if [ -d "$ROOT/atelier-crm" ]; then
  if [ -n "$(git -C "$ROOT/atelier-crm" status --porcelain)" ]; then
    echo "atelier-crm has uncommitted changes. Refusing." >&2; exit 1
  fi
  if [ -n "$(git -C "$ROOT/atelier-crm" log --oneline august-6th-updates..HEAD)" ]; then
    echo "atelier-crm has commits not in august-6th-updates. Merge first, or delete by hand." >&2; exit 1
  fi
fi

git -C /Users/verumoffice/atelier-api worktree remove "$ROOT/atelier-api" 2>/dev/null || true
git -C /Users/verumoffice/atelier-api branch -D "aug6/$WS" 2>/dev/null || true
git -C /Users/verumoffice/atelier-crm worktree remove "$ROOT/atelier-crm" 2>/dev/null || true
git -C /Users/verumoffice/atelier-crm branch -D "aug6/$WS" 2>/dev/null || true
dropdb "$DB" 2>/dev/null || true
rmdir "$ROOT" 2>/dev/null || true
echo "Removed $ROOT and database $DB."
