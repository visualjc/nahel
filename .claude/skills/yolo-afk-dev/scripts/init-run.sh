#!/usr/bin/env bash
# init-run.sh — bootstrap a yolo-afk-dev run.
# Usage: init-run.sh <run-id> <input-source-type> <input-content-or-path> [mode] [pr_topology]
#   input-source-type: "inline" | "path"
#   input-content-or-path: bullets text (inline) or absolute file path (path)
#   mode (optional): "inline" (default) | "recycle"
#   pr_topology (optional): "per-epic" (default — ONE draft PR per epic, opened
#                           at Phase 11) | "per-issue" (opt-in: one draft PR
#                           per issue, opened at Phase 10.2.f). Memory key
#                           `yolo_afk_dev_pr_topology` in the project memory
#                           dir overrides this arg if present.
#
# Creates: <repo>/.claude/state/yolo-afk-dev/<run-id>/{state.json, progress.md,
#          human-review-needed.md, input-tasks.md, prds/}
# Idempotent: if run-id already exists, fails (won't clobber).
#
# Repo-split discovery: scans
#   ~/.claude/projects/<encoded-repo-path>/memory/reference_gh_repo_split*.md
# for `Issues: <repo>` and `PRs: <repo>` lines. If absent or unparseable,
# defaults both to "origin". Never halts for missing repo config.

set -euo pipefail

RUN_ID="${1:-}"
INPUT_TYPE="${2:-}"
INPUT_VALUE="${3:-}"
MODE="${4:-inline}"
PR_TOPOLOGY="${5:-per-epic}"

if [[ -z "$RUN_ID" || -z "$INPUT_TYPE" ]]; then
  echo "usage: init-run.sh <run-id> <inline|path> <content-or-path> [mode] [pr_topology]" >&2
  exit 2
fi

case "$MODE" in
  inline|recycle) ;;
  *)
    echo "error: invalid mode '$MODE' (expected 'inline' or 'recycle')" >&2
    exit 2
    ;;
esac

case "$PR_TOPOLOGY" in
  per-epic|per-issue) ;;
  *)
    echo "error: invalid pr_topology '$PR_TOPOLOGY' (expected 'per-epic' or 'per-issue')" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "error: not in a git repository" >&2
  exit 3
fi

STATE_DIR="$REPO_ROOT/.claude/state/yolo-afk-dev/$RUN_ID"

if [[ -d "$STATE_DIR" ]]; then
  echo "error: state dir already exists: $STATE_DIR" >&2
  echo "use a fresh run-id or call resume.sh to resume" >&2
  exit 4
fi

mkdir -p "$STATE_DIR/prds"

case "$INPUT_TYPE" in
  inline)
    printf '%s\n' "$INPUT_VALUE" > "$STATE_DIR/input-tasks.md"
    ;;
  path)
    if [[ ! -f "$INPUT_VALUE" ]]; then
      echo "error: input file not found: $INPUT_VALUE" >&2
      exit 5
    fi
    cp "$INPUT_VALUE" "$STATE_DIR/input-tasks.md"
    ;;
  *)
    echo "error: unknown input type: $INPUT_TYPE (expected inline|path)" >&2
    exit 6
    ;;
esac

# Repo-split discovery: derive memory dir from repo path, scan for the
# reference memory file, parse `Issues:` / `PRs:` lines. Default to "origin".
ENCODED_PATH="$(printf '%s' "$REPO_ROOT" | tr '/' '-')"
MEM_DIR="$HOME/.claude/projects/${ENCODED_PATH}/memory"

GH_ISSUE_REPO="origin"
GH_PR_REPO="origin"

