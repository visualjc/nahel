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

CURRENT_FAILURES=$(grep -E '^\s*(●|FAIL |✗|❯ FAIL )' "$RAW" 2>/dev/null | sort -u)

# Extract baseline failures (one per line) for set ops
BASELINE_FAILURES=$(jq -r '.failures[]' "$BASELINE" 2>/dev/null | sort -u || true)

# net-new = current - baseline
NET_NEW=$(comm -23 <(echo "$CURRENT_FAILURES") <(echo "$BASELINE_FAILURES") 2>/dev/null || echo "$CURRENT_FAILURES")
# intersection = current AND baseline
INTERSECT=$(comm -12 <(echo "$CURRENT_FAILURES") <(echo "$BASELINE_FAILURES") 2>/dev/null || echo "")

json_escape_lines() {
  # Convert newline-separated input → JSON array of strings
  echo "$1" \
    | grep -v '^$' \
    | sed 's/"/\\"/g' \
    | awk '{printf "    \"%s\",\n", $0}' \
    | sed '$ s/,$//'
}

cat > "$OUT" <<JSON
{
  "test_cmd": "$TEST_CMD",
  "test_exit_code": $TEST_EXIT,
  "captured_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "raw_log": "$RAW",
  "current_failures": [
$(json_escape_lines "$CURRENT_FAILURES")
  ],
  "net_new": [
$(json_escape_lines "$NET_NEW")
  ],
  "baseline_intersection": [
$(json_escape_lines "$INTERSECT")
  ]
}
JSON

echo "$OUT"
