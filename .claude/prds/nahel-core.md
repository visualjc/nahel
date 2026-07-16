---
name: nahel-core
description: Phase 0 foundation — state schema v1, deterministic CLI (init/log/status/progress/brief/validate + intervention ops), canonical workflow format, Claude Code shim generator
status: backlog
created: 2026-07-16T00:34:30Z
updated: 2026-07-16T17:07:05Z
---

# PRD: nahel-core

## Executive Summary

Build Nahel's skeleton: the durable, tool-agnostic project state model (schema v1) and the deterministic `nahel` CLI that is the only writer of that state. Deliverables: the on-disk schema (work items, runs, journal, observations, hot state); the CLI surface — `init`, the mutation commands (`item`/`run` verbs), `log`, `status`, `progress`, `brief`, `validate`, the intervention ops `pause`/`claim`/`handback`, and `install`; the canonical workflow document format; and a shim generator targeting Claude Code (`/nd:` prefix). Exit test: `nahel brief` run in this repo outputs a briefing that would correctly onboard a fresh agent to the Nahel project itself.

## Problem Statement

Agentic development fails because project state is trapped inside single tools and single conversations (see PRODUCT.md, docs/roadmap.md). Every downstream capability — cross-tool resumability, AFK runs, briefings instead of archaeology, human step-in — depends on a state substrate that does not exist yet. This PRD builds that substrate and nothing else. It is Phase 0 of the roadmap and the target of bootstrap Stage B.

Why now: Nahel is building itself on temporary ccpm scaffolding (docs/scaffolding.md). Until schema v1 and the CLI exist, no later phase can start and the Stage C cutover (`nahel import --from-ccpm`) has nothing to import into.

## User Stories

Personas: **Jim** (solo builder, human maintainer), **host agent** (Claude Code, Codex, or any CLI agent working in a nahel-managed repo), **fresh agent** (a session with zero prior context).

1. **Fresh-agent onboarding.** As a fresh agent, I run `nahel brief` and receive a 2–4 KB pack (project goal, constraints, glossary pointers, current item statuses, recent activity) sufficient to act correctly without reading the repo's history.
   - *Acceptance:* a fresh Claude Code session in the nahel repo, given only the brief, can correctly state the project's goal, hard constraints, current in-progress items, and what to do next. This is the Stage B exit test.
2. **Recording what happened.** As a host agent, I record every significant event (`task started`, `test failed`, `decision made`, `assumption logged`, …) via `nahel log`, never by editing files, so the record survives my session.
   - *Acceptance:* `nahel log` appends a schema-valid event with required actor to the correct journal segment; hand-editing is never needed for any supported operation.
3. **Understanding history.** As Jim returning after two weeks, I run `nahel progress` and see a readable timeline of what was done and when, rendered from the journal.
   - *Acceptance:* output is ordered, filterable by work item, and contains no information that isn't in the journal (rendered, never canonical).
4. **Checking state.** As a host agent, I run `nahel status` and see the work-item tree (hierarchy via `parent`) with types, statuses, and active runs.
   - *Acceptance:* reflects frontmatter + hot state exactly; exits non-zero on unparseable state.
5. **Founding a project.** As Jim starting a new lab, I run `nahel init` and get the full scaffold non-interactively: directory structure, config, and templates (PRODUCT.md with change-log section, CONTEXT.md, AGENTS.md).
   - *Acceptance:* `nahel init` in an empty git repo produces a structure where every other command immediately works; running it twice is safe (refuses or no-ops, never clobbers).
6. **Guarding integrity.** As any user, I run `nahel validate` and learn about schema violations, broken references, claim violations, and overdue journal rotation.
   - *Acceptance:* seeded corruption (bad frontmatter, dangling `parent`/`depends_on`/event refs, agent mutation on a claimed item) is detected with actionable messages; clean repo validates silently (exit 0).
