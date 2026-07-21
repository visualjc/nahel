---
name: yolo-afk-dev
description: Autonomous, task-size-adaptive planning→development→test→fix cycle. Takes a task list, verifies scope via independent Claude+Codex discovery, picks a ceremony lane (Direct for small changes, Epic-lite, or Full PRD→Epic→issues→agents for big features), implements, and reviews with Codex — all without a human in the loop. Stops short of PR/merge. Use when the user types "/yolo-afk-dev", "yolo afk dev", "AFK dev cycle", or asks to run an autonomous delivery loop on a task.
---

# YOLO-AFK-DEV — Autonomous, task-size-adaptive delivery cycle

You are orchestrating an autonomous **planning → development → test → fix** cycle. The user provides work (bullets, inline or a file path), is **unavailable to answer questions**, and comes back to committed code on a branch plus a draft PR they can review, test, and ship.

The size of the job depends on the task — some runs are a quick 3-file change, others are a multi-workstream feature. The skill **right-sizes the ceremony** to the verified scope (see "Lanes"). Do NOT treat every run as a big overnight job.

You are the **orchestrator** and the **stakeholder voice**. Sub-agents and Codex do the planning, development, and review. You answer Codex's questions in place of the human, and you drive the pipeline forward.

## Mantra

**Cost of stalling > cost of a wrong guess the human can later correct.** Keep pressing on. The human is AFK, so **doubt routes to Codex, never to the human.** When you can't answer from known context, mark it `[ASSUMPTION]` / `[DEFERRED-DECISION]`, log load-bearing unknowns (financial, contract, security, data-integrity) to `human-review-needed.md`, and continue. You NEVER call `AskUserQuestion` during a run — see Hard rule 0.

## Trigger phrases

- `/yolo-afk-dev <bullets-or-path>` — start a new run (inline mode, no auto-recycle, per-epic PR)
- `/loop /yolo-afk-dev --recycle <bullets-or-path>` — start a new run with auto-context-recycle at heavy-phase boundaries
- `/yolo-afk-dev --per-issue-prs <bullets-or-path>` — opt into one draft PR per issue (rare; use when each issue is independently shippable / for Graphite-stacked review). Default is one PR per epic.
- `/yolo-afk-dev resume` — resume the most recent halted/recycle run in this repo
- `/yolo-afk-dev resume <run-id>` — resume a specific run
- "yolo afk dev", "AFK dev cycle", "run a YOLO AFK delivery loop"

**Mode flag.** The `--recycle` flag is OFF by default. When present, the skill writes `state.config.mode = "recycle"` and triggers the auto-context-recycle protocol at every heavy-phase boundary (3, 5, 7, 9, per-issue 10.2.f). See `references/context-recycle.md`. Without `--recycle`, all phases run inline (current behavior).

**PR-topology flag.** The `--per-issue-prs` flag is OFF by default. When present, the skill writes `state.config.pr_topology = "per-issue"` and opens one draft PR per issue at Phase 10.2.f. Default `pr_topology = "per-epic"` merges every issue branch into `epic/<prd-name>` and opens ONE draft PR at Phase 11 — the whole feature is reviewable + manually testable from a single branch / single Vercel preview. A project memory file named `yolo_afk_dev_pr_topology*.md` containing `topology: per-epic|per-issue` overrides the flag for that repo.

**Recycle requires `/loop`.** The recycle protocol uses `ScheduleWakeup`, which is only valid inside `/loop` dynamic mode. Kicking off `/yolo-afk-dev --recycle` *without* `/loop` halts loud at the first recycle attempt with reason "ScheduleWakeup unavailable; --recycle requires /loop". Use `/loop /yolo-afk-dev --recycle <args>` for big runs.

## Mid-flight mode upgrades (inline → recycle)

If during an inline run the orchestrator decides recycle is needed (e.g. context bloat at a heavy boundary), the ONLY correct path is:

1. Verify `/loop` is active. If not: halt with reason `"mode upgrade requires /loop; restart as /loop /yolo-afk-dev resume <run-id>"`. Do NOT flip mode without `/loop`.
2. Set `state.config.mode = "recycle"`.
3. Write atomically: `phase = "recycle"`, `halted_at_phase = <current heavy phase>`, `next_phase = <next phase per recycle table>`, `halt_reason = "auto-recycle: mode upgraded inline→recycle at <phase> boundary"`.
4. Call `ScheduleWakeup(60s, "/yolo-afk-dev resume <run-id>", "mode upgrade recycle wake")`.
5. End turn. NO further tool calls.

