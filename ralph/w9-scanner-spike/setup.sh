#!/bin/bash
# Setup for W9 Scanner spike. Run it once, from anywhere:
#   /Users/verumoffice/atelier-api/ralph/w9-scanner-spike/setup.sh
#
# Do NOT copy-paste this file into a terminal. Run it.
set -euo pipefail

WS=w9-scanner-spike
DB=atelier_w9
ROOT=/Users/verumoffice/atelier-worktrees/$WS

if [ -e "$ROOT" ]; then
  echo "$ROOT already exists. Remove it first, or run teardown.sh." >&2
  exit 1
fi
mkdir -p "$ROOT"

echo "==> worktrees"
git -C /Users/verumoffice/atelier-api worktree add -b "aug6/$WS" "$ROOT/atelier-api" august-6th-updates

echo "==> node_modules symlinks (a story needing a NEW dependency must mark itself BLOCKED)"
ln -s /Users/verumoffice/atelier-api/node_modules "$ROOT/atelier-api/node_modules"

echo "==> .env (gitignored, so a worktree does not inherit it)"
cp /Users/verumoffice/atelier-api/.env "$ROOT/atelier-api/.env"

echo "==> database (never share atelier_dev between concurrent loops)"
createdb "$DB" 2>/dev/null || echo "    $DB already exists, reusing"
sed -i "" "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/$DB|" "$ROOT/atelier-api/.env"

# The failure this script exists to prevent: a half-run setup leaves .env
# pointing at atelier_dev and the loop migrates the shared database.
if ! grep -q "^DATABASE_URL=postgresql://localhost:5432/$DB$" "$ROOT/atelier-api/.env"; then
  echo "FATAL: DATABASE_URL was not rewritten to $DB. Refusing to continue." >&2
  grep "^DATABASE_URL=" "$ROOT/atelier-api/.env" >&2
  exit 1
fi
( cd "$ROOT/atelier-api" && npm run migrate )

echo "==> gates (must be green BEFORE the loop starts)"
cd "$ROOT"
( cd atelier-api && npm run lint && npm test )

echo ""
echo "Ready. Launch with:"
echo "  cd $ROOT"
echo "  ./atelier-api/ralph/ralph.sh $WS 5"