7. **Stepping in.** As Jim, I `nahel claim <item>` mid-AFK-run to hand-fix one task; agents are refused mutations on it until `nahel handback`, which journals my changes.
   - *Acceptance:* claim sets `claimed_by` and pauses active runs touching the item; CLI mutations by `actor.kind=agent` on a claimed item fail with a clear error; handback clears the claim and appends a handback event referencing the human's changes (git diff summary since claim).
8. **Installing agent entry points.** As Jim, I run `nahel install --agent claude` and get `/nd:*` slash commands generated from canonical workflow docs.
   - *Acceptance:* for each `nahel/workflows/*.md` with valid frontmatter, a 3-line shim appears under `.claude/commands/nd/`; regeneration is idempotent; unknown agents fail with a clear message.

## Requirements

### Functional

**F1 — State schema v1** (all decisions from CONTEXT.md + ADR-0012; the glossary is the contract)

- **Work item**: markdown + frontmatter. Fields: `id` (short random, merge-safe), `name` (slug), `type` (`feature|bug|chore|plan|prototype|qa`), `status` (`backlog|in-progress|blocked|in-review|done|dropped`), `lane` (`direct|epic-lite|full`), `parent` (item id, optional), `depends_on` (item ids), `external_refs` (`[{provider, id}]`), `claimed_by` (actor id, optional), `created`, `updated`. Hierarchy: epics are items with children; tasks are leaves; one record type.
- **Run**: first-class record: `id`, work-item ref, `actor`, `lane`, `phase` (workflow-owned string), lifecycle status, `started`/`ended`. Hot state `state.json` lives at the run.
- **Journal**: JSONL segments, one per run plus segments for non-run events; reading merges by timestamp. Rotation/archiving enforced by CLI. Events: `id` (stable, unique), `ts`, `type`, `actor` (`{kind: human|agent, id, session?}` — required), optional `run` and `item` refs, `payload`.
- **Observation**: one markdown file per fact: frontmatter (`id`, `created`, `tags`, `sources: [event ids]`), body = the fact. (Written by workflows/humans in later phases; Phase 0 defines the format and validates it.)
- **Layout**: state machinery under committed `nahel/` (config, items, runs, journal, observations). Knowledge stays at conventional paths (`PRODUCT.md`, `CONTEXT.md` at root; `docs/adr/`); nahel config records those paths.
- **Concurrency semantics** (extends ADR-0012; decided before implementation, not during):
  - *Non-run segment ownership*: non-run events go to a writer-scoped segment created per session with a merge-safe random ID (same generator as work-item IDs). No two writers ever share an active segment file.
  - *Deterministic ordering*: each segment carries a monotonic per-segment sequence number; merged reads order by timestamp, then segment sequence, then event ID — a total order identical on every machine.
  - *Atomic writes*: journal appends are single-line `O_APPEND` writes; frontmatter and `state.json` mutations are write-temp-then-atomic-rename. A killed process never leaves a half-written record.
  - *Mutation consistency (write-ahead journal)*: a mutation is two fs ops — journal event and record write — and the event goes **first**, carrying the full mutation. The only crash window therefore leaves the journal ahead of the record, never an unjournaled mutation (the audit can under-materialize but never lie). `validate` detects journal-ahead divergence (record `updated` vs latest mutation event) and `validate --repair` replays the pending mutation deterministically from the event payload.
  - *Rotation*: only closed segments (ended runs, closed sessions) are archived; active segments are never touched by rotation.
  - *Claims across worktrees*: claim state is repo state and travels via git like everything else (ADR-0002) — enforcement is evaluated per-checkout at CLI-call time, so cross-worktree visibility is eventual on git sync, by construction. Consequence, stated not hidden: claim *before* kicking off parallel runs for immediate effect; `validate` flags claim conflicts discovered at merge.

**F2 — `nahel init`**: non-interactive scaffold. Creates `nahel/` structure, config with defaults (flag-overridable), and templates: PRODUCT.md (constitution skeleton **including the change-log section**), CONTEXT.md (glossary skeleton), AGENTS.md (conversational entry point so chat agents can drive everything). Safe to re-run.

