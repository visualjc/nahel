#!/usr/bin/env bash
# halt.sh — write halt entry to state, append progress + human-review-needed,
# print the message the orchestrator should use for PushNotification.
#
# Usage: halt.sh <state-dir> <halted-at-phase> <reason>
#
# Does NOT call PushNotification (Claude orchestrator does that).
# Does NOT cancel ScheduleWakeup (orchestrator just omits it).

set -euo pipefail

STATE_DIR="${1:-}"
HALTED_AT="${2:-}"
REASON="${3:-}"

if [[ -z "$STATE_DIR" || -z "$HALTED_AT" || -z "$REASON" ]]; then
  echo "usage: halt.sh <state-dir> <halted-at-phase> <reason>" >&2
  exit 2
fi

if [[ ! -f "$STATE_DIR/state.json" ]]; then
  echo "error: state.json not found in $STATE_DIR" >&2
  exit 3
fi

NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RUN_ID="$(jq -r '.run_id' "$STATE_DIR/state.json")"

# Update state.json — atomic via tmpfile move
TMP="$STATE_DIR/state.json.tmp"
jq --arg phase "halted" \
   --arg halted_at "$HALTED_AT" \
   --arg reason "$REASON" \
   --arg now "$NOW" \
   '.phase = $phase | .halted_at_phase = $halted_at | .halt_reason = $reason | .last_wake_at = $now' \
   "$STATE_DIR/state.json" > "$TMP"
mv "$TMP" "$STATE_DIR/state.json"

# Append to progress.md
cat >> "$STATE_DIR/progress.md" <<MD

## $NOW — HALTED at $HALTED_AT
Reason: $REASON
Resume: \`/yolo-afk-dev resume $RUN_ID\`
MD

# Append to human-review-needed.md
cat >> "$STATE_DIR/human-review-needed.md" <<MD

## RUN HALTED — $NOW
Phase: $HALTED_AT
Reason: $REASON
State dir: $STATE_DIR
Resume: \`/yolo-afk-dev resume $RUN_ID\`
MD

# Print the notification message for the orchestrator to send via PushNotification
echo "$RUN_ID halted at $HALTED_AT. Reason: $REASON. Resume: /yolo-afk-dev resume $RUN_ID"
