# State schema

`state.json` is the machine-readable truth. `progress.md` is the human-readable narrative. Both update on every phase transition.

## state.json schema

```json
{
  "$schema_version": "1.3",
  "run_id": "20260507T221500Z",
  "started_at": "2026-05-07T22:15:00Z",
  "last_wake_at": "2026-05-07T22:18:42Z",
  "last_progress_touch": "2026-05-07T22:38:42Z",
  "repo_root": "/Users/jimcarter/projects/.../just-flip",
  "target_repo": "/Users/jimcarter/projects/.../just-flip",
  "input_source": "inline|path",
  "input_path": null,

  "config": {
    "parallel_cap": 2,
    "mode": "inline|recycle",
    "gh_issue_repo": "origin",
    "gh_pr_repo": "origin"
  },

  "lane": "direct|epic-lite|full",
  "scope": {
    "consensus": "agreed|second-round-resolved|ratcheted",
    "size_class": "XS|S|M|L",
    "files": ["path/a.tsx", "path/b.ts"],
    "ambiguities_resolved": [
      { "question": "...", "chosen": "...", "reasoning": "...", "logged": true }
    ],
    "cross_repo_deps": [],
    "claude_estimate_path": "scope/claude-scope.json",
    "codex_estimate_path": "scope/codex-scope.md"
  },

  "phase": "init|scope-discovery|classify|grill|prd-new|prd-review|prd-revise|prd-parse|epic-review|epic-revise|epic-decompose|epic-sync|epic-start|issue-execute|issue-test|issue-review|issue-sync|epic-close|direct-plan|direct-implement|direct-review|direct-pr|epiclite-plan|epiclite-execute|recycle|done|halted",
  "halted_at_phase": null,
  "halt_reason": null,
  "next_phase": null,

  "current_prd_index": 0,
  "current_issue_id": null,
  "current_review_iter": 0,

  "prds": [
    {
      "name": "kebab-case-prd-name",
      "bullets": ["original bullet text..."],
      "phase": "pending|grilling|prd|epic|executing|done|halted",
      "codex_session_id": null,
      "grill_turn_count": 0,
      "test_baseline_failures": [],
      "issues": [
        {
          "id": 209,
          "task_file": ".claude/epics/<prd-name>/001-fix-x.md",
          "phase": "pending|executing|linted|typechecked|tested|reviewed|completed|executed-with-open-findings|executed-with-test-failures|halted",
          "worktree_path": ".git/worktrees/issue-209",
          "branch_name": "epic/<prd-name>/issue-209",
          "review_iter": 0,
          "open_findings": [],
          "test_failures_net_new": [],
          "test_failures_baseline_intersection": [],
          "commit_shas": []
        }
      ]
    }
  ],

  "retries": {
    "codex_scope": 0,
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
```

## Write rules

