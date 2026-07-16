# Nahel — Ubiquitous Language

Glossary of the domain model. Terms here are used exactly and consistently in code, workflows, docs, and conversation. Maintained via the domain-modeling discipline; sharpen a term the moment it wobbles.

## State

- **Work item** — the unit of intent: a typed, sized record (markdown + frontmatter) with a lifecycle. Types: `feature | bug | chore | plan | prototype | qa`. Work items form a hierarchy via `parent`: an epic is a work item with children; a task is a leaf. There is no separate epic/task record type.
- **Work item ID** — a stable, randomly generated short identifier, merge-safe across parallel worktrees. The slug/name is for humans; mirrors carry the pretty number (e.g. GitHub issue #). References always use the ID, never the slug.
- **Type** — what kind of work an item is; picks the workflow.
- **Status** — the coarse universal lifecycle every work item shares, regardless of type: `backlog | in-progress | blocked | in-review | done | dropped`. Queries, briefs, and mirrors only ever need this enum.
- **Phase** — the fine-grained, per-type position within an active run (e.g. bug: diagnosing → reproducing → fixing). Lives in hot state, not item frontmatter; owned by the workflow.
- **Actor** — who performed an event or mutation: `human` or `agent`, with an identifier (e.g. `jim`, `claude-code`, `codex`). Required on every journal event; consensus, digests, and claim/handback semantics depend on it.
- **Lane** — how much ceremony the work gets (`direct | epic-lite | full`); picked by verified scope, scales ceremony *within* a type.
- **Hot state** — `state.json` per run: current phase, statuses. Small, overwritten, machine-read. Lives at the run, not the work item.
- **Journal** — the append-only event record of what happened (`nahel log`), stored as JSONL segments — one segment per run (plus segments for non-run events) so parallel worktrees never merge-conflict. Reading merges segments by time. CLI enforces rotation; never edited, only appended.
- **Journal event** — one entry in the journal: unique ID (stable across rotation), timestamp, type, actor, optional run and work-item refs, payload. Event IDs are what provenance links point at.
- **Observation** — one durable curated fact distilled from experience: one record per fact, with provenance = journal event IDs. Human-readable and editable in review. Searchable via `nahel recall`.
- **Knowledge layer** — the curated durable set: ADRs, this glossary, PRODUCT.md, ARCHITECTURE.md, observations.
- **Brief / briefing** — the generated onboarding pack (`nahel brief`): everything a fresh agent needs to act correctly — goals, constraints, glossary, current state, recent activity — rendered from hot state + journal + knowledge. Answers *"what is this project and how do I act?"*
- **Progress** — the rendered journal timeline (`nahel progress`): what happened and when. Answers *"what has been done?"* A view, **never canonical** — there is no hand-maintained progress file. Brief embeds a truncated version.

## Governance

- **Constitution** — the human-owned core of PRODUCT.md: goal, domain facts, hard constraints, non-goals. Immutable without human sign-off in every mode.
- **Legislation** — delegable downstream decisions: priorities, PRD approvals, ADRs, architecture evolution.
- **Delegated governance** — a project mode where agent roles own legislation via cross-vendor consensus + append-only decisions + digests.
- **Role** — an agent-neutral charter (product-owner, architect) grounded in the knowledge layer; reviews at gates.
- **Gate** — an artifact transition requiring a verdict (PRD `draft→approved`, epic plan sign-off, diff review). Roles review at gates, not continuously.
- **Digest** — rendered summary of delegated decisions for human audit (`nahel digest`). Audit, not approval.
- **Consensus** — agreement between independent agents of different vendors (e.g. Claude proposes, Codex verifies) required for delegated legislation and AFK escape valves.

## Execution

- **Run** — one execution of a work item through its lane: a first-class record with its own ID, work-item ref, actor, phase, and lifecycle. An item may have many runs (attempt 1, attempt 2, resumed…); journal events reference the run. Hot state and `pause` target the run.
- **Run contract** — per-repo declaration of how to launch, seed, and test the app. Prerequisite for autonomy; checked by `nahel doctor`.
- **Verify-by-driving** — the invariant that an AFK run exercises the changed flow in the running app before its draft PR opens.
- **Ratchet** — QA discipline: agentic exploratory judgment is spent once per flow, then captured as deterministic e2e tests that run forever.
- **Investigation** — a bug's durable diagnosis document: symptoms, repro status, hypotheses tested, root cause.
- **Repro waiver** — the logged, surfaced exception to "failing repro test before fix"; valid only when the investigation shows failed repro attempts.
- **Pause / claim / handback** — first-class intervention operations. `pause` suspends a run. `claim` pins a work item at any level (one task or a whole epic) **and its entire subtree**: sets `claimed_by`, pauses active runs touching any covered item, and the CLI refuses agent mutations on claimed items — a guardrail against cooperating-but-fallible agents, with the journal making any bypass auditable. `handback` clears the claim and journals the human's changes; the agent resumes from the journaled delta.
- **Parked** — a decision routed to `human-review-needed` without blocking the run.

## Interfaces

- **Canonical workflow** — the single agent-neutral procedure doc for a task (`workflows/*.md`); the only place logic lives.
- **Shim** — a generated per-agent entry point (slash command, prompt file) whose only job is "load canonical workflow X". Default prefix `/nd:`.
- **Mirror** — a one-way projection of local state into an external tracker (GitHub, Linear, …); humans read there, truth lives here. `external_refs` in frontmatter.
- **Inception** — the founding workflow: constitution, governance, glossary seed, run contract, first plan items. Tiers: `seed | standard | full`; brownfield mines first, interviews second. Gates autonomy only.
- **Skill dependency** — a pinned external skill (`skills.yaml` + lockfile), `kind: markdown` or `kind: tool`.
- **Lab** — a real dogfood repo whose friction feeds Nahel's backlog.
- **Scaffolding** — the temporary ccpm + yolo tooling building Nahel until cutover (`nahel import --from-ccpm`).
