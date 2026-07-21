---
allowed-tools: Read, LS
---

# Epic Oneshot

Decompose epic into tasks and sync to GitHub in one operation.

## Usage
```
/pm:epic-oneshot <feature_name>
```

## Instructions

### 1. Validate Prerequisites

Check that epic exists and hasn't been processed:
```bash
# Epic must exist
test -f .claude/epics/$ARGUMENTS/epic.md || echo "❌ Epic not found. New work is authored via the nahel prd-parse workflow (nahel/workflows/prd-parse.md); this command serves pre-existing ccpm epics only"

# Check for existing tasks
if ls .claude/epics/$ARGUMENTS/[0-9]*.md 2>/dev/null | grep -q .; then
  echo "⚠️ Tasks already exist. This will create duplicates."
  echo "Delete existing tasks or use /pm:epic-sync instead."
  exit 1
fi

# Check if already synced
if grep -q "github:" .claude/epics/$ARGUMENTS/epic.md; then
  echo "⚠️ Epic already synced to GitHub."
  echo "Use /pm:epic-sync to update."
  exit 1
fi
```

### 2. Execute Decompose

Decompose the epic via the canonical nahel workflow:
```
Following: nahel/workflows/epic-decompose.md for $ARGUMENTS
```

This will:
- Read the epic
- Create session-sized child tasks
- Update epic with task summary

### 3. Execute Sync

Immediately follow with sync:
```
Running: /pm:epic-sync $ARGUMENTS
```

This will:
- Create epic issue on GitHub
- Create sub-issues (using parallel agents if appropriate)
- Rename task files to issue IDs
- Create worktree

### 4. Output

```
🚀 Epic Oneshot Complete: $ARGUMENTS

Step 1: Decomposition ✓
  - Tasks created: {count}
  
Step 2: GitHub Sync ✓
  - Epic: #{number}
  - Sub-issues created: {count}
  - Worktree: ../epic-$ARGUMENTS

Ready for development!
  Start work: /pm:epic-start $ARGUMENTS
  Or advance a single task via the nahel task-lifecycle workflow
```

## Important Notes

This is simply a convenience wrapper that runs:
1. the nahel epic-decompose workflow (`nahel/workflows/epic-decompose.md`)
2. `/pm:epic-sync`

Both steps handle their own error checking and validation. This command just orchestrates them in sequence.

Use this when you're confident the epic is ready and want to go from epic to GitHub issues in one step.