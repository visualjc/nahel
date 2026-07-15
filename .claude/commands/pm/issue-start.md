---
allowed-tools: Bash, Read, Write, LS, Task
---

# Issue Start

Begin work on a GitHub issue with parallel agents based on work stream analysis.

## Usage
```
/pm:issue-start <issue_number>
```

## Quick Check

1. **Get issue details:**
   ```bash
   gh issue view $ARGUMENTS --json state,title,labels,body
   ```
   If it fails: "❌ Cannot access issue #$ARGUMENTS. Check number or run: gh auth login"

2. **Find local task file:**
   - First check if `.claude/epics/*/$ARGUMENTS.md` exists (new naming)
   - If not found, search for file containing `github:.*issues/$ARGUMENTS` in frontmatter (old naming)
   - If not found: "❌ No local task for issue #$ARGUMENTS. This issue may have been created outside the PM system."

3. **Check for analysis:**
   ```bash
   test -f .claude/epics/*/$ARGUMENTS-analysis.md || echo "❌ No analysis found for issue #$ARGUMENTS
   
   Run: /pm:issue-analyze $ARGUMENTS first
   Or: /pm:issue-start $ARGUMENTS --analyze to do both"
   ```
   If no analysis exists and no --analyze flag, stop execution.

## Instructions

### 1. Check Configuration

```bash
PARALLEL_MODE=$(.claude/scripts/pm/resolve-config.sh PARALLEL_MODE)
WORKTREE_MODE=$(.claude/scripts/pm/resolve-config.sh WORKTREE_MODE)
```

### 2. Ensure Work Location

**IF `WORKTREE_MODE` is "true":**

Check if epic worktree exists:
```bash
# Find epic name from task file
epic_name={extracted_from_path}

# Check worktree
if ! git worktree list | grep -q "epic-$epic_name"; then
  echo "❌ No worktree for epic. Run: /pm:epic-start $epic_name"
  exit 1
fi

# Work in: ../epic-$epic_name/
```

**IF `WORKTREE_MODE` is "false":**

Check if current branch matches epic:
```bash
# Find epic name from task file
epic_name={extracted_from_path}

current_branch=$(git branch --show-current)
if [ "$current_branch" != "epic/$epic_name" ]; then
  echo "⚠️  You are not on the epic branch."
  echo "   Current: $current_branch"
  echo "   Required: epic/$epic_name"
  echo ""
  echo "   Please run: git checkout epic/$epic_name"
  exit 1
fi

# Work in: Current directory
```

---

### 3. Read Analysis

Read `.claude/epics/{epic_name}/$ARGUMENTS-analysis.md`:
- Parse parallel streams
- Identify which can start immediately
- Note dependencies between streams

### 4. Determine Execution Strategy

**Decision Point - Read Carefully:**

**IF `PARALLEL_MODE` is "false":**
- ✋ **STOP** - Do NOT use Task tool for parallel workers
- → Jump to "Sequential Execution" section below
- Work on one stream at a time with user approval

**IF `PARALLEL_MODE` is "true":**
- ✅ Proceed with "Parallel Agent Launch" section below
- Launch multiple agents for different streams

---

### 5. Parallel Agent Launch

**Only execute this section if PARALLEL_MODE="true".**

#### Setup Progress Tracking

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Create workspace structure:
```bash
mkdir -p .claude/epics/{epic_name}/updates/$ARGUMENTS
```

Update task file frontmatter `updated` field with current datetime.

#### Launch Agents

For each stream that can start immediately:

Create `.claude/epics/{epic_name}/updates/$ARGUMENTS/stream-{X}.md`:
```markdown
---
issue: $ARGUMENTS
stream: {stream_name}
agent: {agent_type}
started: {current_datetime}
status: in_progress
---

# Stream {X}: {stream_name}

## Scope
{stream_description}

## Files
{file_patterns}

## Progress
- Starting implementation
```

Launch agent using Task tool:
```yaml
Task:
  description: "Issue #$ARGUMENTS Stream {X}"
  subagent_type: "{agent_type}"
  prompt: |
    You are working on Issue #$ARGUMENTS in the epic worktree.
    
    Worktree location: ../epic-{epic_name}/
    Your stream: {stream_name}
    
    Your scope:
    - Files to modify: {file_patterns}
    - Work to complete: {stream_description}
    
    Requirements:
    1. Read full task from: .claude/epics/{epic_name}/{task_file}
    2. Work ONLY in your assigned files
    3. Commit frequently with format: "Issue #$ARGUMENTS: {specific change}"
    4. Update progress in: .claude/epics/{epic_name}/updates/$ARGUMENTS/stream-{X}.md
    5. Follow coordination rules in /rules/agent-coordination.md
    
    If you need to modify files outside your scope:
    - Check if another stream owns them
    - Wait if necessary
    - Update your progress file with coordination notes
    
    Complete your stream's work and mark as completed when done.
```

---

### 6. Sequential Execution

**Execute this section if PARALLEL_MODE="false".**

Work on streams one at a time with user control:

#### For Each Stream:

1. **Select Stream:**
   - List all streams from analysis
   - Show file patterns for each
   - Ask user: "Which stream to work on? (A/B/C or 'done')"

2. **Work on Selected Stream:**
   ```markdown
   Working on Stream {X}: {stream_name}

   Files: {file_patterns}
   Scope: {description}

   Implementing changes...
   ```

   - Read requirements from task file
   - Implement all changes for this stream
   - Test changes if possible
   - Commit stream: `git add {files} && git commit -m "Issue #$ARGUMENTS: {stream description}"`

3. **After Stream Complete:**
   - Show git diff summary
   - Ask user: "Stream {X} complete. Continue to next stream? (yes/no/review)"
     - yes → Select next stream
     - no → Stop, let user review
     - review → Show full `git diff`, then ask again

4. **Repeat Until All Streams Done**

**Benefits of Sequential Mode:**
- ✅ Full control over each stream
- ✅ Review changes before proceeding
- ✅ Run tests manually between streams
- ✅ No parallel coordination needed
- ✅ IDE sees all changes immediately

---

### 7. GitHub Assignment

```bash
# Assign to self and mark in-progress
gh issue edit $ARGUMENTS --add-assignee @me --add-label "in-progress"
```

### 8. Output

```
✅ Started parallel work on issue #$ARGUMENTS

Epic: {epic_name}
Worktree: ../epic-{epic_name}/

Launching {count} parallel agents:
  Stream A: {name} (Agent-1) ✓ Started
  Stream B: {name} (Agent-2) ✓ Started
  Stream C: {name} - Waiting (depends on A)

Progress tracking:
  .claude/epics/{epic_name}/updates/$ARGUMENTS/

Monitor with: /pm:epic-status {epic_name}
Sync updates: /pm:issue-sync $ARGUMENTS
```

## Error Handling

If any step fails, report clearly:
- "❌ {What failed}: {How to fix}"
- Continue with what's possible
- Never leave partial state

## Important Notes

Follow `/rules/datetime.md` for timestamps.
Keep it simple - trust that GitHub and file system work.