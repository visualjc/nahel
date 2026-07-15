# Pipeline — lane-adaptive phases

State machine. Each phase reads `state.json`, does its work, writes `state.json` + appends `progress.md`, then either advances or halts.

**Front door, all lanes:** `init` → `scope-discovery`. The `scope-discovery` phase (Phase 2 below) verifies scope via independent Claude+Codex discovery and picks a **lane** (Direct / Epic-lite / Full). The lane decides which phases run next:

- **Direct** → `direct-plan` → `direct-implement` → `direct-review` → `direct-pr` (see "Lane execution paths"). Skips `classify`, PRD, epic, GitHub-issue fan-out.
- **Epic-lite** → `epiclite-plan` → single epic branch → execute → Codex review → `epic-close` (see "Lane execution paths"). Skips issue fan-out + parallel worktrees.
- **Full** → `classify` → the classic Phases 3–12 below.

The numbered Phases 3–12 below are the **Full lane**. Direct and Epic-lite reuse their building blocks (test baseline, Codex diff review, anti-revert guard, draft-PR creation) but in a condensed sequence — documented in "Lane execution paths" at the end of this file.

**Execution model**: phases run INLINE in one Claude session, back-to-back, with no `ScheduleWakeup` between them. The single exception is Full-lane Phase 10.2.a (background CCPM agents), which uses `/loop` polling. Direct and Epic-lite are fully inline. See `SKILL.md` → "Execution model".

**Codex priming**: every `codex exec` prompt the orchestrator builds in Phases 3 (initial turn only), 5, 7, and 10.2.e contains a `{{CCPM_CONTEXT_PRIMING}}` placeholder. Substitute it at prompt-build time per SKILL.md → "Codex priming". Resume turns inside a single grill session do NOT re-prime (same session). All other review phases spawn fresh codex sessions and DO re-prime.

**Domain glossary priming**: the Phase 3 initial grill prompt also carries a `{{DOMAIN_GLOSSARY}}` placeholder (REPO CONTEXT block). Substitute it at prompt-build time per SKILL.md → "Domain glossary priming" — a compact `CONTEXT.md`/`CONTEXT-MAP.md`/ADR digest when those exist, else empty string. Like the priming block it rides only the initial turn (the session retains it across resumes).

**Auto-context-recycle**: when `state.config.mode == "recycle"`, the heavy-phase boundaries (3, 5, 7, 9, per-issue 10.2.f) interpose a `recycle` phase that runs CCPM `context-update`, queues `ScheduleWakeup(60s)`, and ends the turn. The wake-up resumes in fresh context, runs CCPM `context-prime`, and advances to `next_phase`. See `references/context-recycle.md` for the full 12-step protocol.

## State file paths

```
<repo>/.claude/state/yolo-afk-dev/<run-id>/
  state.json              # machine-readable truth (see references/state-schema.md)
  progress.md             # human-readable narrative log
  human-review-needed.md  # load-bearing assumptions and unresolved findings
  input-tasks.md          # original bullets, verbatim
  prds/
    <prd-name>/
      grill-transcript.md       # full Codex Q&A
      grill-context.md          # Codex's final context doc
      ccpm-prd.md               # symlink to <repo>/.claude/prds/<prd-name>.md
      epic-status.json          # per-issue status during epic-start
      issues/
        <issue-id>/
          execute-log.md
          test-baseline.json
          test-current.json
          codex-review-iter-1.md
          codex-review-iter-2.md
          codex-review-iter-3.md
```

## Phases

### Phase 1: `init`

**Goal**: bootstrap the run.

