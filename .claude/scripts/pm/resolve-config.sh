#!/bin/bash

# Resolve CCPM configuration with safety constraints
#
# Usage:
#   resolve-config.sh [CONFIG_KEY]
#
# Returns:
#   If CONFIG_KEY provided: Returns value of that config (e.g., "true" or "false")
#   If no argument: Returns all config as KEY=VALUE lines
#
# Precedence:
#   1) Environment variables (CCPM_PARALLEL_MODE, CCPM_WORKTREE_MODE)
#   2) .claude/.ccpmrc file (PARALLEL_MODE=..., WORKTREE_MODE=...)
#   3) Defaults (both true)
#
# Safety Constraint:
#   If WORKTREE_MODE=false, PARALLEL_MODE is forced to false
#   (prevents git lock conflicts from multiple agents in same directory)

# Determine repository root
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Configuration file path
CFG="$ROOT/.claude/.ccpmrc"

# Source config file if it exists
if [ -f "$CFG" ]; then
  # shellcheck disable=SC1090
  set -a; . "$CFG" 2>/dev/null || true; set +a
fi

# Apply precedence: ENV → config → default
PARALLEL_MODE="${CCPM_PARALLEL_MODE:-${PARALLEL_MODE:-true}}"
WORKTREE_MODE="${CCPM_WORKTREE_MODE:-${WORKTREE_MODE:-true}}"

# Normalize values to lowercase true/false
case "$PARALLEL_MODE" in
  [Tt][Rr][Uu][Ee]|1|[Yy][Ee][Ss]) PARALLEL_MODE="true" ;;
  *) PARALLEL_MODE="false" ;;
esac

case "$WORKTREE_MODE" in
  [Tt][Rr][Uu][Ee]|1|[Yy][Ee][Ss]) WORKTREE_MODE="true" ;;
  *) WORKTREE_MODE="false" ;;
esac

# 🔴 CRITICAL SAFETY CONSTRAINT
# Never allow parallel execution without worktrees
# Multiple agents in same directory = git.index.lock contention and race conditions
if [ "$WORKTREE_MODE" = "false" ]; then
  # Store original value to detect if user tried to override
  ORIGINAL_PARALLEL="${CCPM_PARALLEL_MODE:-${PARALLEL_MODE}}"

  # Force parallel mode off
  PARALLEL_MODE="false"

  # Warn if user explicitly tried to enable parallel mode
  if [ "$ORIGINAL_PARALLEL" = "true" ] && [ -n "${CCPM_PARALLEL_MODE}${1}" ]; then
    echo "⚠️  WARNING: PARALLEL_MODE forced to 'false' because WORKTREE_MODE=false" >&2
    echo "   (Parallel execution in same directory causes git lock conflicts)" >&2
  fi
fi

# Return requested config value or all
case "$1" in
  PARALLEL_MODE)
    echo "$PARALLEL_MODE"
    ;;
  WORKTREE_MODE)
    echo "$WORKTREE_MODE"
    ;;
  *)
    # Return all config as KEY=VALUE lines
    echo "PARALLEL_MODE=$PARALLEL_MODE"
    echo "WORKTREE_MODE=$WORKTREE_MODE"
    ;;
esac
