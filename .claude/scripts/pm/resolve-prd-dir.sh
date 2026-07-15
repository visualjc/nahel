#!/bin/bash

# Resolve the PRD directory according to precedence:
# 1) CCPM_PRD_DIR env var
# 2) .claude/.ccpmrc PRD_DIR value
# 3) Default: .claude/prds
#
# Behavior:
# - Outputs a repo-relative path (e.g., "docs/prds" or ".claude/prds")
# - With --ensure: creates the directory if missing; otherwise errors if not found

# Determine repository root (fall back to current dir if not a git repo)
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Source config if present (dotenv-style). Ignore comments/blank lines.
CFG="$ROOT/.claude/.ccpmrc"
if [ -f "$CFG" ]; then
  # shellcheck disable=SC1090
  set -a; . "$CFG" 2>/dev/null || true; set +a
fi

# Resolve PRD_DIR with precedence
_conf_prd="${PRD_DIR:-}"
PRD_DIR="${CCPM_PRD_DIR:-${_conf_prd:-}}"

# Default fallback (repo-relative)
if [ -z "${PRD_DIR}" ]; then
  PRD_DIR=".claude/prds"
fi

# Normalize: strip leading "./" and trailing slash
case "$PRD_DIR" in
  ./*) PRD_DIR="${PRD_DIR#./}" ;;
esac
PRD_DIR="${PRD_DIR%/}"

# Security: Prevent path traversal (must be within project root)
# Check if path contains ".."
if [[ "$PRD_DIR" == *".."* ]]; then
  echo "❌ Security Error: PRD directory path cannot contain '..'" >&2
  exit 1
fi

# Check if path starts with / (absolute path not allowed for repo-relative logic)
if [[ "$PRD_DIR" == /* ]]; then
  echo "❌ Security Error: PRD directory must be relative to project root" >&2
  exit 1
fi

# Ensure or validate directory
if [ "${1:-}" = "--ensure" ]; then
  # Create directory if it doesn't exist
  if ! mkdir -p "$ROOT/$PRD_DIR" 2>/dev/null; then
    echo "❌ Cannot create PRD directory: $ROOT/$PRD_DIR" >&2
    exit 1
  fi
else
  if [ ! -d "$ROOT/$PRD_DIR" ]; then
    echo "❌ PRD directory not found: $PRD_DIR (absolute: $ROOT/$PRD_DIR)" >&2
    exit 1
  fi
fi

# Output repo-relative path
echo "$PRD_DIR"
