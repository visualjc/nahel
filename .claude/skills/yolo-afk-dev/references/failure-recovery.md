# Failure recovery — halt-on-cap, resume semantics

## Retry budgets

| Phase | Budget | On cap |
|---|---|---|
| Codex scope estimate (Phase 2) | 1 retry, then Sonnet fallback | **continue** — if codex + Sonnet both fail, treat scope as unverified and **ratchet to the higher candidate lane**. Never halt: scope is judgment, and the safe failure mode is more ceremony, not stopping. |
| Codex grill turn (Phase 3, Full lane) | 1 retry | **halt** — broken session can't be papered over |
| Codex review — PRD (Phase 5) | 3 retries | **halt** |
| Codex review — epic (Phase 7) | 3 retries | **halt** |
| Codex review — diff (Phase 10.2.e) | 3 retries on the codex call itself | **halt** |
| ccpm LLM-driven mutation (Phases 4, 6, 8) | 3 retries | **halt** |
| `gh` CLI op (Phase 9, issue-sync) | 5 retries (exp backoff 1→2→4→8→16s) | **halt** |
| Lint fix-loop (Phase 10.2.b) | 3 retries | log + continue, mark issue `executed-with-open-findings` |
| Typecheck fix-loop (Phase 10.2.c) | 3 retries | log + continue, mark issue `executed-with-open-findings` |
| Test fix-loop (Phase 10.2.d) | 3 retries | log + continue, mark issue `executed-with-test-failures` |
| Diff-review fix-loop (Phase 10.2.e iterations) | 3 iterations | log + continue, mark issue `executed-with-open-findings` |
| Worktree create | 3 retries | **halt** |

**Halt-eligible phases**: any that hit cap go through the halt protocol below.

