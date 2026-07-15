#!/usr/bin/env bash
# codex-scope.sh — Codex independently estimates task scope (front-door
# scope-discovery, Step B). Fresh codex session, raw task only (NOT Claude's
# estimate), emits a scope-estimate per references/scope-discovery.md.
#
# Usage: codex-scope.sh <state-dir> [round]
#   round defaults to 1; pass 2 for the bounded second reconciliation round
#   (the orchestrator includes Claude's estimate + contested deltas in the
#   round-2 prompt; this script just routes it to a fresh codex call).
#
# Writes:
#   <state-dir>/scope/codex-scope[-r<round>].md          (codex output via -o)
#   <state-dir>/scope/codex-scope[-r<round>]-prompt.md   (saved prompt)
#   <state-dir>/scope/codex-scope[-r<round>].log         (JSONL stdout/stderr)
#   <state-dir>/scope/codex-scope[-r<round>]-status.txt  (only on timeout/fail)
#
# Prompt comes from stdin (orchestrator builds it from
# references/codex-review-prompts.md "Template 0: scope estimate", with
# {{CCPM_CONTEXT_PRIMING}} + {{DOMAIN_GLOSSARY}} resolved). Fed via `-` to
# avoid argv overflow (ARG_MAX ~256KB on macOS) and to persist the exact
# prompt for post-mortem / Sonnet-fallback re-use.
#
# Model: gpt-5.5 high reasoning — discovery is design-heavy (like the grill),
# not a quick review. --ignore-user-config is NOT applied: discovery should
# inherit project rules, same rationale as the grill turn.
#
# Exit codes:
#   0 — scope estimate written
#   1 — codex CLI failed (status file written for Sonnet fallback)
#   2 — bad arguments

set -euo pipefail

STATE_DIR="${1:-}"
ROUND="${2:-1}"

if [[ -z "$STATE_DIR" ]]; then
  echo "usage: codex-scope.sh <state-dir> [round]" >&2
  exit 2
fi

SCOPE_DIR="$STATE_DIR/scope"
mkdir -p "$SCOPE_DIR"

if [[ "$ROUND" == "1" ]]; then
  SUFFIX=""
else
  SUFFIX="-r$ROUND"
fi

OUT="$SCOPE_DIR/codex-scope$SUFFIX.md"
PROMPT_FILE="$SCOPE_DIR/codex-scope$SUFFIX-prompt.md"
LOG="$SCOPE_DIR/codex-scope$SUFFIX.log"
STATUS="$SCOPE_DIR/codex-scope$SUFFIX-status.txt"

# Read full prompt from stdin (orchestrator builds it from the template)
PROMPT="$(cat)"
printf '%s\n' "$PROMPT" > "$PROMPT_FILE"
rm -f "$OUT" "$LOG" "$STATUS"

if timeout 600 codex exec \
     -m gpt-5.5 \
     -c model_reasoning_effort=high \
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
  echo "error: codex exec failed for codex-scope; see $STATUS and $LOG" >&2
  exit 1
fi
