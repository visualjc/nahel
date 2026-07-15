#!/usr/bin/env bash
# codex-grill-turn.sh — one round-trip of the Codex grill loop.
#
# Usage:
#   codex-grill-turn.sh <state-dir> <prd-name> initial <prompt-file>
#   codex-grill-turn.sh <state-dir> <prd-name> resume <session-id> <prompt-file>
#
# Writes:
#   <state-dir>/prds/<prd-name>/turn-NNN.md  (codex's last message via -o)
#   <state-dir>/prds/<prd-name>/codex-stderr.log  (appended)
#
# Returns session-id on stdout for `initial` mode (orchestrator captures and
# persists to state.json).
#
# Exit codes:
#   0 — turn succeeded, last message written
#   1 — codex CLI returned non-zero
#   2 — bad arguments

set -euo pipefail

STATE_DIR="${1:-}"
PRD_NAME="${2:-}"
MODE="${3:-}"

if [[ -z "$STATE_DIR" || -z "$PRD_NAME" || -z "$MODE" ]]; then
  echo "usage: codex-grill-turn.sh <state-dir> <prd-name> initial|resume [...]" >&2
  exit 2
fi

PRD_DIR="$STATE_DIR/prds/$PRD_NAME"
mkdir -p "$PRD_DIR"

# Find next turn number (find returns 0 even on no-match; ls + glob would
# fail under set -e + pipefail when no turn files exist yet)
NEXT_TURN_NUM=$(($(find "$PRD_DIR" -maxdepth 1 -name 'turn-*.md' 2>/dev/null | wc -l) + 1))
TURN_FILE="$PRD_DIR/$(printf 'turn-%03d.md' "$NEXT_TURN_NUM")"
STDERR_LOG="$PRD_DIR/codex-stderr.log"

case "$MODE" in
  initial)
    PROMPT_FILE="${4:-}"
    if [[ -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
      echo "error: initial mode requires <prompt-file>" >&2
      exit 2
    fi
    # Prompt is read from stdin via `-` to avoid argv overflow on large
    # grill prompts (ARG_MAX ~256KB on macOS). codex prints session metadata
    # (incl. "session id: <uuid>") to stderr.
    STDOUT_LOG="$PRD_DIR/codex-stdout.log"
    if codex exec \
         -m gpt-5.5 \
         -c model_reasoning_effort=high \
         -o "$TURN_FILE" \
         - \
         < "$PROMPT_FILE" \
         >"$STDOUT_LOG" 2>>"$STDERR_LOG"; then
      # Extract session id from stderr (format: "session id: <uuid>"). grep
      # may miss; that's not fatal — orchestrator will fall back to
      # `codex exec resume --last` for resumes.
      SESSION_ID=$(grep -m 1 -E '^session id:' "$STDERR_LOG" 2>/dev/null \
                     | sed -E 's/^session id:[[:space:]]*([0-9a-f-]+).*/\1/' \
                     || true)
      echo "$SESSION_ID"
      exit 0
    else
      echo "error: codex exec failed (initial); see $STDERR_LOG and $STDOUT_LOG" >&2
      exit 1
    fi
    ;;

  resume)
    SESSION_ID="${4:-}"
    PROMPT_FILE="${5:-}"
    if [[ -z "$SESSION_ID" || -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
      echo "usage: codex-grill-turn.sh <state-dir> <prd-name> resume <session-id> <prompt-file>" >&2
      exit 2
    fi
    # Prompt via stdin (`-`); model is fixed at session-create time so no -m here.
    if codex exec resume "$SESSION_ID" \
         -c model_reasoning_effort=high \
         -o "$TURN_FILE" \
         - \
         < "$PROMPT_FILE" \
         2>>"$STDERR_LOG"; then
      exit 0
    else
      echo "error: codex exec resume failed; see $STDERR_LOG" >&2
      exit 1
    fi
    ;;

  *)
    echo "error: unknown mode: $MODE (expected initial|resume)" >&2
    exit 2
    ;;
esac
