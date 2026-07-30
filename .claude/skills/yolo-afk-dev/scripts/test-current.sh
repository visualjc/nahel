#!/usr/bin/env bash
# test-current.sh — run tests on a worktree, diff against baseline.
#
# Usage: test-current.sh <state-dir> <prd-name> <issue-id> <worktree-path> <test-cmd>
# Writes: <state-dir>/prds/<prd-name>/issues/<issue-id>/test-current.json
#
# Output JSON includes:
#   - baseline_failures (from test-baseline.json)
#   - current_failures
#   - net_new (current minus baseline) — these trigger fix-loop
#   - baseline_intersection (failing on both) — pre-existing, log only
#
# Requires jq: it reads the baseline and assembles the output JSON, so any
# test cmd or failure line (double quotes, backslashes) encodes safely.

set -euo pipefail

STATE_DIR="${1:-}"
PRD_NAME="${2:-}"
ISSUE_ID="${3:-}"
WORKTREE_PATH="${4:-}"
TEST_CMD="${5:-}"

if [[ -z "$STATE_DIR" || -z "$PRD_NAME" || -z "$ISSUE_ID" \
      || -z "$WORKTREE_PATH" || -z "$TEST_CMD" ]]; then
  echo "usage: test-current.sh <state-dir> <prd-name> <issue-id> <worktree-path> <test-cmd>" >&2
  exit 2
fi

PRD_DIR="$STATE_DIR/prds/$PRD_NAME"
ISSUE_DIR="$PRD_DIR/issues/$ISSUE_ID"
mkdir -p "$ISSUE_DIR"
BASELINE="$PRD_DIR/test-baseline.json"
OUT="$ISSUE_DIR/test-current.json"
RAW="$ISSUE_DIR/test-current-raw.log"

if [[ ! -f "$BASELINE" ]]; then
  echo "error: baseline not found at $BASELINE; run test-baseline.sh first" >&2
  exit 3
fi

cd "$WORKTREE_PATH"

set +e
echo "===== TEST CMD: $TEST_CMD =====" >"$RAW"
# 5-minute hard timeout
( timeout 300 bash -c "$TEST_CMD" ) >>"$RAW" 2>&1
TEST_EXIT=$?
set -e

# `|| true` guards grep's exit-1-on-no-match: under `set -euo pipefail` a
# fully green test run (nothing to match) must not abort before the JSON
# is written (bug 0k83q678).
CURRENT_FAILURES=$({ grep -E '^\s*(●|FAIL |✗|❯ FAIL )' "$RAW" 2>/dev/null || true; } | sort -u)

# Extract baseline failures (one per line) for set ops
BASELINE_FAILURES=$(jq -r '.failures[]' "$BASELINE" 2>/dev/null | sort -u || true)

# net-new = current - baseline
NET_NEW=$(comm -23 <(echo "$CURRENT_FAILURES") <(echo "$BASELINE_FAILURES") 2>/dev/null || echo "$CURRENT_FAILURES")
# intersection = current AND baseline
INTERSECT=$(comm -12 <(echo "$CURRENT_FAILURES") <(echo "$BASELINE_FAILURES") 2>/dev/null || echo "")

# jq does the encoding — hand-rolled sed escaping only handled `"` and broke
# on backslashes, and $TEST_CMD was interpolated raw (bug b5e07bmt).
jq -n \
  --arg test_cmd "$TEST_CMD" \
  --argjson test_exit_code "$TEST_EXIT" \
  --arg captured_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --arg raw_log "$RAW" \
  --arg current_failures "$CURRENT_FAILURES" \
  --arg net_new "$NET_NEW" \
  --arg baseline_intersection "$INTERSECT" \
  'def lines: split("\n") | map(select(length > 0));
   {
     test_cmd: $test_cmd,
     test_exit_code: $test_exit_code,
     captured_at: $captured_at,
     raw_log: $raw_log,
     current_failures: ($current_failures | lines),
     net_new: ($net_new | lines),
     baseline_intersection: ($baseline_intersection | lines)
   }' > "$OUT"

echo "$OUT"