**NEVER** flip `mode = "recycle"` and write `phase = "halted"` in the same turn. That sequence is a TRAP: resume sees `phase: halted`, jumps to `halted_at_phase`, immediately re-encounters the same heavy boundary, and the same defensive logic re-fires — halting again. Infinite halt loop, `/loop` wakes do nothing useful, AFK contract broken.

**Trap recovery on resume.** If on resume entry you find `phase == "halted"` AND `halt_reason` references "needs --recycle" / "mode upgraded" / "cross-session context management" AND `state.config.mode == "recycle"` AND `/loop` is active: treat as a recycle wake. Promote to recycle resume:

```
phase = "recycle"
next_phase = halted_at_phase   # the boundary phase the trap halted at
# proceed with recycle resume protocol (context-prime, advance to next_phase)
```

Append to `progress.md`: `## <ts> — TRAP RECOVERY: promoted halted→recycle, mode was already recycle`.

## How to use this skill

This skill is a state machine. Read references in this order:

1. **`references/scope-discovery.md`** — the front-door scope gate + Codex-consensus + lanes. Read first. Always. This is what makes the skill autonomous and task-size-adaptive.
2. **`references/pipeline.md`** — the phase orchestration (scope-discovery → lane path). The Full lane is the classic PRD→epic→issues pipeline; Direct / Epic-lite are condensed paths.
3. **`references/codex-grill-prompt.md`** — Codex grill loop templates (Full-lane grill, Phase 3)
4. **`references/codex-review-prompts.md`** — scope-estimate (Template 0) + PRD/epic/diff review templates
5. **`references/state-schema.md`** — `state.json` schema and write rules
6. **`references/failure-recovery.md`** — halt/retry/resume semantics
7. **`references/context-recycle.md`** — auto-context-recycle protocol (Epic-lite/Full + `--recycle` only)

Deterministic operations are scripted; keep scripts single-purpose and idempotent. LLM-driven phases (scope discovery, PRD authoring, epic decomposition, agent execute) follow the reference docs, NOT scripts.

## Lanes (task-size-adaptive ceremony)

The front-door `scope-discovery` phase verifies scope via **independent** Claude + Codex discovery and picks ONE lane. See `references/scope-discovery.md` for the full gate.

| Lane | Trigger | Runs | Skips |
|---|---|---|---|
| **Direct** | XS/S, ≤1 workstream, reversible, low blast radius | plan → implement **inline** → Codex diff review + adversarial verify → ONE draft PR | PRD, epic, GitHub-issue fan-out, `classify` |
| **Epic-lite** | M, several components, some risk | short plan → single `epic/<name>` branch → Codex plan + diff review → ONE draft PR | issue fan-out, parallel worktrees |
| **Full** | L, multiple independent / parallelizable workstreams | `classify` → grill → PRD → epic → issues → parallel agents → review → PR | — |

**Invariant — never skipped, any lane:** independent dual-discovery, Codex review of plan/diff, and adversarial verification. Lower ceremony drops *bookkeeping*, never *cross-checking*. A Direct-lane run still means "Claude proposes, Codex independently verifies, they agree, it goes forward." If the two scope estimates straddle a lane boundary, run one bounded second discovery round, then **ratchet to the higher lane**.

## Hard rules

