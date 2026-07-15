# Auto-context-recycle protocol

When `state.config.mode == "recycle"`, the skill interposes a `recycle` phase at every heavy-phase boundary to reset Claude's working context without losing run progress. This document defines the protocol, failure modes, and resume contract.

## When recycle is active

- Set ONCE at Phase 1 from the `--recycle` kickoff flag. `init-run.sh` writes `state.config.mode = "recycle"`.
- `mode` is immutable for the run — never mutated thereafter.
- Resumed runs default to `mode = "inline"` if `mode` is missing in the state file (forward-compatible backfill per `references/state-schema.md` § Resume contract). To re-enable recycle on a resumed run, the operator must edit `state.config.mode` directly.

## Recycle boundaries (when `mode == "recycle"`)

End of every heavy phase:

| Boundary | After completing | Next phase |
|---|---|---|
| 3 → 4 | grill saturates; `grill-context.md` written | `prd-new` |
| 5 → 6 | PRD review patches PRD on disk | `prd-parse` |
| 7 → 8 | epic review patches epic on disk | `epic-decompose` |
| 9 → 10 | epic-sync creates GitHub issues | `epic-start` (with `current_issue_id` cursor preserved) |
| each 10.2.f → 10.2.a | per-issue PR draft + sync | `epic-start` (re-enters polling loop) |

Cheap phases (1, 2, 4, 6, 8, 11) do NOT trigger recycle on their own — they get absorbed into the recycle that follows the next heavy phase.

## 12-step recycle protocol at a boundary

