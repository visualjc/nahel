#!/usr/bin/env bash
# codex-review-prd.sh — Codex reviews a PRD doc, emits findings.
#
# Usage: codex-review-prd.sh <state-dir> <prd-name> <prd-path>
# Writes: <state-dir>/prds/<prd-name>/prd-review.md
#         <state-dir>/prds/<prd-name>/prd-review-prompt.md (saved prompt)
#         <state-dir>/prds/<prd-name>/prd-review.log
#         <state-dir>/prds/<prd-name>/prd-review-status.txt (only on timeout/fail)
#
# The orchestrator builds the actual prompt (per references/codex-review-prompts.md
# Template 1) and passes it via stdin. We write it to a file and feed codex
# via stdin (`-`) to avoid argv overflow on large PRD prompts (ARG_MAX
# ~256KB on macOS).

set -euo pipefail

STATE_DIR="${1:-}"
PRD_NAME="${2:-}"
PRD_PATH="${3:-}"

if [[ -z "$STATE_DIR" || -z "$PRD_NAME" || -z "$PRD_PATH" ]]; then
  echo "usage: codex-review-prd.sh <state-dir> <prd-name> <prd-path>" >&2
  exit 2
fi

if [[ ! -f "$PRD_PATH" ]]; then
  echo "error: PRD file not found: $PRD_PATH" >&2
  exit 3
fi

PRD_DIR="$STATE_DIR/prds/$PRD_NAME"
mkdir -p "$PRD_DIR"
OUT="$PRD_DIR/prd-review.md"
PROMPT_FILE="$PRD_DIR/prd-review-prompt.md"
LOG="$PRD_DIR/prd-review.log"
STATUS="$PRD_DIR/prd-review-status.txt"

# Read full prompt from stdin (orchestrator builds it from the template)
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
  echo "error: codex exec failed for prd-review; see $STATUS and $LOG" >&2
  exit 1
fi