**Continue-eligible phases**: lint/typecheck/test/diff-review fix-loops within an issue. Cap hit → log + continue (per the user's mantra: "cost of stalling > cost of wrong guess").

## Halt protocol

When a halt-eligible phase exhausts its retry budget:

1. **Update `state.json`**:
   - `phase = "halted"`
   - `halted_at_phase = "<phase-name>"`
   - `halt_reason = "<short-msg>"`
2. **Append `progress.md`**:
   ```markdown
   ## <ts> — HALTED at <phase>
   Reason: <halt_reason>
   Last action: <description>
   Last error: <error or "no error captured">
   Resume: /yolo-afk-dev resume <run-id>
   ```
3. **Append `human-review-needed.md`**:
   ```markdown
   ## RUN HALTED — <ts>
   Phase: <phase>
   Reason: <halt_reason>
   Resume: /yolo-afk-dev resume <run-id>
   State dir: <repo>/.claude/state/yolo-afk-dev/<run-id>/
   ```
4. **PushNotification**: "<run-id> halted at <phase>. Reason: <reason>. Resume: /yolo-afk-dev resume <run-id>"
5. **Omit `ScheduleWakeup`** → /loop ends.

## Continue protocol (lint/typecheck/test/review caps)

When a continue-eligible fix-loop exhausts its retry budget:

1. **Append `progress.md`**:
   ```markdown
   ## <ts> — issue <id> (<phase>) — fix-loop cap hit
   Type: <lint|typecheck|test|diff-review>
   Findings logged to human-review-needed.md.
   Marking issue: <executed-with-open-findings|executed-with-test-failures>.
   Continuing.
   ```
2. **Append `human-review-needed.md`** under the appropriate "Issue open findings" or "Test failures" section
3. Update `state.prds[i].issues[j].phase` to the appropriate `executed-with-*` value
4. Continue to next phase / next issue / next PRD

## Concurrent-edit detection

At every PHASE BOUNDARY (not every wake — wakes only happen during
Phase 10.2.a polling now), and additionally on every poll-cycle entry
in Phase 10.2.a:

1. Run `git -C <worktree-path> status --short` (or main repo if not in a worktree phase)
2. Diff against the expected state captured in `state.prds[i].issues[j].commit_shas`
3. Unexpected changes → **halt** with reason "concurrent edit detected, refusing to clobber human work"

This protects against the user manually editing the repo overnight while
the skill is running. Clone-scoped: sibling yolo-afk-dev runs in other
repo clones don't appear in this clone's `git status` and therefore don't
trigger false halts.

## Watchdog (dead-man check)

Long inline phases (grill, codex review, decompose) might silently hang
on a stuck codex CLI or network blip. The watchdog catches this without
flooding the phone with per-turn pushes:

1. Track `state.last_progress_touch` (updated after every `progress.md` write).
2. In any long-running inline loop (grill, review iteration, test fix-loop), check `now() - last_progress_touch` after each iteration.
3. If `> 30 min`, fire a `PushNotification`: `[<run-id>] WATCHDOG · <phase> · no progress.md write in 30+ min, possible hang`
4. Continue the loop — watchdog is informational, not a halt trigger. The user can manually kill the process if the warning indicates a real hang.

## State corruption

If `state.json` fails to parse on wake:

1. Do NOT attempt repair. Risk of silently clobbering history.
2. **halt** with reason "state.json corruption; manual recovery required"
3. Log original parse error to `progress.md` under a `## STATE-CORRUPTION` heading
4. PushNotification with explicit "manual intervention needed" wording

## Judgment is never a halt (the panic fix)

The orchestrator NEVER halts — or asks the human — over a judgment call: scope, lane, tool-fit, "this seems disproportionate," or product ambiguity. Those route to **Codex consensus** (`references/scope-discovery.md`) and proceed. Load-bearing unknowns are logged to `human-review-needed.md` (non-blocking) and flagged in the PR body. Halts are reserved for infra the agents cannot resolve (below). If you find yourself reaching for `AskUserQuestion` or a halt because something "feels too small / too big / ambiguous," that is the bug this skill exists to prevent — get Codex up to speed and, on agreement, go forward.

## Repo-resolution failure (Phase 1 / scope-discovery)

The one legit front-door halt that is NOT a judgment call:

- **Target repo undecidable** — discovery can't confidently determine which repo the task targets (cwd doesn't match, no sibling clearly owns the named entities) → **halt** with reason "scope-discovery: undecidable target repo".
- **Target repo missing deps** — the resolved target lacks codex / gh / ccpm / git → **halt** with reason "scope-discovery: target repo missing <dep>".
- **Discoverable + deps present** → `cd` into it and proceed (log the re-root); never halt.

These are infra/undecidability, not judgment — halting is correct because the agents genuinely cannot proceed safely.

## Specific failure-mode playbook

### Codex CLI hangs (no output for >5 minutes during a turn)
- Treat as failure (timeout)
- Apply normal retry budget for Codex grill turn (1 retry)
- If retry also hangs → halt
- Phase 10.2.e diff review is bounded by `timeout 600`; inspect the
  per-issue `codex-review-iter-<N>.log`, `codex-review-iter-<N>-prompt.md`,
  and `codex-review-iter-<N>-status.txt` artifacts before retrying manually.

### Codex returns malformed grill output (no sentinel after cap, garbage doc)
- After hitting 100-question cap, send forcing prompt
- If still no `<<<GRILL-COMPLETE>>>` → halt with reason "codex grill failed to terminate after cap + forcing prompt"
- If sentinel present but doc missing required sections → send corrective prompt once. Still missing → halt.

### `gh` CLI auth failure mid-run
- Counts toward `gh` retry budget (5)
- Log "gh auth status" output to progress.md for diagnosis
- After cap → halt with reason "gh auth lost mid-run; re-auth required"

### `gh` rate limit hit
- Exponential backoff up to 5 retries (1→2→4→8→16s)
- If backoff window exceeds 30s, also `sleep 60` and check `gh api rate_limit` once before final retry
- After cap → halt

### CCPM agent crashes mid-issue
- ccpm's epic-start orchestrator handles agent crashes internally (it's designed for parallel agent execution)
- yolo-afk-dev only intervenes if the orchestrator itself crashes
- Orchestrator crash → halt with reason "ccpm epic-start orchestrator crashed"

