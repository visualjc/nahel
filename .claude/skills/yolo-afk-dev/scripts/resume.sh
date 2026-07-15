#!/usr/bin/env bash
# resume.sh — find and validate the target run-id for resume.
#
# Usage:
#   resume.sh                    # most recent halted run in current repo
#   resume.sh <run-id>           # specific run-id
#
# On success, prints absolute path to the state dir on stdout.
# On failure, prints error to stderr and exits non-zero.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "error: not in a git repository" >&2
  exit 3
fi

STATE_BASE="$REPO_ROOT/.claude/state/yolo-afk-dev"

if [[ ! -d "$STATE_BASE" ]]; then
  echo "error: no yolo-afk-dev runs found in this repo (no $STATE_BASE)" >&2
  exit 4
fi

RUN_ID="${1:-}"

is_resumable_phase() {
  case "$1" in
    halted|recycle) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ -n "$RUN_ID" ]]; then
  STATE_DIR="$STATE_BASE/$RUN_ID"
  if [[ ! -d "$STATE_DIR" ]]; then
    echo "error: run-id not found: $RUN_ID" >&2
    exit 5
  fi
  if [[ ! -f "$STATE_DIR/state.json" ]]; then
    echo "error: state.json missing for run-id: $RUN_ID" >&2
    exit 6
  fi
  PHASE="$(jq -r '.phase' "$STATE_DIR/state.json")"
  if ! is_resumable_phase "$PHASE"; then
    echo "error: run $RUN_ID is in phase '$PHASE'; refusing to resume (expected halted or recycle)" >&2
    exit 7
  fi
  echo "$STATE_DIR"
  exit 0
fi

# Most recent halted-or-recycle run
LATEST=""
LATEST_TS=""
for state_file in "$STATE_BASE"/*/state.json; do
  [[ -f "$state_file" ]] || continue
  PHASE="$(jq -r '.phase' "$state_file")"
  if is_resumable_phase "$PHASE"; then
    TS="$(jq -r '.last_wake_at' "$state_file")"
    if [[ -z "$LATEST_TS" || "$TS" > "$LATEST_TS" ]]; then
      LATEST_TS="$TS"
      LATEST="$(dirname "$state_file")"
    fi
  fi
done

if [[ -z "$LATEST" ]]; then
  echo "error: no halted or recycle runs found in $STATE_BASE" >&2
  exit 8
fi

echo "$LATEST"
