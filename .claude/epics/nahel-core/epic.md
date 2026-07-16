---
name: nahel-core
status: backlog
created: 2026-07-16T16:54:21Z
progress: 0%
prd: .claude/prds/nahel-core.md
github: [Will be updated when synced to GitHub]
---

# Epic: nahel-core

## Overview

Implement Nahel Phase 0: the schema-v1 state store and the deterministic `nahel` CLI over it. The build is a thin three-layer stack — **schema** (types + validation), **store** (all filesystem I/O: frontmatter records, journal segments, atomic writes), **commands** (thin verbs over the store) — so every command is small and the invariants (merge-safety, atomicity, determinism) live in exactly one layer each. The PRD's glossary contract (CONTEXT.md) is normative for all naming.

## Architecture Decisions

- **Three layers, one owner per invariant.** `src/schema/` owns record shapes + validation; `src/store/` owns I/O (atomic rename writes, O_APPEND journal lines, segment merge-reads); `src/commands/` owns CLI verbs. Commands never touch `fs` directly — that's what makes "every mutation journals itself" and claim enforcement un-bypassable within the CLI.
- **Injected clock and RNG.** All `Date.now`/randomness flows through a single `Env` object injected at the entry point; tests supply fixed values. This is what makes "identical inputs → identical outputs" testable rather than aspirational.
- **Minimal dependencies**: `zod` for record validation, `yaml` for frontmatter — nothing else. Arg parsing via `node:util` `parseArgs` (built into Bun); no CLI framework, no gray-matter (frontmatter split is ~10 lines over `yaml`).
- **IDs**: lowercase base32 (no ambiguous chars), 8 chars, from injected RNG — merge-safe per ADR-0012, one generator shared by items, runs, events, segments.
- **Claim enforcement lives in the store's mutation path** (single choke point), not per-command — a new command cannot forget it. Its trust boundary is settled (PRD F9) and not to be re-derived during implementation: actor identity from config/`NAHEL_ACTOR`, enforcement is a **cooperative guardrail** against cooperating-but-fallible agents, auditability via the journal is the backstop — no auth machinery (hard constraint 1 forbids it).
- **Mutations are write-ahead-journaled** (PRD F1): the journal event, carrying the full mutation, is appended *before* the record write. The only crash window leaves the journal ahead — never an unjournaled mutation. `validate` detects journal-ahead divergence; `validate --repair` replays deterministically from the event payload. The store contract (T2) owns this ordering; commands never see it.
- **Views are pure functions** over store reads: `status`, `progress`, `brief` share one loaded-state snapshot type; brief composes the other two renderers (PRD F7's machinery-sharing made literal).
- **Tests run against real temp dirs** (`fs.mkdtemp` + real git for worktree/baseline tests) — no fs mocks, per house rules.

## Technical Approach

### Backend Services (the CLI is the whole product)

- **Schema layer**: zod schemas + TS types for WorkItem frontmatter, Run, JournalEvent, Observation, Config; status/type/lane enums from CONTEXT.md; event core-type set as string constants (extensible).
- **Store layer**: `readItem/writeItem` (frontmatter + atomic rename), `appendEvent` (segment resolution, per-segment sequence, O_APPEND), `readJournal` (segment merge: ts → seq → id), `mutate()` choke point (claim check → write → auto-journal), rotation (closed segments only), config/actor resolution (`nahel/config` + `NAHEL_ACTOR`).
- **Command layer**: `init`, `item new/update`, `run start/update/end`, `log`, `status`, `progress`, `brief`, `validate`, `pause/claim/handback`, `install`. Each ≤ ~100 lines because the layers below do the work.
- **Templates**: PRODUCT.md (with change-log section + conventional headings `## Goal`, `## Hard constraints`), CONTEXT.md, AGENTS.md — string templates in `src/templates/`, emitted by `init`.

### Frontend Components

None. Human-readable stdout + `--json` on `status` is the only UI (per PRD non-goals).

### Infrastructure

None to deploy. `bun run src/cli.ts` is the run contract; `bun test` is CI. No packaging (PRD out-of-scope).

## Implementation Strategy

Bottom-up in dependency order: schema → store → commands, TDD throughout (failing test first, per ADR-0011). The two cross-cutting proofs — the end-to-end journey test and the two-worktree merge test — are written as acceptance tests early (red) and are the definition of done (green). Risk concentrates in the store layer's concurrency semantics; it lands first and alone, so command work never relitigates it.

## Task Breakdown Preview

High-level task categories (≤10 tasks total):

- [ ] **T1 Schema layer**: types, zod validation, ID/clock injection, enums from glossary
- [ ] **T2 Store layer**: atomic writes, frontmatter I/O, journal segments + merge-read, mutation choke point, rotation, actor resolution
- [ ] **T3 `init`**: scaffold, config, templates (constitution w/ change log, glossary, AGENTS.md)
- [ ] **T4 Mutation commands**: `item new/update`, `run start/update/end`, auto-journaling
- [ ] **T5 `log`**: typed events, non-run segments
- [ ] **T6 Views 1**: `status` (+ `--json`) and `progress` (filters) as pure renderers
- [ ] **T7 View 2**: `brief` — section composition, verbatim heading extraction, 4 KB truncation rules
- [ ] **T8 `validate`**: schema, referential integrity, claim conflicts, segment well-formedness, rotation/compaction warnings
- [ ] **T9 Intervention ops**: pause/claim/handback, subtree coverage, baseline + deterministic handback evidence, enforcement tests
- [ ] **T10 Workflow format + `install` + acceptance proofs**: shim generator for Claude Code, E2E journey test, two-worktree merge test, self-init of this repo (Stage B exit)

Dependency shape: T1 → T2 → {T3, T4, T5} → {T6, T7, T8, T9} → T10.

## Dependencies

- **External**: Bun (installed), git; npm deps `zod`, `yaml` only. No network.
- **Internal**: blessed PRODUCT.md, CONTEXT.md (naming contract), ADRs 0001–0012, PRD nahel-core.
- **Prerequisite work**: none — src/cli.ts skeleton exists and is replaced by this epic.

## Success Criteria (Technical)

- All PRD success criteria 1–8, verbatim; the executable ones (journey test, worktree merge test, claim-block tests incl. descendant case, validate-clean on this repo) run in `bun test`.
- Every command < 1s on a journal of thousands of events (streaming merge, no full loads).
- Zero fs access from `src/commands/`; zero hand-edit events in this repo's own journal once self-initialized.
- `bun test` green; every functional requirement has failing-first coverage.

## Tasks Created

- [ ] 001.md - Schema layer — types, validation, injected ID/clock (parallel: true)
- [ ] 002.md - Store layer — atomic I/O, journal segments, mutation choke point (parallel: false)
- [ ] 003.md - nahel init — scaffold, config, templates (parallel: true)
- [ ] 004.md - Mutation commands — item new/update, run start/update/end (parallel: true)
- [ ] 005.md - nahel log — typed events, non-run segments (parallel: true)
- [ ] 006.md - Views — nahel status and nahel progress (parallel: true)
- [ ] 007.md - nahel brief — composition, verbatim extraction, truncation (parallel: true)
- [ ] 008.md - nahel validate — integrity checks and warnings (parallel: true)
- [ ] 009.md - Intervention ops — pause, claim, handback (parallel: true)
- [ ] 010.md - Workflow format, install shims, acceptance proofs, self-init (parallel: false)

Total tasks: 10
Parallel tasks: 8 (within their dependency waves; all command tasks share `src/cli.ts` registration — noted in conflicts_with)
Sequential tasks: 2 (002 critical path, 010 final integration)
Estimated total effort: 67 hours

## Estimated Effort

- **Timeline**: 3–5 AFK sessions (T1–T2 one session; T3–T5 one; T6–T8 one; T9–T10 one, plus slack). Human time: PR reviews + the criterion-1 rubric judgment.
- **Critical path**: T2 (store concurrency semantics) — everything else is thin over it.
- **Resources**: single worktree per task wave; yolo invariants in force.