### Worktree corrupt (`.git/worktrees/<id>` unreadable)
- Try `git worktree prune` once
- Recreate worktree
- Counts toward worktree-create retry budget (3)
- After cap → halt

### Test runner hangs
- Apply 5-minute hard timeout to test runs
- Timeout = retry signal
- Counts toward test-fix retry budget (3)

### Disk full
- All `Write`/`Edit` operations will fail
- Halt immediately with reason "disk full; free space and resume"
- Don't attempt to clean up state files (might corrupt them)

### CCPM `context-update` fails during recycle
- Recycle requires a fresh `.claude/context/*.md` snapshot before the wake-up. If `context-update` errors, the post-wake fresh session would prime against stale context → unsafe to auto-continue.
- **Halt-loud** with reason "ccpm context-update failed at recycle". Do NOT call `ScheduleWakeup`. Set `phase = "halted"`, `halted_at_phase = <N>`, populate `halt_reason` with the underlying error.
- User resumes manually after fixing the context-update issue.

### `ScheduleWakeup` unavailable during recycle (kicked off without `/loop`)
- `ScheduleWakeup` only fires inside `/loop` dynamic mode. If `state.config.mode == "recycle"` but the run was kicked off as `/yolo-afk-dev --recycle ...` without `/loop`, the first recycle attempt errors.
- **Halt-loud** with reason "ScheduleWakeup unavailable; --recycle requires /loop". User restarts as `/loop /yolo-afk-dev resume <run-id>`.

### Wake-up fires but `state.json` is malformed (recycle resume)
- On resume, if `phase == "recycle"` but `next_phase` is null/missing, treat as malformed state.
- **Halt-loud** with reason "recycle resume: malformed state (next_phase missing)". Manual recovery required — operator inspects state dir and either edits `next_phase` to the correct value or deletes the run.

### `gh pr create` fails (Phase 10.2.f)
- Apply the same 5x exponential-backoff retry budget as `gh issue create`.
- After cap → halt with reason "gh pr create cap exhausted on issue <id>".
- All retries continue to use `--draft`; never escalate to non-draft PRs.

## Resume semantics

`/yolo-afk-dev resume` (no run-id):
1. List all `<repo>/.claude/state/yolo-afk-dev/*/state.json` files
2. Filter to runs that are resumable: `phase == "halted"` OR `phase == "recycle"` OR (`phase ∉ {"done", "halted", "recycle"}` AND `now() - last_wake_at >= 30 min`, i.e. the run crashed)
3. Sort by `last_wake_at` descending
4. Resume the most recent

`/yolo-afk-dev resume <run-id>`:
1. Read `<repo>/.claude/state/yolo-afk-dev/<run-id>/state.json`
2. If not found → halt with reason "run-id not found"
3. Apply the resume contract from `state-schema.md`:
   - `phase == "halted"` → normal halted resume
   - `phase == "recycle"` → auto-context-recycle resume (run CCPM `context-prime`, advance to `next_phase`)
   - `phase ∉ {"halted", "recycle"}` AND fresh (<30 min `last_wake_at`) → halt with reason "run appears active; refusing to disturb"
   - `phase ∉ {"halted", "recycle"}` AND stale (≥30 min `last_wake_at`) → crash-resume from current `phase` (and from current `codex_session_id` + `grill_turn_count` if mid-grill or mid-review)
4. Otherwise resume per state-schema.md "Resume contract"

After resume:
- Most phases run inline immediately (no `ScheduleWakeup` needed). Only re-arm `/loop` if resuming into Phase 10.2.a polling.
- Continue normal phase work

## What NOT to do on failure

- **Do not skip phases.** A skipped phase produces orphaned state worse than a halt.
- **Do not auto-repair `state.json`.** Risk of silent data loss.
- **Do not retry indefinitely.** Caps exist to prevent runaway loops.
- **Do not bypass the anti-revert guard.** Test failures that resist fixing are a signal — log them and continue.
- **Do not push a PR or merge.** Even at terminal success, the skill stops at "code committed on epic branch."