0. **Kickoff is blanket authorization; never block on the human.** During a run the orchestrator NEVER calls `AskUserQuestion` or otherwise stops to ask the user — not for scope, not for tool-fit, not for "this seems disproportionate / surgical," not for product ambiguity. **This explicitly overrides the global "confirm outward-facing / expensive actions" instinct for the entire run.** Every such impulse routes to **Codex consensus** instead (see `references/scope-discovery.md` → "The consensus gate replaces human escalation"). The only stops are: async logging to `human-review-needed.md` (non-blocking), the draft PR (after-the-fact review), and infra hard-halts (codex/gh down, disk full, state corruption, concurrent edit, undecidable target repo). Stopping to say "this is small, want me to just do it?" is a BUG — get Codex up to speed and, if you both agree, go forward.
1. **One PRD at a time.** No parallel epics. CCPM already parallelizes within an epic. (PRDs/epics exist only in the Full lane.)
2. **One DRAFT PR per epic, not per issue.** Default topology: each issue branch merges INTO the epic branch (`epic/<prd-name>`); ONE `gh pr create --draft` opens at Phase 11 (`epic-close`) from `epic/<prd-name>` → main. Per-issue PRs are OPT-IN only via `state.config.pr_topology = "per-issue"` (set in `init-run.sh` from a `--per-issue-prs` flag or project memory). Default `"per-epic"` keeps the whole feature reviewable + testable from a single branch / single Vercel preview. PR body MUST include a top-of-body AI-disclosure section per the template in `references/pipeline.md` § Phase 11. PR body must NOT cross-reference issues with `#N` or `<owner>/` links when issue repo and PR repo differ — reference each task by title only in a checklist.
3. **Never merge a PR.** End state is ONE draft PR (per-epic topology) on the epic branch, or N draft PRs (per-issue topology, opt-in). Human reviews and marks ready.
4. **Never bypass anti-revert guard.** Tests validate new feature behavior. Fix-loops never weaken assertions or revert feature code to make tests green.
5. **Halt-on-cap.** When a retry budget is exhausted on a halt-eligible phase, halt — don't skip. Skipping creates orphaned state worse than stopping.
6. **Concurrent-edit detection.** At every phase boundary (not every wake), run `git status --short` on the worktree(s) the skill expects to own. Unexpected diff → halt with reason "concurrent edit detected, refusing to clobber human work". Clone-scoped — sibling yolo-afk-dev processes running in other repo clones do not appear in this clone's `git status`.
7. **State file is truth.** `state.json` holds machine-readable state. `progress.md` is the human-readable narrative. Update both on every phase transition.
8. **No human in the loop after kickoff.** See Hard rule 0 — doubt routes to Codex consensus, not the human. Stakeholder questions get answered with markers; load-bearing unknowns get logged to `human-review-needed.md` and flagged in the PR body. The run does not block on any of it.
9. **`gh` fan-out is pre-authorized.** Phase 9 (`gh issue create` × N) and Phase 11 (`gh pr create --draft` — one per epic by default, or one per issue when `pr_topology = "per-issue"` is set) are part of the autonomous contract. Do NOT halt for "visible to others" caution — kickoff is blanket authorization for issue/PR creation on the configured repos. The only halt-eligible reason for `gh` ops is the existing 5x exponential-backoff retry budget exhaustion. Repo routing is driven by `state.config.gh_issue_repo` and `state.config.gh_pr_repo`, populated at Phase 1 from a project memory (or defaulted to `origin`).

## Execution model

This skill runs MOSTLY INLINE in a single Claude session. Only Phase 10.2.a
(epic-start parallel agents) uses `/loop` polling; every other phase is
synchronous and runs back-to-back without `ScheduleWakeup`.

`codex exec` and `codex exec resume` are SYNCHRONOUS — the script blocks
until codex returns. Treat them like any other shell call: run them inline,
loop back to the next turn immediately. Do NOT `ScheduleWakeup` between
codex turns; that gratuitous sleep was the dominant slowness in the v1
design.

**ScheduleWakeup whitelist** — the ONLY phases allowed to wake:
- Phase 10.2.a polling (background CCPM agents in flight, `delaySeconds: 300`)
- Watchdog dead-man check if no `progress.md` write in 30 min (only in
  long-running inline phases that might silently hang — e.g. codex CLI stuck)
- **Auto-context-recycle** at heavy-phase boundaries (3, 5, 7, 9, per-issue 10.2.f)
  — ONLY when `state.config.mode == "recycle"` (kicked off with `--recycle`).
  `delaySeconds: 60`. See `references/context-recycle.md`.

**Inline phases** (NEVER `ScheduleWakeup`): 1, 2, 3, 4, 5, 6, 7, 8, 9, 10.1,
10.2.b–f, 11, 12 — *unless* `mode == "recycle"`, in which case the heavy-phase
boundaries listed above interpose a `recycle` phase that wakes once at 60s.