1. **Atomic per field**: prefer `Edit` tool on individual JSON fields rather than rewriting the whole file. Race-safer if a wake gets killed mid-write.
2. **Write before action**: phase transition is "set new phase, then start that phase's work." Writing after means a crash mid-phase looks like the previous phase succeeded.
3. **Update `last_wake_at` first thing on every wake** (proves the loop is alive). Wakes happen during Phase 10.2.a polling and during recycle resume; for inline phases this field stays at the value set when the last wake released back to inline.
4. **Update `last_progress_touch` after every `progress.md` write.** The watchdog dead-man check uses this. If `now() - last_progress_touch > 30 min`, push a "still running?" notification and continue.
5. **Per-turn write during inline loops**: Phase 3 (grill) and Phase 5/7/10.2.e (codex review) write `state.json` + `progress.md` AFTER EVERY codex turn, not just at phase boundaries. Resume granularity is the turn, not the phase.
6. **Never delete fields**, only set to `null` if no longer applicable. Schema migrations get a new `$schema_version`.
7. **`retries` resets per-phase on entry**: when a phase starts, set its retry counter to 0. Don't carry retries across phase boundaries.
8. **`{{CCPM_CONTEXT_PRIMING}}` is NOT persisted.** It's resolved from repo state (`.claude/context/*.md` presence) on every prompt build, just before each `codex exec` invocation. See SKILL.md → "Codex priming".
9. **`phase: "recycle"` semantics**: when entering recycle, write all of `phase = "recycle"`, `halted_at_phase = <N>`, `halt_reason = "auto-recycle: phase <N> complete"`, `next_phase = <N+1>` BEFORE calling `ScheduleWakeup`. On resume from recycle, clear `halted_at_phase`, `halt_reason`, `next_phase` (set to null) and set `phase = <N+1>` BEFORE starting that phase's work.
10. **`config.mode`**: set at Phase 1 by `init-run.sh` from the `--recycle` flag. Generally treat as immutable for the run. Exception: mid-flight upgrade `inline → recycle` is allowed when the orchestrator detects context bloat at a heavy boundary AND `/loop` is active. The upgrade MUST follow SKILL.md → "Mid-flight mode upgrades" (set mode + write `phase=recycle` + `ScheduleWakeup` atomically; never `phase=halted` in the same turn — that creates the trap documented in `context-recycle.md` § Trap). Downgrade `recycle → inline` is NOT supported.
11. **`config.gh_issue_repo` / `config.gh_pr_repo`**: set once at Phase 1 by `init-run.sh` from a project-memory lookup, defaulting to `"origin"` for both when no memory is found. Never mutated thereafter.
12. **`lane` / `scope` / `target_repo`**: written ONCE by the `scope-discovery` phase (Phase 2), then immutable for the run. `lane` is null until scope-discovery resolves it. `target_repo` = the resolved working repo (equals `repo_root`; may differ from the original cwd when repo resolution re-rooted). `scope.ambiguities_resolved[]` is the audit trail of product-ambiguity tie-breaks — every entry MUST also appear in `human-review-needed.md` and the PR body (`logged: true`).

## progress.md format

Append-only. One section per phase entry:

```markdown
## 2026-05-07T22:15:00Z — phase: init
Started run 20260507T221500Z. Input: inline. 5 task bullets captured.

## 2026-05-07T22:15:08Z — phase: classify
Classified bullets into 1 PRD: landing-sports-leftnav-polish (5 bullets clustered as one tightly-scoped feature).

## 2026-05-07T22:15:12Z — phase: grill (PRD: landing-sports-leftnav-polish)
Started codex grill session. Session id: 1a2b3c4d-...

## 2026-05-07T22:38:42Z — turn 12 (PRD: landing-sports-leftnav-polish)
Q: Should the favorites section render an empty-state CTA?
A: [DEFERRED-DECISION] No empty-state CTA — section unmounts. Logged to human-review-needed.md.

## 2026-05-07T22:55:01Z — phase: prd-new (PRD: landing-sports-leftnav-polish)
Grill complete after 38 turns. Context doc written. PRD draft written to .claude/prds/landing-sports-leftnav-polish.md.
```

Format conventions:
- ISO 8601 UTC timestamps
- "phase: <name>" header for phase transitions
- Per-turn entries during grill (just turn count + summarized Q/A, not full text)
- Halt entries get a clear `## <ts> — HALTED at <phase>` heading
- Resume entries get a `## <ts> — RESUMED from <phase>` heading

## human-review-needed.md format

Sections per category:

```markdown
# Human review needed — run 20260507T221500Z

## Deferred decisions (load-bearing)

### PRD landing-sports-leftnav-polish — turn 12
**Q**: Should the favorites section render an empty-state CTA?
**A (Claude's guess)**: No empty-state CTA — section unmounts.
**Reasoning**: Existing `feedback_pnpm_filter_first.md` precedent shows team prefers minimal UI surface for opt-in features. CTA might be discoverable elsewhere.
**Reviewer action**: Confirm or override; if override, fix is to add CTA to `SidebarFavoritesSection.tsx`.

## PRD nits

### landing-sports-leftnav-polish
- [NIT] Success criteria #3 says "users like it" — replace with measurable metric (e.g. session-length delta, click-through rate).

## Epic nits

(none)

## Issue open findings

### Issue #209 (after 3 review iterations)
- [BLOCKER] `useEventCardHandlers.ts:42` — race condition between `isBettable` read and click handler. Fix attempted: debounce; reverted by codex (introduced regression in test #14). Recommend: use `useEvent` from React 19 once available.

## Test failures

### Issue #209 — net-new failures (after 3 fix iterations)
- `EventCard.test.tsx > renders LIVE badge correctly` — assertion still fails. Fix-agent attempts:
  1. Updated assertion to match new behavior (test now expects `data-state="live"` instead of class). Test failed differently.
  2. Updated mock data to provide `match.isBettable: true`. Test failed differently.
  3. Updated render setup to include providers. Test failed differently.
  Manual investigation needed.

### Issue #211 — pre-existing failures (baseline)
- `Betslip.test.tsx > closes drawer on backdrop click` — fails on main too. Pre-existing.
```