```
1. Heavy phase work completes. All artifacts on disk (PRD, epic, tasks, PR, etc.).
2. Concurrent-edit check (existing skill rule, see references/failure-recovery.md).
3. Run CCPM `context-update` to refresh `.claude/context/*.md` from current repo state.
   - On failure → halt-loud (see Failure modes below). Do NOT proceed to step 4.
4. Update state.json (atomic per-field, write before action):
     phase            = "recycle"
     halted_at_phase  = <N>
     halt_reason      = "auto-recycle: phase <N> complete"
     next_phase       = <N+1>
   Persist current_prd_index, current_issue_id, current_review_iter as-is.
5. Append progress.md:
     ## <ts> — RECYCLED at phase <N> → <N+1>
6. Call ScheduleWakeup(delaySeconds: 60, prompt: "/yolo-afk-dev resume <run-id>",
                       reason: "auto-context-recycle at phase <N> boundary").
   - On failure (skill not under /loop) → halt-loud (see Failure modes).
7. End the turn. NO further tool calls.

— runtime fires wake-up in fresh-ish context —

8. Resume entry: read state.json, see phase == "recycle", halted_at_phase = <N>,
   next_phase = <N+1>.
9. Re-read references/pipeline.md FOR THE next_phase ONLY (just-in-time; cheap).
   Do NOT re-read all references; on-demand read only what the upcoming phase needs.
10. Run CCPM `context-prime` to load .claude/context/*.md into the new session.
11. Update state.json (atomic per-field):
      phase            = next_phase
      halted_at_phase  = null
      halt_reason      = null
      next_phase       = null
12. Append progress.md:
      ## <ts> — RESUMED from recycle (entering <next_phase>)
    Begin <next_phase> work.
```

## State writes during recycle

Steps 4 and 11 are the two atomic state writes. Treat the field-bag in step 4 as one "transaction" — all four fields update together. Same for step 11.

`last_wake_at` updates first thing on the wake-up (step 8) per the existing rule in `references/state-schema.md` § Write rules.

## Failure modes

### CCPM `context-update` fails (step 3)
- Recycle requires a fresh `.claude/context/*.md` snapshot before the wake-up. If `context-update` errors, the post-wake fresh session would prime against stale context → unsafe to auto-continue.
- **Halt-loud**: write `phase = "halted"`, `halted_at_phase = <N>`, `halt_reason = "ccpm context-update failed at recycle"` plus the underlying error. Do NOT call `ScheduleWakeup`.
- User resumes manually after fixing the context-update issue (typically by debugging the CCPM skill or by manually running `context-update`).

### `ScheduleWakeup` unavailable (step 6, kicked off without `/loop`)
- `ScheduleWakeup` only fires inside `/loop` dynamic mode. If the run was kicked off as `/yolo-afk-dev --recycle ...` without `/loop`, the call errors at the first recycle attempt.
- **Halt-loud**: write `phase = "halted"`, `halted_at_phase = <N>`, `halt_reason = "ScheduleWakeup unavailable; --recycle requires /loop"`.
- User restarts as `/loop /yolo-afk-dev resume <run-id>`. The recycle then succeeds because `/loop` is now active.

### Trap: `phase == "halted"` with `halt_reason ~= "needs --recycle"` but `mode == "recycle"`
- Pattern: a previous session attempted a mid-flight inline→recycle mode upgrade but wrote `phase = "halted"` instead of running the recycle protocol's `ScheduleWakeup` path. Most common when the previous session ran without `/loop`. Result: `/loop` resumes hit `phase: halted`, jump to `halted_at_phase`, immediately re-encounter the same heavy boundary, and re-trigger the same defensive halt — infinite halt loop, AFK contract broken.
- **Resume-time recovery**: if `/loop` is active, promote to recycle resume:
  - `phase = "recycle"`, `next_phase = halted_at_phase`, `halt_reason` updated to `"trap recovery: promoted halted→recycle"`
  - Run CCPM `context-prime` per the standard recycle resume (steps 8–12 of the 12-step protocol).
  - Append `## <ts> — TRAP RECOVERY: promoted halted→recycle, mode was already recycle` to `progress.md`.
  - Advance to `next_phase` work.
- **Prevention**: never write `phase = "halted"` in the same turn that flips `config.mode` from inline to recycle. The mid-flight upgrade MUST go through `ScheduleWakeup` per SKILL.md → "Mid-flight mode upgrades". If `/loop` isn't active, halt with the `"mode upgrade requires /loop"` reason and DO NOT flip mode yet — let the user restart under `/loop`, then perform the upgrade in a `/loop`-active turn.

### Wake fires but state is malformed (step 8)
- If `phase == "recycle"` but `next_phase` is null/missing, treat as malformed.
- **Halt-loud**: write `phase = "halted"`, `halt_reason = "recycle resume: malformed state (next_phase missing)"`.
- Manual recovery required — operator inspects state dir and either edits `next_phase` to the correct value or deletes the run.

### Wake never fires (silent failure)
- ScheduleWakeup is core runtime; assume reliable. If a wake silently never fires (e.g. user kills `/loop` mid-recycle), the state file remains in `phase: "recycle"` indefinitely.
- Recovery: `/yolo-afk-dev resume <run-id>` — `resume.sh` accepts `phase ∈ {"halted", "recycle"}`, so a manual resume drives the same wake-up code path.

## Resume contract (recycle vs halted)

`resume.sh` returns success for both `phase == "halted"` and `phase == "recycle"`. The orchestrator dispatches based on phase:

- `halted` → normal halted resume (jump to `halted_at_phase`, continue work).
- `recycle` → recycle resume (steps 8-12 of the protocol above).

Both code paths pass through the standard resume entry: concurrent-edit check, retry-counter reset for the resume target, RESUMED entry in `progress.md`. The recycle path additionally runs CCPM `context-prime`.

## Cost / benefit

- **Cost per recycle**: ~60s wake delay + one `context-update` write + one `context-prime` read. Marginal. Tokens spent on `context-update` and `context-prime` are bounded by `.claude/context/*.md` size, typically a few KB.
- **Benefit per recycle**: drops grill turns, codex review prompts, and per-phase reasoning out of working memory. Phases run on cleaner context, with measurably better model performance on long runs.
- Cheap phases (1, 2, 4, 6, 8, 11) do not trigger their own recycle — the surrounding heavy phases absorb them. Net recycles per PRD: ~4 + N issues.

## What recycle does NOT do

- Does NOT preserve in-conversation chat history. Anything not on disk is lost.
- Does NOT re-do work. The next phase resumes from on-disk artifacts (PRD, epic, task files, branches, PRs).
- Does NOT compact the codex session. Codex sessions are per-PRD and per-review-call; codex state lives outside Claude's context.
- Does NOT change retry budgets. Retry counters reset on phase entry per the existing rule.