1. Parse `--recycle` flag from input args. If present → `MODE=recycle`; else `MODE=inline`.
2. Parse `--per-issue-prs` flag from input args. If present → `PR_TOPOLOGY=per-issue`; else `PR_TOPOLOGY=per-epic` (the default). Per-issue topology is OPT-IN for the rare case where each issue is an independent shippable unit (Graphite stacked review, etc.). Default `per-epic` opens ONE draft PR for the whole feature at Phase 11.
3. Sniff input mode (path vs inline). If path, read file; if inline, take args verbatim.
4. Generate `run_id` = `date -u +"%Y%m%dT%H%M%SZ"`
5. Run `scripts/init-run.sh <run-id> <inline|path> <content-or-path> <mode> <pr_topology>` — creates state dir, writes `input-tasks.md`, scans the user's project memory for `reference_gh_repo_split*.md` and a `pr_topology` override (memory key `yolo_afk_dev_pr_topology` overrides the flag default), populates `state.config.{mode, parallel_cap, gh_issue_repo, gh_pr_repo, pr_topology}` (defaulting `gh_issue_repo` and `gh_pr_repo` to `"origin"` when no memory is found, and `pr_topology` to `"per-epic"`), initializes `state.json` and `progress.md`
6. Run dependency checks per SKILL.md startup checklist
7. Set `state.phase = "classify"`, advance

**Repo-split memory format** (optional, per-project; not parsed strictly — the script greps for the literal lines):

```
---
name: gh repo split for yolo-afk-dev
description: Repo routing for autonomous issue/PR fan-out
type: reference
---
- Issues: <owner>/<repo>
- PRs: <owner>/<repo>
```

If no such memory is present in `~/.claude/projects/<encoded-repo-path>/memory/`, both repos default to `"origin"`. Never halt for missing repo config.

### Phase 2: `scope-discovery` (all lanes — the front-door gate)

**Goal**: produce a *verified* scope estimate and pick the ceremony lane. Full spec + schema + reconcile algorithm: `references/scope-discovery.md`. Read it before running this phase.

