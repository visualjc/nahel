---
name: phase-1-core-loop
created: 2026-07-21T18:04:24Z
updated: 2026-07-21T18:04:24Z
---

# Phase 1 — Core loop, interactive

> PRD authored by plan item `phase-1-prd` (`d8sa37p8`). Lifecycle (draft→approved) lives on that work item, never here (ADR-0013). Grounded in `docs/roadmap.md` Phase 1, PRODUCT.md, CONTEXT.md, ADR-0013/0014/0015, and the 2026-07-21 scoping session.

## Overview / goal

Phase 0 built the skeleton: state schema, store, journal, mutation commands, `brief`/`status`/`progress`/`validate`, intervention ops, `install` + self-init. Phase 1 ports ccpm's soul onto it: the canonical workflows that take a work item from idea to done, interactively, with every state mutation going through the `nahel` CLI (hard constraint 3) and every workflow drivable by pure conversation (hard constraint 5).

Deliverables: the feature lane (PRD authoring → parse → decompose → task lifecycle), the run contract + `nahel doctor`, responsibility routing config, the inception workflow, the bug lane, compaction + `nahel recall`, skills dependency v1, and `nahel import --from-ccpm`. The lab is **speed-count-game**: it hosts the exit test and is the importer's first real migration.

## Non-goals

- **AFK execution** — no autonomous dispatch, no consensus, no verify-by-driving. Phase 2.
- **Routing enforcement** — the routing map is advisory in Phase 1 (surfaced by `nahel brief`); Phase 2 dispatch enforces it (ADR-0015).
- **`prototype` and `qa` lanes** — Phase 2 and Phase 3 respectively. `plan` items exist only as far as F1 needs them (authoring PRDs).
- **`full` inception tier** — deferred; `seed` and `standard` ship now, with tier-ratchet rules defined now (F4).
- **`kind: tool` skill dependencies** — Phase 5; v1 is `kind: markdown` only.
- **Mirrors / provider sync** — `external_refs` is carried and preserved, but no push/pull in this phase.
- **Any UI** — everything is CLI + canonical workflows.
- **Semantic anything in the CLI** — compaction and observation distillation are workflows run by host agents; the CLI stays deterministic (hard constraint 1). `recall` is deterministic keyword search, not semantic search.

## Functional requirements

### F1 — Feature lane workflows

Port + rewrite the ccpm feature workflows as canonical workflows in `nahel/workflows/` (per `docs/workflow-format.md`), replacing prompt-side frontmatter editing with CLI mutations.

- **F1.1 `prd-new`** — a `plan` work item authors a PRD through a grilling-style interview. Output: a PRD in `docs/prds/<name>.md` with `name`/`created`/`updated` frontmatter and **no status field**; the plan item records the PRD as its deliverable. Approval is a status transition on the owning work item via the CLI (ADR-0013).
- **F1.2 `prd-parse`** — turns an approved PRD into a parent `feature` work item referencing the PRD by repo-relative path in frontmatter.
- **F1.3 `epic-decompose`** — decomposes a parent feature item (an epic, in the glossary sense: a work item with children) into child work items via `parent`, with `depends_on` edges. Lane (`direct | epic-lite | full`) is set per item.
- **F1.4 Task lifecycle** — start/progress/close workflows for leaf items: status transitions (`backlog | in-progress | blocked | in-review | done | dropped`), run creation, journaling via `nahel log`, all through the CLI. No workflow ever hand-edits frontmatter or journal files.

**Acceptance criteria**

- [ ] Each workflow is a valid canonical workflow doc (frontmatter schema passes; `nahel install --agent claude` generates working `/nd:` shims).
- [ ] Running the lane end-to-end produces zero hand-edits of `nahel/` state — verifiable because every mutation appears as a write-ahead journal event.
- [ ] A PRD produced by `prd-new` carries no status field; `nahel status` (or `brief`) surfaces the PRD's approval state from the referencing items.
- [ ] Each workflow is drivable by pure conversation — exercised at least once without a slash command.

### F2 — Run contract + `nahel doctor`

Per ADR-0014: the run contract is a `contract` section of the schema-validated `nahel/config` — launch/seed/test/healthcheck commands, ports, and the **names** of required env vars. Secret values live only in gitignored local env files.

