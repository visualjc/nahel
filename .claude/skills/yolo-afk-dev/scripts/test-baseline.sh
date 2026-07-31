#!/usr/bin/env bash
# test-baseline.sh — capture failing tests on the PRD's base branch.
#
# Usage: test-baseline.sh <state-dir> <prd-name> <base-ref> <test-cmd>
# Writes: <state-dir>/prds/<prd-name>/test-baseline.json
#
# Requires jq: the output JSON is assembled with it, so any test cmd or
# failure line (double quotes, backslashes, control chars) encodes safely.
#
# Detects pnpm/npm/yarn from <repo>/package.json + lockfile.
# Test cmd is project-specific; orchestrator passes it (e.g. "pnpm --filter
# @flip/frontend test --coverage=false").
#
# Strategy:
#   - Stash any uncommitted changes (workspace must be clean)
#   - Checkout base ref in a fresh ephemeral worktree (don't disturb main tree)
#   - Run test cmd, capture output
#   - Parse failure list (best-effort regex; logs raw output for diagnosis)
#   - Cleanup ephemeral worktree

set -euo pipefail

STATE_DIR="${1:-}"
PRD_NAME="${2:-}"
BASE_REF="${3:-}"
TEST_CMD="${4:-}"

if [[ -z "$STATE_DIR" || -z "$PRD_NAME" || -z "$BASE_REF" || -z "$TEST_CMD" ]]; then
  echo "usage: test-baseline.sh <state-dir> <prd-name> <base-ref> <test-cmd>" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
PRD_DIR="$STATE_DIR/prds/$PRD_NAME"
mkdir -p "$PRD_DIR"
OUT="$PRD_DIR/test-baseline.json"
RAW="$PRD_DIR/test-baseline-raw.log"

WORKTREE_DIR="$REPO_ROOT/.git/worktrees-yolo/baseline-$PRD_NAME"
trap 'cd "$REPO_ROOT" && git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true' EXIT

# Ensure parent dir exists for worktree
mkdir -p "$(dirname "$WORKTREE_DIR")"

# Create the worktree at the base ref
if ! git worktree add --detach "$WORKTREE_DIR" "$BASE_REF" 2>>"$RAW"; then
  echo "error: failed to create baseline worktree at $WORKTREE_DIR" >&2
  exit 3
fi

cd "$WORKTREE_DIR"

# Install deps if pnpm-lock present (best-effort; many projects skip if cached)
if [[ -f "pnpm-lock.yaml" ]]; then
  pnpm install --frozen-lockfile >>"$RAW" 2>&1 || echo "warn: pnpm install failed; continuing" >>"$RAW"
fi

# Run tests; capture both exit code and output
set +e
echo "===== TEST CMD: $TEST_CMD =====" >>"$RAW"
eval "$TEST_CMD" >>"$RAW" 2>&1
TEST_EXIT=$?
set -e

# Best-effort failure extraction:
# - Jest: lines like "  ● <test name>" or "FAIL <path>"
# - Vitest: similar "❯" or "FAIL"
# - generic: "✗" or "FAIL"
# `|| true` guards grep's exit-1-on-no-match: under `set -euo pipefail` a
# fully green test run (nothing to match) must not abort before the JSON
# is written (bug 0k83q678).
FAILURES=$({ grep -E '^\s*(●|FAIL |✗|❯ FAIL )' "$RAW" 2>/dev/null || true; })

# jq does the encoding — hand-rolled sed escaping only handled `"` and broke
# on backslashes, and $TEST_CMD was interpolated raw (bug b5e07bmt).
jq -n \
  --arg base_ref "$BASE_REF" \
  --arg test_cmd "$TEST_CMD" \
  --argjson test_exit_code "$TEST_EXIT" \
  --arg captured_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --arg raw_log "$RAW" \
  --arg failures "$FAILURES" \
  '{
     base_ref: $base_ref,
     test_cmd: $test_cmd,
     test_exit_code: $test_exit_code,
     captured_at: $captured_at,
     raw_log: $raw_log,
     failures: ($failures | split("\n") | map(select(length > 0)))
   }' > "$OUT"

echo "$OUT"
