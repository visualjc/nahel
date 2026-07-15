#!/usr/bin/env bash
# codex-review-diff.sh — Codex reviews a single issue's diff.
#
# Usage: codex-review-diff.sh <state-dir> <prd-name> <issue-id> <iter> <worktree-path> <base-ref>
# Writes: <state-dir>/prds/<prd-name>/issues/<issue-id>/codex-review-iter-<iter>.md
#
# Orchestrator passes the full prompt (per references/codex-review-prompts.md
# Template 3, including anti-revert guard) via stdin.
#
# Strategy:
#   Use `codex exec` with the diff inlined into the prompt so the mandatory
#   anti-revert guard is preserved.

set -euo pipefail

STATE_DIR="${1:-}"
PRD_NAME="${2:-}"
ISSUE_ID="${3:-}"
ITER="${4:-}"
WORKTREE_PATH="${5:-}"
BASE_REF="${6:-}"

if [[ -z "$STATE_DIR" || -z "$PRD_NAME" || -z "$ISSUE_ID" || -z "$ITER" \
      || -z "$WORKTREE_PATH" || -z "$BASE_REF" ]]; then
  echo "usage: codex-review-diff.sh <state-dir> <prd-name> <issue-id> <iter> <worktree-path> <base-ref>" >&2
  exit 2
fi

ISSUE_DIR="$STATE_DIR/prds/$PRD_NAME/issues/$ISSUE_ID"
mkdir -p "$ISSUE_DIR"
OUT="$ISSUE_DIR/codex-review-iter-$ITER.md"
STDERR="$ISSUE_DIR/codex-review-iter-$ITER-stderr.log"
LOG="$ISSUE_DIR/codex-review-iter-$ITER.log"
PROMPT_FILE="$ISSUE_DIR/codex-review-iter-$ITER-prompt.md"
STATUS="$ISSUE_DIR/codex-review-iter-$ITER-status.txt"

PROMPT="$(cat)"

# Inlined-diff fallback (reliable, supports our custom prompt)
DIFF_FILE="$ISSUE_DIR/diff-iter-$ITER.patch"
git -C "$WORKTREE_PATH" diff "$BASE_REF...HEAD" > "$DIFF_FILE" 2>"$STDERR" || true

if [[ ! -s "$DIFF_FILE" ]]; then
  echo "error: empty diff for issue $ISSUE_ID at iter $ITER" >&2
  exit 4
fi

# Substitute {{ISSUE_DIFF}} in prompt with actual diff content
PROMPT_WITH_DIFF="${PROMPT//\{\{ISSUE_DIFF\}\}/$(cat "$DIFF_FILE")}"
printf '%s\n' "$PROMPT_WITH_DIFF" > "$PROMPT_FILE"
rm -f "$OUT" "$LOG" "$STATUS"

cd "$WORKTREE_PATH"
if timeout 600 codex exec \
     --ignore-user-config \
     -m gpt-5.3-codex-spark \
     --sandbox read-only \
     --json \
     -o "$OUT" \
     - \
     < "$PROMPT_FILE" >"$LOG" 2>&1; then
  exit 0
else
  CODEX_EXIT=$?
  rm -f "$OUT"
  if [[ "$CODEX_EXIT" -eq 124 ]]; then
    printf 'codex_timeout seconds=600 log=%s prompt=%s\n' "$LOG" "$PROMPT_FILE" > "$STATUS"
  else
    printf 'codex_failed exit=%s log=%s prompt=%s\n' "$CODEX_EXIT" "$LOG" "$PROMPT_FILE" > "$STATUS"
  fi
  echo "error: codex exec failed for diff review; see $STATUS and $LOG" >&2
  exit 1
fi