- **F2.1** Schema for the `contract` section; `nahel validate` rejects malformed contracts.
- **F2.2** `nahel doctor` verifies: contract present and well-formed; named env vars set (values never read into output or state); healthcheck runnable. Failure output distinguishes **"contract missing"** (autonomy-gated, fix by inception/setup) from **"env incomplete"** (this machine isn't set up).

**Acceptance criteria**

- [ ] A clone plus a filled `.env` passes `nahel doctor` on speed-count-game.
- [ ] No secret value ever appears in committed state, journal events, or doctor output.
- [ ] `doctor` exit codes let workflows branch on the missing-vs-incomplete distinction.

### F3 — Responsibility routing

Per ADR-0015: a `routing` section in schema-validated `nahel/config` maps the fixed enum `architecture | implementation | review` to optional `{agent, model}` pairs, plus a default.

- **F3.1** Schema: enum keys only; unknown responsibilities rejected.
- **F3.2** Setup workflow (canonical doc) detects available agent CLIs and models and writes the section via the CLI.
- **F3.3** `nahel brief` surfaces the routing map so interactive sessions can honor it (e.g. spawning implementation subagents on the mapped model). Advisory only — no blocking.

**Acceptance criteria**

- [ ] `nahel validate` rejects a routing section with a non-enum key.
- [ ] A fresh clone's brief shows the committed routing map with zero local configuration.
- [ ] Backlog feature item `agent-responsibility-routing` (`7wkgajcg`) is closed by this requirement.

### F4 — Inception workflow

The founding workflow (grill-with-docs style interview): constitution, governance config, glossary seed, run contract, initial plan items.

- **F4.1** Tiers `seed` (~5 min) and `standard` ship; `full` is deferred but the tier is recorded so the ratchet can act on it.
- **F4.2** Brownfield mode: mine first (draft constitution/architecture from code, README, git history), interview second (human corrects drafts).
- **F4.3** Tier-ratchet rules defined now, enforced later: graduating to delegated governance or promoting a prototype demands an inception upgrade. Phase 1 records the tier in `nahel/config`; Phase 2+ gates read it.
- **F4.4** Gate for autonomy only: interactive work needs no inception artifacts; the recorded tier + run contract are what future AFK lanes hard-block on.

**Acceptance criteria**

- [ ] `seed` inception on an empty repo yields constitution, governance config, glossary seed, run contract stub, and at least one plan item in ≲5 minutes of interview.
- [ ] Brownfield inception on speed-count-game produces drafts the human corrects rather than blank questions.
- [ ] The inception tier is committed, schema-validated state.

### F5 — Bug lane

Diagnosis-first workflow for `bug` work items, integrating the diagnosing-bugs and tdd skill dependencies.

- **F5.1** Durable `investigation.md` per bug (symptoms, repro status, hypotheses tested, root cause) — the PRD-analog for multi-day bugs, referenced from the bug item.
- **F5.2** Hard rule: failing repro test before fix. The workflow routes diagnosing-bugs → tdd.
- **F5.3** Repro waiver: waivable only via a logged `repro-waived: <reason>` observation, surfaced in PR body and briefings; valid only if the investigation shows failed repro attempts. Never silently skipped (hard constraint 6).
- **F5.4** Closing a bug distills the root cause into an observation with provenance to the journal events.

**Acceptance criteria**

- [ ] A bug cannot reach `done` through the workflow without either a committed failing-then-passing repro test or a valid waiver observation.
- [ ] A waiver without documented failed repro attempts is rejected by the workflow procedure.
- [ ] `nahel brief` on a project with an active waiver surfaces it.

### F6 — Compaction workflow + `nahel recall`

- **F6.1** Compaction is a canonical workflow (host-agent semantic work): read archived journal segments, distill observations (one fact per record, provenance = journal event IDs) via CLI mutations, mark the covered events distilled.
- **F6.2** Trigger: `nahel validate` warns when un-distilled archived journal events exceed a configurable threshold — count and/or age, set in `nahel/config`.
- **F6.3** `nahel recall <terms>`: deterministic keyword search over observation records (title/body/tags), ranked by hit count then recency. No index, no LLM — scan at query time.

**Acceptance criteria**

- [ ] `validate` is quiet under the threshold and warns (with the exact command to run) above it.
- [ ] `recall` returns the same ranked results on every machine given the same state; results cite observation IDs and provenance event IDs.
- [ ] Compaction never edits or deletes journal events — append/mark only.

### F7 — Skills dependency v1

- **F7.1** `skills.yaml` + lockfile: `{repo, ref, use: [...]}` pinned to commits. `kind: markdown` only.
- **F7.2** Fetch/placement delegated to the existing `skills` CLI (`npx skills add …`) where possible; dumb clone-and-symlink fallback when it isn't.
- **F7.3** Every skill-invoking workflow (F1 grilling, F5 diagnosing-bugs/tdd) carries a one-paragraph inline fallback for degraded environments.

**Acceptance criteria**

- [ ] A fresh clone can restore pinned skills to the exact locked commits with one command.
- [ ] The bug lane still functions (degraded) with no skills installed, using inline fallbacks.
- [ ] Lockfile drift (yaml changed, lock stale) is a `validate` warning.

### F8 — `nahel import --from-ccpm`

Real scope, not scaffolding: migrate Jim's live ccpm projects (speed-count-game first).

- **F8.1** Map ccpm epics/tasks to work items: types, statuses onto the universal enum, `parent` hierarchy, `depends_on`, GitHub issue numbers into `external_refs: [{provider: github, id}]`.
- **F8.2** Relocate `.claude/prds/*` → `docs/prds/`; strip each PRD's `status` field and lift it onto the migrated owning work item (ADR-0013 consequence).
- **F8.3** Import is journaled (every created item is an ordinary CLI mutation) and idempotent enough to re-run after a partial failure without duplicating items.
- **F8.4** Post-import `nahel validate` passes; `nahel brief` on the migrated project is coherent.

**Acceptance criteria**

- [ ] speed-count-game migrates: item counts and statuses reconcile against the ccpm source, PRDs land in `docs/prds/` with no status field, GitHub refs preserved.
- [ ] No file under `.claude/` remains canonical state after import.

### F9 — Scaffolding retirement (retire-as-you-port)

Each ported workflow deletes its ccpm counterpart **in this repo** once the replacement works — no dead scaffolding lingers (NO DEAD CODE applies to prompts too).

- **F9.1** Feature lane workflows shipped → corresponding `.claude/commands/pm/*` + `.claude/scripts/pm/*` for prd-new/prd-parse/epic-decompose/task lifecycle removed.
- **F9.2** The hardening backlog (currently seven open items: `unborn-head-claim-error-message`, `install-shim-dir-eisdir-on-prune`, `same-second-timestamp-tie-break`, `malformed-claim-baseline-robustness`, `git-output-16mb-cap-check`, plus the two below) interleaves as direct-lane work throughout the phase — exercising the task lifecycle for real.
- **F9.3** The two scaffolding-tooling items — `macos-timeout-shim` (`y7vzx3be`) and `test-baseline-grep-under-set-e` (`0k83q678`) — wait for the scaffolding-retirement call: fix them only if the scaffolding they serve survives long enough to matter; otherwise drop with the scaffolding.

**Acceptance criteria**

- [ ] By phase end, every ported workflow's ccpm counterpart is deleted from this repo.
- [ ] Retirements are journaled (chore items, direct lane), not silent deletions.

## Exit test

Run in the lab (**speed-count-game**), which is also the F8 first migration:

1. Import speed-count-game via `nahel import --from-ccpm` (F8 acceptance).
2. Run **one real feature** end-to-end interactively: `prd-new` → approval on the plan item → `prd-parse` → `epic-decompose` → task lifecycle to `done`.
3. Run **one real bug** end-to-end: investigation.md → failing repro test → fix → root-cause observation.
4. Open a second session **in a different tool** (e.g. bare `codex`): it resumes correctly from `nahel brief` alone — states the project, the constraint set, what is in progress, and the correct next action, then advances a task through the CLI.

Pass = all four, judged by Jim. Failure anywhere feeds the backlog before the phase closes.

## Dependencies / ordering

Port order: **feature lane (F1) → bug lane (F5) → importer (F8)**.

- F2 (run contract/doctor) and F3 (routing) land early — F4 inception writes both sections, and `brief` needs routing to surface.
- F4 depends on F2/F3 config schemas; brownfield mining is exercised on speed-count-game before the exit test.
- F7 precedes F5 (bug lane invokes diagnosing-bugs/tdd as pinned skills) and F1's grilling dependency.
- F6 can land any time after Phase 0's journal rotation; its `validate` trigger should exist before the exit test so the lab accumulates honestly.
- F9 trails each port continuously; hardening items interleave as direct-lane work throughout.
- F8 last: it needs the item model exercised (F1/F5) so the mapping is ported onto proven ground, and it kicks off the exit test.

## Open questions

1. **Compaction threshold defaults** — the threshold is configurable (F6.2); the shipped default count/age values will be set from lab experience during the phase, not invented now.
2. **ccpm status edge cases in import** — ccpm items mid-flight (e.g. partially synced to GitHub, or statuses with no clean enum mapping) may need a small explicit mapping table; enumerate them from the real speed-count-game data during F8 rather than guessing here.
