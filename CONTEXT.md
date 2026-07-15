# Nahel — Ubiquitous Language

Glossary of the domain model. Terms here are used exactly and consistently in code, workflows, docs, and conversation. Maintained via the domain-modeling discipline; sharpen a term the moment it wobbles.

## State

- **Work item** — the unit of intent: a typed, sized record (markdown + frontmatter) with a lifecycle. Types: `feature | bug | chore | plan | prototype | qa`.
- **Type** — what kind of work an item is; picks the workflow.
- **Lane** — how much ceremony the work gets (`direct | epic-lite | full`); picked by verified scope, scales ceremony *within* a type.
- **Hot state** — `state.json` per run/epic: current phase, statuses. Small, overwritten, machine-read.
- **Journal** — append-only JSONL event stream per project (`nahel log`). The record of what happened. CLI enforces rotation; never edited, only appended.
- **Journal event** — one timestamped, typed entry in the journal (task started, test failed, decision made, assumption logged, …).
- **Observation** — one durable curated fact distilled from experience, with provenance links to journal events. Searchable via `nahel recall`.
- **Knowledge layer** — the curated durable set: ADRs, this glossary, PRODUCT.md, ARCHITECTURE.md, observations.
- **Brief / briefing** — the generated onboarding pack (`nahel brief`): everything a fresh agent needs to act correctly, rendered from hot state + journal + knowledge. Prose views (like a progress report) are **rendered, never canonical**.

## Governance

- **Constitution** — the human-owned core of PRODUCT.md: goal, domain facts, hard constraints, non-goals. Immutable without human sign-off in every mode.
- **Legislation** — delegable downstream decisions: priorities, PRD approvals, ADRs, architecture evolution.
- **Delegated governance** — a project mode where agent roles own legislation via cross-vendor consensus + append-only decisions + digests.
- **Role** — an agent-neutral charter (product-owner, architect) grounded in the knowledge layer; reviews at gates.
- **Gate** — an artifact transition requiring a verdict (PRD `draft→approved`, epic plan sign-off, diff review). Roles review at gates, not continuously.
- **Digest** — rendered summary of delegated decisions for human audit (`nahel digest`). Audit, not approval.
- **Consensus** — agreement between independent agents of different vendors (e.g. Claude proposes, Codex verifies) required for delegated legislation and AFK escape valves.

## Execution

- **Run** — one autonomous execution of a work item through its lane.
- **Run contract** — per-repo declaration of how to launch, seed, and test the app. Prerequisite for autonomy; checked by `nahel doctor`.
- **Verify-by-driving** — the invariant that an AFK run exercises the changed flow in the running app before its draft PR opens.
- **Ratchet** — QA discipline: agentic exploratory judgment is spent once per flow, then captured as deterministic e2e tests that run forever.
- **Investigation** — a bug's durable diagnosis document: symptoms, repro status, hypotheses tested, root cause.
- **Repro waiver** — the logged, surfaced exception to "failing repro test before fix"; valid only when the investigation shows failed repro attempts.
- **Pause / claim / handback** — first-class intervention operations: suspend a run; human takes over a work item mid-flight; agent resumes with human changes journaled.
- **Parked** — a decision routed to `human-review-needed` without blocking the run.

## Interfaces

- **Canonical workflow** — the single agent-neutral procedure doc for a task (`workflows/*.md`); the only place logic lives.
- **Shim** — a generated per-agent entry point (slash command, prompt file) whose only job is "load canonical workflow X". Default prefix `/nd:`.
- **Mirror** — a one-way projection of local state into an external tracker (GitHub, Linear, …); humans read there, truth lives here. `external_refs` in frontmatter.
- **Inception** — the founding workflow: constitution, governance, glossary seed, run contract, first plan items. Tiers: `seed | standard | full`; brownfield mines first, interviews second. Gates autonomy only.
- **Skill dependency** — a pinned external skill (`skills.yaml` + lockfile), `kind: markdown` or `kind: tool`.
- **Lab** — a real dogfood repo whose friction feeds Nahel's backlog.
- **Scaffolding** — the temporary ccpm + yolo tooling building Nahel until cutover (`nahel import --from-ccpm`).