## Resume contract

On resume:
1. Read `state.json`. Apply forward-compatible field backfill before any other check:
   - If `$schema_version` is missing or older than current (`1.3`): backfill missing fields with safe defaults rather than halting. Specifically:
     - `last_progress_touch` missing → set to `started_at` (best available proxy).
     - `config` missing → set to `{ "parallel_cap": 2, "mode": "inline", "gh_issue_repo": "origin", "gh_pr_repo": "origin" }`.
     - `config.parallel_cap` missing → set to `2`.
     - `config.mode` missing → set to `"inline"` (resumed runs default to inline; `--recycle` only takes effect on fresh kickoff).
     - `config.gh_issue_repo` missing → set to `"origin"`.
     - `config.gh_pr_repo` missing → set to `"origin"`.
     - `next_phase` missing → set to `null`.
     - `target_repo` missing → set to `repo_root` (pre-1.3 runs never re-rooted).
     - `lane` missing → set to `"full"` (pre-1.3 runs predate lanes; they always ran the full pipeline, so resuming as Full is correct).
     - `scope` missing → set to `null` (a pre-1.3 run already passed the front door; no scope object to reconstruct).
     - `retries.codex_scope` missing → set to `0`.
   - After backfill, bump `$schema_version` to the current value and persist.
   - Only halt with reason "schema mismatch; run too old" if `$schema_version` is NEWER than the current spec — that direction can't be safely backfilled.
2. Read `phase` and `halted_at_phase`:
   - If `phase == "halted"`: normal halted-resume. Continue at step 3.
   - If `phase == "recycle"`: auto-context-recycle resume. Continue at step 3.
   - If `phase ∉ {"halted", "recycle"}` AND `now() - last_wake_at < 30 min`: halt with reason "run appears active; refusing to disturb. Wait or kill the running process before resuming."
   - If `phase ∉ {"halted", "recycle"}` AND `now() - last_wake_at >= 30 min`: assume the run crashed (Claude session died, machine slept, etc.). Treat the current `phase` as the resume point. Continue at step 3.
3. Load `current_prd_index` and `current_issue_id` to know where to pick up.
4. For Phase 3 (grill) crash-resume: also load `state.prds[i].codex_session_id` and `state.prds[i].grill_turn_count` — the grill loop continues from the next turn against the existing codex session. Same applies to mid-review crashes (Phase 5/7/10.2.e) — those reuse their codex session ids.
5. Reset the retry counter for the resume-target phase.
6. **Recycle resume**: if `phase == "recycle"`:
   - Re-read `references/pipeline.md` for `next_phase` only (just-in-time, cheap).
   - Run CCPM `context-prime` to load `.claude/context/*.md` into the new session.
   - Set `phase = next_phase`, `halted_at_phase = null`, `halt_reason = null`, `next_phase = null`. Persist.
   - Append `## <ts> — RESUMED from recycle (entering <next_phase>)` to progress.md.
   - Begin `next_phase` work.
7. **Halted/crash resume**: if `phase == "halted"` or crash-resume:
   - **Trap-recovery check FIRST**: if `halt_reason` references `"needs --recycle"` / `"mode upgraded"` / `"cross-session"` / `"mode upgrade requires /loop"` AND `config.mode == "recycle"` AND `/loop` is active → promote to recycle resume. Set `phase = "recycle"`, `next_phase = halted_at_phase`, `halt_reason = "trap recovery: promoted halted→recycle"`. Persist. Then jump to step 6 (recycle resume) and continue. See `references/context-recycle.md` § Trap.
   - Otherwise: set `halted_at_phase = null`, `halt_reason = null` (if previously set).
   - Append `## <ts> — RESUMED from <phase>` to progress.md.
   - Continue normal phase work at the resume target.