**F3 — Mutation commands (the write surface)**: every state change an agent or workflow needs has a CLI verb — this is what makes "agents never hand-edit state" satisfiable, not aspirational.
- `nahel item new` (type, name, lane, `--parent`, `--depends-on`, …) → creates the item record, assigns ID.
- `nahel item update <id>` (status, lane, parent, depends_on, external_refs) → validated transitions; `updated` maintained by the CLI.
- `nahel run start <item>` / `nahel run update <run> --phase <phase>` / `nahel run end <run> <outcome>` → run lifecycle and hot-state ownership.
- Every mutation automatically journals a corresponding event (with actor) — `log` is for *observations about work*, mutations self-record.
- Acceptance: the full item + run lifecycle is drivable end-to-end with zero hand-edits; attempting a mutation not exposed by the CLI is, by definition, a missing-feature bug.

**F4 — `nahel log`**: append a typed event. Requires actor; infers/accepts run and item refs; writes to the correct segment; creates non-run segments as needed. Core event-type set defined in schema (open to extension without code change).

**F5 — `nahel status`**: work-item tree with type/status/lane, active runs and their phases, claims. Human-readable default; `--json` for machines.

**F6 — `nahel progress`**: journal timeline, newest-last, filterable (`--item`, `--since`, `--limit`). Strictly a view.