1. **Claude discovers** (Step A). Run the rich toolkit on the resolved repo: `claude-mem` search → `understand-chat`/`understand-explain` (staleness-checked) → grep `CONTEXT.md`/`CONTEXT-MAP.md` + `docs/adr/*.md` → git archaeology (`git log`/`show`, `git show <sha>^:<file>` for "before" states on reverts). Write the scope-estimate to `<state>/scope/claude-scope.json`.
2. **Codex discovers independently** (Step B). Build the prompt from `references/codex-review-prompts.md` → "Template 0: scope estimate" (resolve `{{CCPM_CONTEXT_PRIMING}}` + `{{DOMAIN_GLOSSARY}}`), passing the **raw task only — NOT Claude's estimate**. Run `scripts/codex-scope.sh <state-dir>`. On codex failure, apply the Sonnet fallback (SKILL.md → "Sonnet fallback"); if that also fails, treat scope as unverified and ratchet to the higher candidate lane — do NOT halt.
3. **Reconcile** (Step C). Compare file-set overlap + `size_class` + `proposed_lane`.
   - Agree → set `state.lane`, `state.scope.consensus = "agreed"`, proceed.
   - Diverge → run ONE bounded second round (`scripts/codex-scope.sh <state-dir> 2`, prompt now includes Claude's estimate + contested deltas; Claude re-discovers the contested area too). Re-reconcile. Resolved → `consensus = "second-round-resolved"`. Still straddling → **ratchet to the higher lane**, `consensus = "ratcheted"`. Never a third round, never a human stop.
4. **Product ambiguity**: for each `ambiguities[]` entry both agents surface, apply the tie-break (`references/scope-discovery.md` → "Product-ambiguity tie-break"): agree → take it; split → default to the stated goal. Log every resolution to `human-review-needed.md` AND carry it into the PR body. Record in `state.scope.ambiguities_resolved[]`.
5. Write `state.lane`, `state.target_repo`, `state.scope{}` (per state-schema.md). Append `progress.md`: "Scope verified (<consensus>); lane = <lane>; N files; M ambiguities resolved." PushNotification the lane decision.
6. **Branch on lane:**
   - `direct` → set `state.phase = "direct-plan"` (see "Lane execution paths").
   - `epic-lite` → set `state.phase = "epiclite-plan"` (see "Lane execution paths").
   - `full` → set `state.phase = "classify"`, advance to Phase 3.

### Phase 2.5: `classify` (Full lane only)

**Goal**: split task bullets into 1-or-N PRDs. Reached only when `scope-discovery` chose the Full lane (multiple independent / parallelizable workstreams). Direct and Epic-lite skip this. (Kept at 2.5 so the downstream Full-lane phase numbers — grill=3, prd-review=5, epic-review=7, epic-sync=9, referenced by the recycle boundaries — are unchanged.)

1. Read `input-tasks.md`
2. LLM pre-pass (no Codex call yet): "Are these bullets one tightly-scoped feature, or independent items? Output JSON array of `{name, bullets[]}`."
   - Tightly-scoped multi-bullet feature → 1 PRD, all bullets in `bullets[]`
   - Grab-bag → N PRDs, one per logical grouping
   - Heuristic: if all bullets touch the same component/area or share a single user-facing goal, cluster as one PRD
3. Write `state.prds[]` array with each PRD: `{name, bullets, phase: "pending", codex_session_id: null, grill_turn_count: 0, issues: []}`
4. Append `progress.md`: "Classified into N PRDs: [names]"
5. Set `state.phase = "grill"`, `state.current_prd_index = 0`, advance

### Phase 3: `grill` (per PRD)

**Goal**: get a high-quality context doc out of Codex via grill loop.

**Loop semantics**: this phase is an INLINE loop. NO `ScheduleWakeup`
between turns. `codex exec resume` blocks until codex returns (~30–90s
typical), then immediately compose the next answer and call again. State
is persisted per turn so a Claude session crash mid-grill can resume
from the same `codex_session_id` and `grill_turn_count`.

```
loop:
    run scripts/codex-grill-turn.sh resume
    parse turn-NNN.md (strip GRILL RULES echo)
    if <<<GRILL-COMPLETE>>> in turn output:
        validate context-doc sections, save to grill-context.md
        break
    else:
        increment state.prds[i].grill_turn_count
        write state.json, write progress.md (per-turn entry)
        if grill_turn_count >= 100:
            send forcing prompt
        else:
            classify question (KNOWN / ASSUMPTION / DEFERRED-DECISION)
            if DEFERRED-DECISION load-bearing:
                append entry to human-review-needed.md
            form resume prompt with answer
    # NO ScheduleWakeup here — loop back immediately
```

Per the current PRD (`state.prds[state.current_prd_index]`):

1. **First turn**: build initial prompt from `references/codex-grill-prompt.md` template. Substitute task bullets verbatim.
   - Run `scripts/codex-grill-turn.sh <prd-name> initial`
   - Script invokes: `codex exec "<full-prompt>" -o <state>/prds/<prd-name>/turn-001.md --json 2>&1 | tee <state>/prds/<prd-name>/codex-stderr.log`
   - Parse session id from JSON output (look for `"id"` field on first event), save to `state.prds[i].codex_session_id`
2. **Read last message** from `turn-001.md`. Strip GRILL RULES echo if Codex echoed them. Extract Codex's question.
3. **Answer as stakeholder**:
   - **Domain research first (mirror of the human's second-CLI dance).** Before answering a question that is about how a flow/component works or what a domain term means, ground yourself:
     - If `CONTEXT.md` / `CONTEXT-MAP.md` exist, read the glossary that owns the area (use `CONTEXT-MAP.md` to pick the bounded context) plus any relevant `docs/adr/`. Answer in the project's ubiquitous language.
     - If `.understand-anything/` exists, run `/understand-chat` framed as: *"determine how this flow/component works and pick the best answer to: <grill question + any options Codex offered>"*, then answer with that grounding (`/understand-explain <path>` for a specific file). **Staleness check**: compare `.understand-anything/meta.json` `gitCommitHash` to current HEAD; if they differ, treat graph answers as approximate and prefer code/`CONTEXT.md` (hand-maintained, always trusted) where they conflict.
     - If neither artifact exists, skip this sub-step silently and answer as before.
   - Classify question: KNOWN / ASSUMPTION / DEFERRED-DECISION
   - KNOWN: answer from the domain research above, session memory, repo state (read code if needed), CLAUDE.md, or memory files
   - ASSUMPTION: answer your best guess, prefix with `[ASSUMPTION]`
   - DEFERRED-DECISION: answer your best guess, prefix with `[DEFERRED-DECISION]`. If load-bearing (financial/contract/security/data-integrity for just-flip; analogous high-stakes for other repos), append entry to `human-review-needed.md` with question + your guess + reasoning.
4. **Resume turn**: build resume prompt with answer, call `scripts/codex-grill-turn.sh <prd-name> resume`
   - Script invokes: `codex exec resume <session-id> "<resume-prompt>" -o <state>/prds/<prd-name>/turn-NNN.md`
5. **Termination check** after every turn:
   - Grep last-message for `<<<GRILL-COMPLETE>>>`
   - If found: extract context doc (everything after the sentinel), save to `<state>/prds/<prd-name>/grill-context.md`. Advance to Phase 4.
   - If not found: increment `state.prds[i].grill_turn_count`. If count >= 100, send forcing prompt: "Cap reached. Emit `<<<GRILL-COMPLETE>>>` followed by context doc with current understanding; mark unresolved areas in open questions section." Then expect termination on next turn.
6. **Failure handling**:
   - Codex CLI exit non-zero: retry once. Two failures → halt with reason "codex grill turn failed twice; session likely broken"
   - No question detected in last-message after parsing: retry once with prompt "Please ask your next question or emit `<<<GRILL-COMPLETE>>>`."
7. **Concatenate transcripts**: each turn's `turn-NNN.md` appended into `grill-transcript.md` for the audit trail.

When `grill-context.md` is written, advance: set `state.prds[i].phase = "prd"`.

**Recycle hook (Phase 3 boundary)**: if `state.config.mode == "recycle"`, run the recycle protocol per `references/context-recycle.md` with `next_phase = "prd-new"`. Otherwise, set `state.phase = "prd-new"` and continue inline.

### Phase 4: `prd-new` (per PRD)

**Goal**: turn the context doc into a CCPM PRD.

1. Read `<repo>/.claude/skills/ccpm/references/plan.md`
2. Map `grill-context.md` sections to CCPM PRD template:
   - context-doc `problem` → PRD problem statement
   - context-doc `users` → PRD personas / target users
   - context-doc `scope` → PRD scope section
   - context-doc `constraints` → PRD constraints / non-functional requirements
   - context-doc `success criteria` → PRD success metrics / acceptance criteria
   - context-doc `non-goals` → PRD explicit non-goals
   - context-doc `open questions` → PRD "Open Questions" section (rendered verbatim — these are the assumption trail)
3. Write PRD to `<repo>/.claude/prds/<prd-name>.md` with frontmatter `status: draft`, `created: <ISO>`, `last_updated: <ISO>`
4. Append `progress.md`: "PRD draft written for <prd-name>"
5. Set `state.phase = "prd-review"`, advance

### Phase 5: `prd-review` (per PRD)

**Goal**: Codex reviews the PRD; one revise pass max.

1. Run `scripts/codex-review-prd.sh <prd-name>`
   - Uses template from `references/codex-review-prompts.md`
2. Parse Codex output into structured findings: `[{severity: blocker|nit, location, problem, fix}]`
3. Write findings to `<state>/prds/<prd-name>/prd-review.md`
4. Patch:
   - Each blocker: edit PRD to address (you do the editing, Codex doesn't)
   - Each nit: append to `human-review-needed.md` under "PRD nits — <prd-name>"
5. Mark PRD frontmatter `status: in-progress`
6. Trigger CCPM context update (follow `<repo>/.claude/skills/ccpm/references/context.md`)
7. **Recycle hook (Phase 5 boundary)**: if `state.config.mode == "recycle"`, run the recycle protocol per `references/context-recycle.md` with `next_phase = "prd-parse"`. Otherwise, set `state.phase = "prd-parse"` and continue inline.

### Phase 6: `prd-parse` (per PRD)

**Goal**: PRD → epic doc.

1. Read `<repo>/.claude/skills/ccpm/references/structure.md` (Phase 1 of CCPM structure)
2. Generate epic doc at `<repo>/.claude/epics/<prd-name>/epic.md` with frontmatter `status: draft`
3. Append `progress.md`: "Epic draft written for <prd-name>"
4. Set `state.phase = "epic-review"`, advance

### Phase 7: `epic-review` (per PRD)

**Goal**: Codex reviews epic decomposition; one revise pass max.

1. Run `scripts/codex-review-epic.sh <prd-name>` with template from `references/codex-review-prompts.md`
2. Parse findings (same blocker/nit shape as Phase 5)
3. Patch blockers in epic doc; log nits to `human-review-needed.md`
4. Mark epic frontmatter `status: in-progress`
5. CCPM context update
6. **Recycle hook (Phase 7 boundary)**: if `state.config.mode == "recycle"`, run the recycle protocol per `references/context-recycle.md` with `next_phase = "epic-decompose"`. Otherwise, set `state.phase = "epic-decompose"` and continue inline.

### Phase 8: `epic-decompose` (per PRD)

**Goal**: epic → numbered task files.

1. Read `<repo>/.claude/skills/ccpm/references/structure.md` (Phase 2)
2. Generate `<repo>/.claude/epics/<prd-name>/001-<slug>.md`, `002-<slug>.md`, etc., each with frontmatter (status, dependencies, parallel-group)
3. Update epic body to reference the task files
4. Append `progress.md`: "Decomposed epic into N tasks"
5. Set `state.phase = "epic-sync"`, advance

### Phase 9: `epic-sync` (per PRD)

**Goal**: push epic + tasks to GitHub as issues.

1. Read `<repo>/.claude/skills/ccpm/references/sync.md`
2. Create GitHub issues via `gh issue create -R <state.config.gh_issue_repo>`. Repo routing comes from Phase 1 memory lookup (defaults to `"origin"` when no `reference_gh_repo_split*.md` memory is present).
3. **Pre-authorized fan-out**: do NOT halt for "visible to others" caution. Kickoff is blanket authorization. The only halt-eligible reason for `gh` ops is the 5x retry budget exhaustion below.
4. Capture issue numbers, update task frontmatter with `github_issue: <num>` (per `feedback_ccpm_epic_sync_renumbering.md` — task refs in epic body get updated to real issue numbers, not sequential 001/002)
5. Update epic body with issue numbers
6. Retry budget: 5 retries with exponential backoff (1s → 2s → 4s → 8s → 16s) on `gh` failures
7. Append `progress.md`: "Synced epic + N issues to GitHub (`-R <gh_issue_repo>`)"
8. Populate `state.prds[i].issues[]` with `[{id: <gh-issue-num>, phase: "pending", ...}]`
9. **Recycle hook (Phase 9 boundary)**: if `state.config.mode == "recycle"`, run the recycle protocol per `references/context-recycle.md` with `next_phase = "epic-start"` and persist `current_issue_id = <first issue id>` BEFORE entering recycle (so the post-wake fresh session has the right cursor). Otherwise, set `state.phase = "epic-start"`, `state.current_issue_id` = first issue id, advance.

### Phase 10: `epic-start` (per PRD) — the big phase

**Goal**: implement each issue with parallel agents, lint, typecheck, test, code-review, fix-loop.

#### 10.1: test-baseline (once per PRD, before any issue starts)

1. Run `scripts/test-baseline.sh <prd-name>` — checks out PRD's base branch (`team/main` or `main`), runs lint + typecheck + tests, captures all failures into `<state>/prds/<prd-name>/test-baseline.json`
2. Cache. All subsequent issue test runs diff against this baseline.

#### 10.2: per-issue execution (CCPM parallelizes via worktrees)

For each issue (CCPM spawns parallel agents per issue, each in its own worktree under `.git/worktrees/<issue-id>/`):

##### 10.2.a: execute (THE ONLY ASYNC PHASE)

This phase is the ONE place `ScheduleWakeup` is allowed. Background-agent
polling pattern:

1. Read `<repo>/.claude/skills/ccpm/references/execute.md`
2. **Cap-aware spawn loop**:
   ```
   while issues with phase != terminal:
       executing = count(state.prds[i].issues[].phase == "executing")
       cap = state.config.parallel_cap   # default 2
       slots = max(0, cap - executing)
       ready = issues with phase == "pending" and deps satisfied
       for issue in ready[:slots]:
           Agent(
               subagent_type: "parallel-worker",
               prompt: "<issue task file + analysis + stream files>",
               run_in_background: true
           )
           mark issue phase = "executing"
           write state.json, progress.md
           PushNotification: "<run-id> · 10.2.a · issue #N spawned (bg)"
       poll completed background agents (BashOutput / Agent result delivery)
       for each completed:
           parse Agent result, capture commit SHAs to state.prds[i].issues[j].commit_shas
           mark issue phase = "executed"  # ready for 10.2.b
           run 10.2.b–f INLINE for that issue (lint → typecheck → tests → review → sync)
           write state.json, progress.md
           PushNotification per milestone
       if any background agent still running:
           ScheduleWakeup(prompt: "/loop /yolo-afk-dev resume <run-id>",
                          delaySeconds: 300,
                          reason: "polling N background CCPM agents")
           return  # /loop fires next wake; loop body re-runs
   ```
3. Each spawned agent:
   - Reads its task file from `<repo>/.claude/epics/<prd-name>/<NNN>-<slug>.md`
   - Implements in its worktree
   - Commits its diff to the worktree branch
   - Returns when done (Claude harness notifies orchestrator on background completion)
4. Cap rationale: `parallel_cap = 2` keeps API rate-limit and CPU thermal
   pressure manageable even with 2–3 concurrent yolo-afk-dev processes
   running across other clones.
5. **Once all issues advance past 10.2.f, exit polling loop, advance to Phase 11.**

##### 10.2.b: lint

1. Detect package manager from `package.json` / `pnpm-lock.yaml` / `yarn.lock`. For pnpm monorepos, use `pnpm --filter <relevant-pkg> lint` per `feedback_pnpm_filter_first.md`
2. Run lint on the issue's worktree. Red → spawn fix-agent in same worktree with prompt: "Lint failed. Fix the lint errors. Do NOT silence rules; fix the underlying code."
3. Retry budget: 3. Cap hit → halt with reason "lint cap exhausted on issue <id>"

##### 10.2.c: typecheck

1. Run typecheck on the issue's worktree. Same retry/halt rule as lint.

##### 10.2.d: tests with anti-revert guard

1. Run tests on the issue's worktree
2. Diff against `test-baseline.json`:
   - Failures present in baseline → "pre-existing", logged but NOT a fail-the-issue signal
   - Failures NOT in baseline → "net-new", trigger fix-loop
3. **Anti-revert fix-agent prompt** (CRITICAL): "Tests failed: [list]. Tests validate the new feature behavior introduced in this issue. Do NOT revert or weaken feature code to make tests pass. If a test asserts old behavior that no longer applies, update the test assertion to match the new behavior. If you cannot make a test pass without reverting feature code, STOP and report the conflict."
4. Retry budget: 3. After cap, log net-new failures to BOTH `human-review-needed.md` AND `progress.md`, mark issue `phase: "executed-with-test-failures"`. Continue to 10.2.e.
5. Pre-existing failures (baseline intersection) also logged to BOTH files for visibility.

##### 10.2.e: codex diff review

1. Run `scripts/codex-review-diff.sh <prd-name> <issue-id> <iter>` per `references/codex-review-prompts.md`
2. Codex reviews the issue's diff. Output: structured findings.
3. **Anti-revert flag** (CRITICAL): Codex review prompt explicitly demands: "Flag any test edit that loosens an assertion, removes a test case, or changes input to match the regressed output rather than asserting the new feature behavior."
4. Blockers → spawn fix-agent in worktree, re-run 10.2.b through 10.2.e
5. Iteration cap: 3 review-fix iterations per issue. Cap hit → log open findings to `human-review-needed.md`, mark issue `phase: "executed-with-open-findings"`. Continue to 10.2.f.
6. Nits → log to `human-review-needed.md`, do NOT trigger fix-loop

##### 10.2.f: issue-sync (no PR creation here)

1. Read `<repo>/.claude/skills/ccpm/references/sync.md` (issue progress comments)
2. Post progress comment to GitHub issue with: commit SHA(s), test summary, codex review summary, open findings (if any). Use `gh issue comment <num> -R <state.config.gh_issue_repo> --body "..."`.
3. **Merge the issue branch into the epic branch** (`epic/<prd-name>`):
   ```
   git checkout epic/<prd-name>
   git merge --no-ff <issue-branch> -m "merge(eng-XXX): <task-title> (#<issue-num>)"
   git push <state.config.gh_pr_repo> epic/<prd-name>
   ```
   Use `--no-ff` so each issue is a reviewable merge commit on the epic branch. Per-issue commits stay traceable via the merge history. Halt-on-conflict: rebase/merge conflicts go to `human-review-needed.md` with the issue id; the orchestrator does NOT auto-resolve cross-issue conflicts.
4. Per-issue PR opt-in (rare): if `state.config.pr_topology == "per-issue"`, ALSO open a draft PR from the issue branch → epic branch using the body template in Phase 11 § PR body template (substitute "epic-level PR" → "per-issue PR" and adjust the checklist). Skip merging into the epic branch in step 3 when opt-in is active — Phase 11 reuses the merge instead.
5. Update issue frontmatter: `status: completed` OR `executed-with-open-findings` OR `executed-with-test-failures`
6. CCPM context update
7. **Recycle hook (per-issue 10.2.f boundary)**: if `state.config.mode == "recycle"`, run the recycle protocol per `references/context-recycle.md` with `next_phase = "epic-start"` (the polling loop in 10.2.a re-enters and picks up the next issue). Otherwise, move to next issue or, if all issues done, advance to Phase 11.

### Phase 11: `epic-close` (per PRD) — ONE draft PR for the whole epic

**Goal**: finalize the PRD's epic AND open the single reviewable artifact.

1. All issues in `state.prds[i].issues` reached a terminal phase (completed / executed-with-* / halted).
2. Verify `epic/<prd-name>` head has every completed issue's merge commit (concurrent-edit check).
3. **Create ONE DRAFT PR** for the epic branch on `state.config.gh_pr_repo` (per-epic topology, the default):
   ```
   gh pr create -R <state.config.gh_pr_repo> --draft \
     --base main --head epic/<prd-name> \
     --title "<prd-title> (<run-id-short>)" \
     --body "<rendered body, see template below>"
   ```
   Skip this step if `state.config.pr_topology == "per-issue"` (PRs were opened per-issue in Phase 10.2.f). PR creation is subject to the 5x exponential-backoff retry budget; halt-on-cap.
4. **PR body template** (per-epic; NEVER includes `#N` or cross-repo `<owner>/<repo>` issue links — task titles only when issue repo and PR repo differ):

   ```markdown
   ## Summary

   <auto-generated summary from PRD executive summary + epic diff>

   ## Tasks in this epic

   - [x] <task-1 title> — commit <sha>
   - [x] <task-2 title> — commit <sha>
   - [ ] <task-N title> — executed-with-open-findings (see human-review-needed.md)

   ## Auto-generated by yolo-afk-dev

   This PR was created by the `/yolo-afk-dev` autonomous skill without
   human intervention. Code generated by Claude Code agents, reviewed by
   Codex (3-iteration diff review per task with anti-revert guard), lint /
   typecheck / tests run automatically.

   - Run id: `<run_id>`
   - PRD: `<prd_name>`
   - Topology: per-epic (one PR for the whole feature; manual testing uses this single branch / single Vercel preview)

   ## Test plan

   - [x] Lint clean across all merged tasks
   - [x] Typecheck clean across all merged tasks
   - [x] Tests pass on the merged epic branch (no anti-revert detected by Codex)
   - [ ] Human review before marking ready
   - [ ] Manual end-to-end verification on the Vercel preview

   ## Acceptance

   This PR is in DRAFT. Human must:
   1. Review the epic diff (each task is a `--no-ff` merge commit for traceability)
   2. Verify acceptance criteria from the PRD
   3. Mark ready for review when satisfied
   ```

5. Skill NEVER marks the PR ready (`gh pr ready`); that is a human action.
6. Update epic frontmatter: `status: completed`.
7. Final CCPM context update.
8. Append `progress.md`: "Epic closed for <prd-name>. ONE draft PR opened (`gh pr view <num>`). N tasks merged, M with open findings, K halted."
9. If more PRDs: increment `state.current_prd_index`, set `state.phase = "grill"`, return to Phase 3.
10. If no more PRDs: set `state.phase = "done"`, advance to Phase 12.

### Phase 12: terminal

**Goal**: end the loop cleanly.

1. Final state.json: `phase: "done"` (success) OR `phase: "halted"` (any halt-eligible cap was hit earlier)
2. PushNotification with summary:
   - Success: "<run-id> done. <N> PRDs / <M> issues. <K> findings in human-review-needed.md. State: <state-dir>"
   - Halt: "<run-id> halted at <phase>. Reason: <halt_reason>. Resume: /yolo-afk-dev resume <run-id>. State: <state-dir>"
3. Omit `ScheduleWakeup` → `/loop` ends

---

## Lane execution paths

`scope-discovery` (Phase 2) routes to one of three lanes. Full is Phases 2.5–12 above. Direct and Epic-lite are condensed paths that reuse the same building blocks — test baseline (10.1), Codex diff review + anti-revert guard (10.2.d/e), Sonnet review fallback, draft-PR creation (Phase 11) — without the PRD/epic/issue bookkeeping. **The invariant holds: independent dual-discovery already happened in Phase 2, and Codex review + adversarial verify run before the PR in every lane.**

All Direct/Epic-lite phases are INLINE (no `ScheduleWakeup`; no background-agent polling). Concurrent-edit + state-write rules are identical to the Full lane.

### Direct lane (XS/S — one focused change)

For a small, bounded, reversible change (the "revert the logos, restore colors" class). One branch, one draft PR, no worktrees.

**`direct-plan`**
1. Write a short plan to `<state>/direct/plan.md` from the verified scope: the exact files to change, the approach, the kept-vs-changed split, and any `ambiguities_resolved` (with the chosen default + reasoning).
2. Create the working branch off the PRD base (`<short-task-slug>`); record it in `state`.
3. Capture a test baseline (reuse `scripts/test-baseline.sh` semantics) so the diff review can diff net-new vs pre-existing failures.
4. Set `state.phase = "direct-implement"`.

**`direct-implement`**
1. Implement the change inline (Edit/Write directly, or a single `Agent` for a larger-but-still-single-workstream change — no parallel worktrees).
2. Run lint → typecheck → tests on the branch. Fix-loops use the SAME anti-revert prompt and 3-retry/continue rules as Full-lane 10.2.b–d.
3. Commit. Record commit SHAs in `state`.
4. Set `state.phase = "direct-review"`.

**`direct-review`**
1. Codex diff review via `scripts/codex-review-diff.sh` (Template 3, anti-revert guard mandatory). Sonnet fallback on codex failure.
2. Blockers → fix inline, re-review. Iteration cap 3 → log remaining to `human-review-needed.md`, continue. Nits → log, don't block.
3. **Adversarial verify** (the invariant): the diff review IS the adversarial pass; if `confidence` from scope was `low` or `reversibility` was `med/low`, run one extra independent skeptic pass (a second `codex-review-diff` framed "try to find what's wrong / what this breaks").
4. Set `state.phase = "direct-pr"`.

**`direct-pr`**
1. Push the branch; open ONE draft PR (`gh pr create --draft`) per Phase 11's body template, condensed. The PR body MUST surface every `ambiguities_resolved` entry ("chose X over Y because …; flip in review") and any cross-repo deps.
2. Never mark ready. Set `state.phase = "done"`, advance to Phase 12.

### Epic-lite lane (M — a few components, no parallel fan-out)

For a medium change touching several components but not worth a GitHub-issue swarm. Single epic branch, sequential component work, no per-issue issues.

**`epiclite-plan`**
1. Write a plan doc to `<state>/epiclite/plan.md`: component breakdown (ordered, not parallelized), approach per component, acceptance checks, `ambiguities_resolved`.
2. **Codex plan review** — reuse `scripts/codex-review-prd.sh` semantics against `plan.md` (Template 1 framing, "is this plan sound / complete / correctly scoped"). Blockers → revise plan once. Sonnet fallback applies.
3. Create `epic/<task-slug>` branch off base; capture test baseline.
4. Set `state.phase = "epiclite-execute"`.

**`epiclite-execute`** (per component, sequential)
1. Implement each component inline or via a single `Agent` per component, committing onto the epic branch in order (deps respected).
2. After each component: lint → typecheck → tests (anti-revert fix-loops, same caps).
3. Codex diff review of that component's commit(s) (Template 3, anti-revert). Blockers → fix + re-review (cap 3). Sonnet fallback.
4. When all components are done, set `state.phase = "epic-close"`.

**`epic-close`** — reuse Full-lane Phase 11 (ONE draft PR for `epic/<task-slug>`), with the PR body surfacing `ambiguities_resolved` + cross-repo deps. Then Phase 12.
