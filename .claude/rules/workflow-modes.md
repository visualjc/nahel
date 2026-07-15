# Workflow Modes

CCPM supports two primary workflow modes configured via `.claude/.ccpmrc`:

## Configuration Variables

### PARALLEL_MODE

Controls whether agents execute tasks concurrently or sequentially.

- **`true`** (default): Multiple agents work on different issues/streams simultaneously using the Task tool
- **`false`**: Sequential execution with human control at each step

### WORKTREE_MODE

Controls work location and branch isolation.

- **`true`** (default): Creates git worktrees at `../epic-{name}` for isolated workspaces
- **`false`**: Works in current directory using standard branches

## Safety Constraint

**CRITICAL**: `PARALLEL_MODE=true` requires `WORKTREE_MODE=true`

If `WORKTREE_MODE=false`, the system automatically forces `PARALLEL_MODE=false` to prevent git.index.lock contention from multiple agents working in the same directory.

This constraint is enforced by `.claude/scripts/pm/resolve-config.sh`.

## Recommended Configurations

### 100% Agentic (Default)

```bash
PARALLEL_MODE=true
WORKTREE_MODE=true
```

**Best for:**
- Fast autonomous execution
- Large epics with many parallel tasks
- CI/CD automation
- When you trust the agents fully

**Behavior:**
- Creates worktree at `../epic-{name}`
- Launches multiple agents simultaneously
- Minimal human intervention
- Fastest execution time

**Requirements:**
- Enable `bash-worktree-fix.sh` hook in settings.json
- Sufficient disk space for worktrees
- Terminal access to multiple directories

---

### Human-in-the-Loop (Recommended for IDE Work)

```bash
PARALLEL_MODE=false
WORKTREE_MODE=false
```

**Best for:**
- IDE-based development
- Seeing diffs in your editor
- Running unit tests manually
- Step-by-step verification
- Learning how CCPM works

**Behavior:**
- Works in current directory on `epic/{name}` branch
- One task/stream at a time
- Prompts for approval at each step
- Full visibility in IDE

**Requirements:**
- No special hooks needed
- Standard git workflow
- Manual branch switching

---

### Isolated + Manual

```bash
PARALLEL_MODE=false
WORKTREE_MODE=true
```

**Best for:**
- Working on multiple epics simultaneously
- Keeping main workspace clean
- Manual control with workspace isolation

**Behavior:**
- Creates worktree at `../epic-{name}`
- Sequential execution with prompts
- Isolated from main branch

**Requirements:**
- Enable `bash-worktree-fix.sh` hook
- Sufficient disk space for worktrees

---

## Configuration Methods

### Method 1: .ccpmrc File (Recommended)

Create `.claude/.ccpmrc`:

```bash
# Human-in-the-loop configuration
PARALLEL_MODE=false
WORKTREE_MODE=false
```

### Method 2: Environment Variables

```bash
export CCPM_PARALLEL_MODE=false
export CCPM_WORKTREE_MODE=false
```

### Precedence

1. Environment variables (`CCPM_PARALLEL_MODE`, `CCPM_WORKTREE_MODE`)
2. `.claude/.ccpmrc` file
3. Defaults (both `true`)

## Command Behavior by Mode

### /pm:epic-sync

**WORKTREE_MODE=true:**
- Creates worktree at `../epic-{name}` after sync
- Output: `Worktree: ../epic-{name}`

**WORKTREE_MODE=false:**
- Creates branch `epic/{name}` but stays in current directory
- Output: `Branch: epic/{name} (current directory mode)`
- Instructs user to run `/pm:epic-start {name}` to begin

---

### /pm:epic-start

**PARALLEL_MODE=true:**
- Launches multiple agents concurrently
- Works on all ready issues simultaneously
- Fastest execution

**PARALLEL_MODE=false:**
- Lists all ready issues
- Asks: "Which issue to work on? (issue number or 'skip')"
- Works on selected issue sequentially
- Prompts after each stream completion

---

### /pm:epic-decompose

**PARALLEL_MODE=true:**
- Uses Task tool to create all task files in parallel
- Fast for large epics

**PARALLEL_MODE=false:**
- Creates task files sequentially
- Shows progress for each task

---

### /pm:issue-start

**PARALLEL_MODE=true:**
- Launches multiple agents for streams (A, B, C)
- All streams work concurrently

**PARALLEL_MODE=false:**
- Lists available streams
- Asks: "Which stream to work on? (A/B/C or 'done')"
- Works on selected stream
- Prompts: "Stream {X} complete. Continue? (yes/no/review)"

---

## Workflow Comparison

| Aspect | Agentic (default) | Human-in-the-loop |
|--------|-------------------|-------------------|
| Speed | ⚡ Fastest | 🐢 Manual pace |
| Control | 🤖 Autonomous | 👤 Full control |
| Visibility | Terminal only | IDE integration |
| Learning curve | Steep | Gentle |
| Git workflow | Worktrees | Standard branches |
| Best for | Production | Development/Learning |

## Switching Between Modes

To switch modes, update `.claude/.ccpmrc` and start a new epic:

```bash
# Switch to human-in-the-loop
echo "PARALLEL_MODE=false" >> .claude/.ccpmrc
echo "WORKTREE_MODE=false" >> .claude/.ccpmrc

# Start new epic (will use new config)
/pm:prd-parse feature-name
/pm:epic-decompose feature-name
/pm:epic-sync feature-name
```

**Note**: Configuration changes only affect new epics. Existing worktrees/branches continue with their original mode.

## Troubleshooting

### "WARNING: PARALLEL_MODE forced to 'false'"

**Cause**: You set `PARALLEL_MODE=true` with `WORKTREE_MODE=false`

**Solution**: This is expected and safe. The system prevents git lock conflicts by forcing sequential execution when not using worktrees.

### "You are not on the epic branch"

**Cause**: Using `WORKTREE_MODE=false` but not on the correct branch

**Solution**: Run `git checkout epic/{name}` before `/pm:epic-start` or `/pm:issue-start`

### Worktree hook not working

**Cause**: `bash-worktree-fix.sh` hook disabled in settings.json

**Solution**: Enable hook when using `WORKTREE_MODE=true`, or set `WORKTREE_MODE=false` to avoid needing the hook

## See Also

- [.ccpmrc.example](/.claude/.ccpmrc.example) - Example configuration file
- [resolve-config.sh](/.claude/scripts/pm/resolve-config.sh) - Configuration resolution script
- [settings.json.example](/.claude/settings.json.example) - Hook configuration
