#!/bin/bash
# verify.sh — the CI stand-in. Run from the WORKSTREAM ROOT.
#
# Usage: ./atelier-api/ralph/verify.sh <workstream-slug>
#
# Runs every gate for every repo present, captures each exit code, and writes a
# timestamped log into the workstream's state directory. Commit that log: it is
# what turns "gates were green at merge" from a claim into an artefact.
#
# There is no typecheck in any of these repos. Do not add one.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS="${1:-}"
[ -n "$WS" ] || { echo "Usage: $0 <workstream-slug>" >&2; exit 2; }

STATE_DIR="$SCRIPT_DIR/$WS"
mkdir -p "$STATE_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$STATE_DIR/verify-$STAMP.log"

FAILED=0

say() { echo "$@" | tee -a "$LOG"; }

run_gate() {
  local repo="$1"; shift
  local label="$*"
  say ""
  say "--- $repo: $label"
  ( cd "$repo" && eval "$@" ) >>"$LOG" 2>&1
  local code=$?
  if [ $code -eq 0 ]; then
    say "    exit 0"
  else
    say "    exit $code   *** FAILED ***"
    FAILED=1
  fi
}

say "verify.sh — workstream $WS"
say "root: $PWD"
say "utc:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"

for repo in atelier-api atelier-crm atelier-storefront; do
  [ -d "$repo" ] || continue
  say ""
  say "==================================================="
  say " $repo  @ $(git -C "$repo" rev-parse --abbrev-ref HEAD) $(git -C "$repo" rev-parse --short HEAD)"
  say "==================================================="
  case "$repo" in
    atelier-api)
      run_gate "$repo" "npm run lint"
      run_gate "$repo" "npm test"
      ;;
    atelier-crm)
      # No ESLint in this repo — `npm run build` is the only compile check.
      run_gate "$repo" "npm test"
      run_gate "$repo" "npm run build"
      ;;
    atelier-storefront)
      run_gate "$repo" "npm run lint"
      run_gate "$repo" "npm test"
      run_gate "$repo" "npm run build"
      ;;
  esac
done

# Converter byte-identity guard: the committed 8 MB JSON must only change when
# its inputs change. A diff here means the converter's output format drifted.
if [ -d atelier-api ] && [ -f atelier-api/src/seed/data/price-lists.json ]; then
  say ""
  say "--- atelier-api: converter byte-identity"
  ( cd atelier-api && npm run convert:pricing ) >>"$LOG" 2>&1
  if git -C atelier-api diff --quiet src/seed/data/price-lists.json; then
    say "    price-lists.json unchanged — exit 0"
  else
    say "    price-lists.json CHANGED   *** FAILED ***"
    say "    If this is an intentional data refresh, commit it ALONE, with the"
    say "    converter unchanged in that commit."
    FAILED=1
  fi
fi

say ""
if [ $FAILED -eq 0 ]; then
  say "ALL GATES GREEN"
else
  say "GATES FAILED — see $LOG"
fi
say "log: $LOG"
exit $FAILED