if [[ -d "$MEM_DIR" ]]; then
  # Use the most recently-modified matching memory file if multiple exist.
  MEM_FILE="$(ls -t "$MEM_DIR"/reference_gh_repo_split*.md 2>/dev/null | head -n 1 || true)"
  if [[ -n "$MEM_FILE" && -f "$MEM_FILE" ]]; then
    PARSED_ISSUES="$(grep -E '^[[:space:]]*[-*]?[[:space:]]*Issues:' "$MEM_FILE" \
      | head -n 1 | sed -E 's/^[[:space:]]*[-*]?[[:space:]]*Issues:[[:space:]]*//' \
      | tr -d ' \t' || true)"
    PARSED_PRS="$(grep -E '^[[:space:]]*[-*]?[[:space:]]*PRs:' "$MEM_FILE" \
      | head -n 1 | sed -E 's/^[[:space:]]*[-*]?[[:space:]]*PRs:[[:space:]]*//' \
      | tr -d ' \t' || true)"
    if [[ -n "$PARSED_ISSUES" ]]; then
      GH_ISSUE_REPO="$PARSED_ISSUES"
    fi
    if [[ -n "$PARSED_PRS" ]]; then
      GH_PR_REPO="$PARSED_PRS"
    fi
  fi

  # pr_topology memory override (any file matching yolo_afk_dev_pr_topology*.md,
  # parse first `topology: per-epic|per-issue` line). Memory wins over the flag.
  TOPO_FILE="$(ls -t "$MEM_DIR"/yolo_afk_dev_pr_topology*.md 2>/dev/null | head -n 1 || true)"
  if [[ -n "$TOPO_FILE" && -f "$TOPO_FILE" ]]; then
    PARSED_TOPO="$(grep -E '^[[:space:]]*[-*]?[[:space:]]*topology:' "$TOPO_FILE" \
      | head -n 1 | sed -E 's/^[[:space:]]*[-*]?[[:space:]]*topology:[[:space:]]*//' \
      | tr -d ' \t' || true)"
    if [[ "$PARSED_TOPO" == "per-epic" || "$PARSED_TOPO" == "per-issue" ]]; then
      PR_TOPOLOGY="$PARSED_TOPO"
    fi
  fi
fi

NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

cat > "$STATE_DIR/state.json" <<JSON
{
  "\$schema_version": "1.2",
  "run_id": "$RUN_ID",
  "started_at": "$NOW",
  "last_wake_at": "$NOW",
  "last_progress_touch": "$NOW",
  "repo_root": "$REPO_ROOT",
  "input_source": "$INPUT_TYPE",
  "input_path": $(if [[ "$INPUT_TYPE" == "path" ]]; then printf '"%s"' "$INPUT_VALUE"; else printf 'null'; fi),
  "config": {
    "parallel_cap": 2,
    "mode": "$MODE",
    "gh_issue_repo": "$GH_ISSUE_REPO",
    "gh_pr_repo": "$GH_PR_REPO",
    "pr_topology": "$PR_TOPOLOGY"
  },
  "phase": "init",
  "halted_at_phase": null,
  "halt_reason": null,
  "next_phase": null,
  "current_prd_index": 0,
  "current_issue_id": null,
  "current_review_iter": 0,
  "starting_branch": "$CURRENT_BRANCH",
  "prds": [],
  "retries": {
    "grill_turn": 0,
    "codex_review": 0,
    "ccpm_mutation": 0,
    "gh_op": 0,
    "lint_fix": 0,
    "typecheck_fix": 0,
    "test_fix": 0,
    "diff_review_iter": 0,
    "worktree_create": 0
  }
}
JSON

cat > "$STATE_DIR/progress.md" <<MD
# yolo-afk-dev — run $RUN_ID

## $NOW — phase: init
Started run. Input: $INPUT_TYPE. Repo: $REPO_ROOT. Starting branch: $CURRENT_BRANCH.
Mode: $MODE. gh_issue_repo: $GH_ISSUE_REPO. gh_pr_repo: $GH_PR_REPO.
pr_topology: $PR_TOPOLOGY (default per-epic — one draft PR for the whole feature at Phase 11).
MD

cat > "$STATE_DIR/human-review-needed.md" <<MD
# Human review needed — run $RUN_ID

This file collects load-bearing decisions Claude made on your behalf, lint/typecheck/test failures that resisted fixing, and per-issue review findings that didn't get resolved within the iteration cap.

If this file is empty when the run finishes, no human follow-up is needed.

MD

echo "$STATE_DIR"