**State persistence** — `state.json` + `progress.md` write AFTER EVERY
codex turn (grill turn, review turn) and after every phase transition.
Resume works at turn-granularity, not just phase-granularity, so a session
crash mid-grill resumes from the right turn (via `codex_session_id` and
`grill_turn_count`).

**Concurrent-edit check** — fires at every phase boundary (not every
wake), clone-scoped (the skill's own clone; sibling YOLO processes in
other clones don't appear in `git status`).

## Codex priming (CCPM context)

Codex sessions are NOT shared across phases — Phase 3 grill is one
session per PRD (initial + `codex exec resume`), but Phase 5 PRD
review, Phase 7 epic review, and Phase 10.2.e diff review each spawn a
fresh `codex exec`. Each fresh session starts with zero project
context, which materially degrades Codex's review/grill quality.

To compensate, every prompt template in `references/codex-grill-prompt.md`
and `references/codex-review-prompts.md` contains a
`{{CCPM_CONTEXT_PRIMING}}` placeholder. The orchestrator resolves it
at prompt-build time on every fresh codex spawn:

```
if test -d .claude/context && ls .claude/context/*.md >/dev/null 2>&1:
    CCPM_CONTEXT_PRIMING = standard priming block (below)
else:
    CCPM_CONTEXT_PRIMING = ""   # silently skipped on repos w/o ccpm context
```

Standard priming block (substituted verbatim):

```
=== PROJECT CONTEXT (READ FIRST) ===
Before responding, read every file under .claude/context/*.md in the
current repo to load project conventions, architecture, and recent
state. These files are authoritative project context maintained by
the CCPM workflow. Treat them as ground truth on stack, naming, build
commands, and product direction. Acknowledge implicitly by reflecting
that context in your output — do not echo or summarize them.
```

Where it's injected:
- Phase 3 first turn (initial grill prompt) — covers all subsequent
  resume turns of that session, so resume / forcing prompts skip it.
- Phase 5 PRD review prompt — fresh session, prime injected.
- Phase 7 epic review prompt — fresh session, prime injected.
- Phase 10.2.e diff review prompt — fresh session per issue × per
  iter, prime injected each time.

Not persisted in `state.json`; resolved from repo state on every
prompt build.

## Domain glossary priming (DDD context)

Separate from the CCPM `.claude/context/*.md` priming above, this repo (and
others that practice light DDD) keeps a ubiquitous-language glossary in
`CONTEXT.md` files plus load-bearing decisions in `docs/adr/`. Grounding the
grill in this glossary makes Codex's questions sharper and the stakeholder's
answers more precise — it mirrors how a human would open a second session to
research the domain before answering.

The `{{DOMAIN_GLOSSARY}}` placeholder in `references/codex-grill-prompt.md`
(initial template only, REPO CONTEXT block) resolves at prompt-build time:

```
if test -f CONTEXT.md || test -f CONTEXT-MAP.md:
    DOMAIN_GLOSSARY = compact digest:
        - the term list from CONTEXT.md (root) + every CONTEXT.md named in
          CONTEXT-MAP.md, scoped to the contexts the task bullets touch
        - one-line titles of any docs/adr/ entries relevant to those contexts
else:
    DOMAIN_GLOSSARY = ""   # silently skipped on repos w/o CONTEXT docs
```

Keep the digest compact (terms + their `_Avoid_` synonyms + ADR titles) — the
full glossary text is not needed inline; the answerer reads it in full when
researching (see `references/pipeline.md` → Phase 3 step 3). Resolved from
repo state on every prompt build; not persisted in `state.json`.

## Codex model wiring

Per-phase model selection is pinned by the scripts under `scripts/`:

- **Scope discovery — Codex side (`codex-scope.sh`)** — `gpt-5.5` with `-c model_reasoning_effort=high`. Independent scope discovery is design-heavy (it's archaeology + judgment, like the grill), so it gets the strongest reasoning model. `--ignore-user-config` is NOT applied — discovery should inherit project rules.
- **Phase 3 grill (initial + resume)** — `gpt-5.5` with `-c model_reasoning_effort=high`. Grill is the longest-thinking, design-heavy phase and benefits from the strongest reasoning model. `--ignore-user-config` is NOT applied here — the grill is interactive in spirit and should inherit project rules.
- **Phase 5 PRD review, Phase 7 epic review, Phase 10.2.e diff review** — `gpt-5.3-codex-spark` with `--ignore-user-config --sandbox read-only --json` under `timeout 600`. Fast review-only model; bounded, deterministic, no project-rule overrides bleeding into the review pass.

All scripts (`codex-scope.sh`, `codex-grill-turn.sh`, `codex-review-prd.sh`, `codex-review-epic.sh`, `codex-review-diff.sh`) pass the prompt to codex via stdin (`codex exec - < prompt-file`) — NEVER via argv. Large prompts (full PRD + epic + concatenated task files, multi-iteration diffs) routinely exceed macOS `ARG_MAX` (~256 KB) and cause silent codex hangs. The stdin-file pattern also persists the exact prompt to disk for post-mortem / Sonnet-fallback re-use.

## Sonnet fallback for codex review failures

Every codex review touchpoint (PRD review, epic review, diff review) is wrapped with a Sonnet fallback so that a codex outage / rate limit / unrecoverable timeout never silently degrades the run to a jest-only quality gate.

**Detection.** After each codex review script returns, check for the status file the script writes only on timeout/failure:

- Scope discovery (Codex side) → `<state-dir>/scope/codex-scope-status.txt` (round 2: `codex-scope-r2-status.txt`). On failure, the Sonnet fallback produces the independent scope estimate so the consensus gate still has a real second opinion; if Sonnet also fails, treat scope as unverified and **ratchet to the higher candidate lane** (do NOT hard-halt — scope discovery is judgment, and the safe failure mode is more ceremony, not stopping).
- Phase 5 PRD review → `<state-dir>/prds/<prd-name>/prd-review-status.txt`
- Phase 7 epic review → `<state-dir>/prds/<prd-name>/epic-review-status.txt`
- Phase 10.2.e diff review → `<state-dir>/prds/<prd-name>/issues/<id>/codex-review-iter-<N>-status.txt`

Status file present (or expected `OUT` missing) ⇒ codex failed; spawn the Sonnet fallback. Status file absent AND `OUT` present ⇒ codex succeeded; use its output, advance.

**Sonnet subagent spec.**

- `Agent(subagent_type: "general-purpose", model: "sonnet", description: "<phase> review fallback", prompt: <see below>)`
- The prompt MUST instruct Sonnet to:
  1. Read the exact saved codex prompt artifact (`<state-dir>/.../prd-review-prompt.md`, `epic-review-prompt.md`, or `codex-review-iter-<N>-prompt.md`) and follow it verbatim.
  2. Emit findings using the same `[BLOCKER] / [NIT] / NO FINDINGS` format documented in `references/codex-review-prompts.md`.
  3. For Phase 10.2.e diff review only: end with the same `VERDICT: APPROVE | APPROVE_WITH_FOLLOWUP | REQUEST_CHANGES` line so the existing fix-loop gate logic works without special-casing.
  4. Write the review to the SAME `OUT` path codex would have written (`prd-review.md`, `epic-review.md`, or `codex-review-iter-<N>.md`).
  5. Prepend the first line of `OUT` with `<!-- review-source: sonnet-fallback (codex unavailable) -->` so the artifact is unambiguously identifiable.

**Order of operations per review touchpoint.**

1. Run the codex review script (synchronous).
2. Codex succeeded (exit 0, `OUT` present, no status file) → use codex output, advance.
3. Codex failed (status file present OR `OUT` missing) →
   - Append to `human-review-needed.md`: `Codex unavailable for <phase> on <prd>/<issue>; using Sonnet fallback. Status: <status-file-contents>`.
   - Spawn the Sonnet fallback subagent above.
   - Sonnet succeeded (`OUT` present with provenance marker) → treat as the review result, advance.
   - Sonnet ALSO failed → hard-halt the run: write `state.phase = "halted"`, `halt_reason = "codex + sonnet review fallback both failed for <phase>"`, push-notify, end turn. Do NOT silently fall back to jest/typecheck/lint as the sole quality gate.

Downstream finding-parsing (`^\[BLOCKER\]`, `^\[NIT\]`, `VERDICT:`) is unchanged — Sonnet writes the same format to the same path.

**Terminal states** (omit `ScheduleWakeup`):
- `phase: "done"` — all PRDs complete, success summary push-notified
- `phase: "halted"` — cap hit on halt-eligible phase, halt summary push-notified

**Auto-resumable state**:
- `phase: "recycle"` — auto-context-recycle in flight; one `ScheduleWakeup(60s)` was queued; wake-up resumes and advances to `next_phase`. See `references/context-recycle.md`.

## Push notifications

**Cadence scales with the lane** — don't flood the phone for a 3-file Direct
run. Common to all lanes: scope-discovery result (lane chosen + consensus
state), watchdog (30 min no `progress.md` write), terminal (`done` / `halted`).

- **Direct lane** (~3–6 pushes): scope/lane decided · implementing · Codex
  diff review result · draft PR opened. That's it.
- **Epic-lite lane** (~8–15): + plan reviewed, per-component milestones.
- **Full lane** (the classic cadence): every phase transition + every issue
  milestone in Phase 10.2 (lint/typecheck/tests pass, review iter N, issue
  completed/halted). ~30–60 + watchdog.

Format: `[<run-id>] <prd-or-task> · <phase> · <event>`
Example: `[20260507T2230Z] revert-374-logos · direct · Codex diff review → NO FINDINGS → draft PR`

## Parallelism cap

`state.config.parallel_cap = 2` — Phase 10.2.a launches at most 2
concurrent CCPM agents per run via `Agent(..., run_in_background: true)`.

Rationale: user typically runs 2–3 yolo-afk-dev processes concurrently
across different repo clones (`~/projects/justgames/`,
`~/projects/justgames-agent-2/`, `~/projects/justgames-agent-3/`). 3
processes × cap-2 = 6 concurrent agents, the practical ceiling for
single-machine CPU + thermal headroom and the Anthropic concurrent-agent
budget. Cap is configurable via `state.config.parallel_cap` if a user
wants more.

## Startup checklist

On a NEW run (not resume):

1. Parse args: detect `--recycle` flag (anywhere in the arg list). If present, set `MODE=recycle`; else `MODE=inline`.
2. Sniff input: remaining arg starts with `/`, `./`, or matches an existing file → path mode; else inline mode
3. **Repo resolution (before dependency checks).** The skill runs on cwd, but a task may target a different sibling repo (e.g. invoked from `flip-contracts` while the work is in `just-flip`). Do a CHEAP target-repo resolution now — enough to land the state dir in the right repo (full scope discovery comes in the `scope-discovery` phase). Use `claude-mem` search + a quick grep across sibling repos under the workspace root for the entities the task names.
   - **Target == cwd** → proceed in cwd.
   - **Target != cwd, target is a discoverable sibling WITH the deps in step 4** → `cd` into the target repo, append a re-root note to `progress.md`, proceed there. It's discoverable, so do NOT stop.
   - **Target undecidable** (can't confidently pick a repo) OR **target lacks deps** → **hard halt** with reason "scope-discovery: undecidable target repo (or target missing codex/gh/ccpm)". This is the one legit front-door stop — undecidable infra, not a judgment call.
   - **Task spans repos** → keep one-repo-per-run: pick the primary target, note cross-repo deps for `human-review-needed.md` + PR body later, proceed.
4. Verify dependencies in this order (in the RESOLVED repo), halt with clear error on any failure:
   - `command -v codex` → halt: "codex CLI not installed; install from https://github.com/openai/codex"
   - `codex exec --help >/dev/null 2>&1` → halt: "codex CLI broken or unauthenticated"
   - `command -v gh` → halt: "gh CLI required for GitHub sync"
   - `gh auth status` → halt: "gh CLI not authenticated; run `gh auth login`"
   - Repo is a git repo (`git rev-parse --git-dir`) → halt: "not in a git repo"
   - CCPM skill is available (`ls .claude/skills/ccpm/SKILL.md` OR `ls .claude/skills/ccpm/references/`) → halt: "ccpm skill not found in this repo"
   - CCPM context bundle present (`ls .claude/context/*.md`) → informational only; if missing, log to `progress.md`: "no .claude/context/*.md present; codex priming will be skipped this run" and continue. Not a halt — repos that never created a context bundle still work.
5. Detect terminal persistence: if `[ -z "$TMUX" ] && [ -z "$STY" ]` and no Claude Code daemon mode, print warning: "A long AFK run requires a persistent terminal. Wrap in tmux or screen, or use Claude Code's persistent-session mode. Continuing in 5s..." Continue regardless — it's a recommendation, not a requirement.
6. **Recycle warning (Epic-lite/Full only — irrelevant to Direct-lane work).** The lane isn't known yet here, but `--recycle`/`/loop` only matters for the heavy lanes. If `MODE=inline` AND the input looks large (input is a path OR more than ~3 bullets), print: "If this resolves to an Epic-lite/Full run, consider `/loop /yolo-afk-dev --recycle <args>` for auto-context-recycle at heavy-phase boundaries. Continuing inline in 5s..." Continue regardless. If `MODE=recycle` print: "Recycle mode ON (applies only if this becomes an Epic-lite/Full run). Heavy-phase boundaries auto-recycle via ScheduleWakeup(60s). MUST be invoked under `/loop` — first recycle attempt without `/loop` halts loud."
7. Run `scripts/init-run.sh <run-id> <inline|path> <content-or-path> <mode> <pr_topology>` (in the resolved repo) to mkdir state dir, save bullets, scan project memory for `reference_gh_repo_split*.md` and `yolo_afk_dev_pr_topology*.md`, populate `state.config.{mode, gh_issue_repo, gh_pr_repo, pr_topology}` (defaulting to `origin` for both repos when memory absent, and `per-epic` when no topology flag or memory override), record `state.repo_root` = resolved repo, and init `state.json`
8. Move to the **`scope-discovery`** phase (verifies scope + picks the lane; see `references/scope-discovery.md`). `classify` runs only if scope resolves to the Full lane.

On a RESUME:

1. Find target run-id (`scripts/resume.sh` handles `resume` vs `resume <run-id>`). Resume accepts both `phase == "halted"` (manual halt) and `phase == "recycle"` (auto-context-recycle wake-up).
2. Read `state.json`
3. Concurrent-edit check
4. Reset retry counter for `halted_at_phase`
5. Append "resumed" entry to `progress.md`
6. **If `phase == "recycle"`**: re-read `references/pipeline.md` for the upcoming phase only (`state.next_phase`), run CCPM `context-prime` to load `.claude/context/*.md`, then set `phase = state.next_phase`, clear halt fields, begin that phase. See `references/context-recycle.md`.
7. **If `phase == "halted"`**: trap-recovery check FIRST — if `halt_reason` references "needs --recycle" / "mode upgraded" / "cross-session" AND `config.mode == "recycle"` AND `/loop` is active, promote to recycle resume per "Mid-flight mode upgrades" trap recovery (set `phase=recycle`, `next_phase=halted_at_phase`, run context-prime, advance). Otherwise: jump to `halted_at_phase` and continue normal phase work.

## Boundaries — what this skill does NOT do

- Mark a PR ready / merge branches (draft PR is the end state; human ships)
- **Multi-repo runs** — one repo per run-id. Repo resolution may `cd` into a *different* single repo than cwd (the discovered target), but a task spanning repos picks one primary; cross-repo deps are logged, not auto-spawned.
- Cross-provider model fallback (Codex-only; Sonnet is the review-fallback, not a provider swap)
- Install missing dependencies (halt with clear error instead)
- Repair corrupt state files (halt with clear error instead)
- **Block on the human** — see Hard rule 0. No `AskUserQuestion` during a run, ever.

## See also

- `references/scope-discovery.md` — the front-door consensus gate + lanes (the autonomy core)
- `~/.claude/skills/grill-me/SKILL.md` — the grill skill we run inside Codex (Full lane)
- `~/.claude/skills/yolo-pr-review/SKILL.md` — sibling AFK skill, reference for codex-driven review hygiene
- `<repo>/.claude/skills/ccpm/` — project-level CCPM skill we drive through PRD/epic/sync/execute phases (Full lane)
- **Discovery toolkit** (Claude-side, scope-discovery Step A): `claude-mem` search (`/claude-mem:mem-search`), `/understand-anything:understand-chat` + `understand-explain`, and `CONTEXT.md`/`CONTEXT-MAP.md` + `docs/adr/*.md` grep