**F7 — `nahel brief`**: the onboarding pack. Deterministic composition, spec'd so acceptance is objective:
- *Required sections, in order*: (1) goal + hard constraints — extracted **verbatim by heading convention** from PRODUCT.md (`## Goal`, `## Hard constraints`; the `init` template defines these headings — the CLI never summarizes, per ADR-0004); (2) knowledge pointers (CONTEXT.md, ADR dir, from config); (3) item statuses (F5 machinery); (4) recent activity, truncated (F6 machinery); (5) pending human decisions (claims, blocked items, parked); (6) `validate` warnings.
- *Size budget*: 4 KB target. Truncation drops content in fixed priority order (oldest activity first, then done-item detail); required sections are never dropped, and truncation is always marked in output. Constitution text over budget is truncated with an explicit pointer to the file, never silently.
- If PRODUCT.md is missing or lacks the conventional headings, brief says so explicitly (that's a finding, not an error).

**F8 — `nahel validate`**: schema validity of every record; referential integrity (parent, depends_on, run→item, observation sources→events); claim-violation detection (including conflicts surfaced by merges); journal segment well-formedness; journal-ahead divergence detection with `--repair` (deterministic replay of pending mutation events — the only flag that mutates, and it only materializes what the journal already records); rotation-overdue and compaction-overdue warnings (per ADR-0004). Exit 0 clean / non-zero on errors.

**F9 — Intervention ops**: `nahel pause <run>`, `nahel claim <item>`, `nahel handback <item>` per glossary semantics. Sharpened:
- *Claim scope*: claiming an item covers its entire subtree — descendants are claimed transitively; active runs touching any covered item are paused.
- *Actor identity*: resolved from config/session context (`nahel/config` actor entry or `NAHEL_ACTOR` env), never from a casual per-command flag. `validate` flags events whose actor is absent or malformed.
- *Threat model, stated honestly*: enforcement is a tool-boundary guardrail against **cooperating-but-fallible** agents (accidental races, forgotten claims) — a local, deterministic, no-auth CLI (hard constraint 1) cannot stop an adversarial process with shell access, and pretending otherwise would be false security. The journal makes any bypass auditable.
- *Handback evidence, deterministic*: `claim` records a baseline in its journal event — HEAD commit SHA and a `git status --porcelain` snapshot. `handback` records: commits since baseline (SHAs), diff summary baseline→HEAD (files, +/-), and current dirty state; changes uncommitted *at claim time* are listed as excluded from attribution. Same repo state → byte-identical evidence.

**F10 — Canonical workflow format + shim generator**: workflow docs in `nahel/workflows/*.md` with frontmatter (`name`, `description`, `args`). `nahel install --agent claude [--prefix nd]` generates per-workflow 3-line shims ("load canonical workflow X") under `.claude/commands/<prefix>/`. Claude Code is the only target in this PRD; the generator's agent targets are a lookup table so later agents are additive.

### Non-Functional

- **Deterministic** (ADR-0004): no LLM calls, no API keys, no network. Identical inputs → identical outputs (timestamps/random IDs injected for tests).
- **Merge-safe** (ADR-0012): random IDs, per-run journal segments, run-scoped hot state. No sequential counters anywhere.
- **TDD** (ADR-0011, AGENTS.md house rules): every command test-first via `bun test`; verbose tests usable for debugging; no mocks of the filesystem — tests run against real temp dirs.
- **Agents never hand-edit state** (ADR-0004): every mutation the system needs must have a CLI verb; if a workflow would need to hand-edit, that's a missing CLI feature.
- **Performance**: all commands complete in under 1s on repos with thousands of events (journal reads are streaming merges, not full loads).
- **TypeScript on Bun** (ADR-0001); runs via `bun run src/cli.ts` — no packaging in this PRD.

## Success Criteria

1. **Stage B exit test (primary)**: `nahel brief` in this repo onboards a fresh agent correctly — verified by opening a fresh session with the brief alone and scoring it against a fixed rubric: the agent can state (a) the project goal, (b) the hard constraints, (c) what is currently in progress, (d) the correct next action, and (e) where canonical truth lives for each state layer. Pass = 5/5, judged by Jim.
2. **End-to-end journey test (executable)**: one scripted `bun test` drives the whole thesis on a temp repo: `init` → `item new` → `run start` → `log` → `item update`/`run update --phase` → `run end` → `brief` renders all required sections reflecting everything above. The only non-automated step is the semantic comprehension check in criterion 1.
3. **Roadmap Phase 0 exit test**: a Claude Code session and a bare `codex` session can both read the same project state and advance it (log events, flip statuses via `item update`) through the CLI.
4. `nahel validate` exits 0 on this repo once its own state is initialized.
5. 100% of state mutations used during development happen through the CLI (journal is the audit: zero hand-edit events).
6. All commands implemented test-first; `bun test` green; every functional requirement has failing-first test coverage.
7. Claim enforcement demonstrably blocks an agent mutation on a claimed item, including a descendant of a claimed parent (test + manual drive).
8. Merge-safety demonstrated by test: two temp worktrees mutate state and log events in parallel; the branches merge with zero conflicts and `validate` passes on the result.

## Constraints & Assumptions

- Scaffolding rules (docs/scaffolding.md): built via ccpm + yolo-afk-dev; this PRD's epic/tasks keep import-friendly frontmatter (`name`, `status`, `depends_on`); ccpm annoyances become Nahel work items, never ccpm fixes.
- yolo invariants in force from the first AFK run: never merge, never weaken tests, verify-by-driving, Codex consensus; humans merge PRs.
- Solo maintainer; AFK-first development; human gates are batched (constitution, PRD approval, PR merges).
- The glossary (CONTEXT.md) is normative for all naming — code and schema use its terms exactly.

## Out of Scope (explicitly NOT building)

- Provider mirrors/sync of any kind — `external_refs` is a dormant field.
- Inception workflow, compaction workflow, `nahel recall`, `nahel doctor`, run contract — Phase 1.
- AFK engine, lanes enforcement, consensus, worktree orchestration — Phase 2 (yolo scaffolding covers it meanwhile).
- Shims for agents other than Claude Code; `import --from-ccpm` (Stage C, immediately after this).
- npm publishing, compiled binaries, versioning/release machinery.
- Any UI; any LLM-calling feature; two-way sync; non-software project support.

## Dependencies

- **External**: Bun runtime (installed), git. No network dependencies.
- **Internal**: PRODUCT.md (blessed 2026-07-15), CONTEXT.md glossary (schema contract), ADRs 0001–0012 (0012: merge-safe state), docs/roadmap.md Phase 0, docs/handoffs/2026-07-15-stage-b.md.
- **Process**: ccpm `/pm:*` for decomposition; yolo-afk-dev for AFK implementation; Jim for PRD approval, epic sanity-check, PR merges.
