#!/usr/bin/env bash
# codex-review-epic.sh — Codex reviews an epic + task decomposition.
#
# Usage: codex-review-epic.sh <state-dir> <prd-name>
# Writes: <state-dir>/prds/<prd-name>/epic-review.md
#         <state-dir>/prds/<prd-name>/epic-review-prompt.md (saved prompt)
#         <state-dir>/prds/<prd-name>/epic-review.log
#         <state-dir>/prds/<prd-name>/epic-review-status.txt (only on timeout/fail)
#
# Orchestrator passes the full prompt (per references/codex-review-prompts.md
# Template 2) via stdin. We write it to a file and feed codex via stdin (`-`)
# to avoid argv overflow on large epic+tasks prompts (ARG_MAX ~256KB on macOS).

set -euo pipefail

STATE_DIR="${1:-}"
PRD_NAME="${2:-}"

if [[ -z "$STATE_DIR" || -z "$PRD_NAME" ]]; then
  echo "usage: codex-review-epic.sh <state-dir> <prd-name>" >&2
  exit 2
fi

PRD_DIR="$STATE_DIR/prds/$PRD_NAME"
mkdir -p "$PRD_DIR"
OUT="$PRD_DIR/epic-review.md"
PROMPT_FILE="$PRD_DIR/epic-review-prompt.md"
LOG="$PRD_DIR/epic-review.log"
STATUS="$PRD_DIR/epic-review-status.txt"

PROMPT="$(cat)"
printf '%s\n' "$PROMPT" > "$PROMPT_FILE"
rm -f "$OUT" "$LOG" "$STATUS"

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
  echo "error: codex exec failed for epic-review; see $STATUS and $LOG" >&2
  exit 1
fi
