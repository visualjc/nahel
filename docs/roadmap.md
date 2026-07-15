# Nahel — Product Roadmap

> **nahel** *(n., from Brandon Sanderson's Stormlight Archive)* — the bond between a human and a spren that makes both more capable, deepened through progressive oaths.
>
> Name inspired by Brandon Sanderson's Nahel bond. Not affiliated with Dragonsteel Entertainment.

## Thesis

Agentic software development fails not because agents write bad code, but because **project state is trapped inside single tools and single conversations**. Nahel is a durable, tool-agnostic project state model plus the workflows that read and write it — so a project advanced from Claude Code today is seamlessly resumable from Codex, OpenClaw-via-BlueBubbles, or Hermes-via-Discord tomorrow, by a human, an agent, or an autonomous team of agents.

Nahel models the **whole software shop** — product ownership, architecture, planning, prototyping, implementation, bug fixing, QA — not just the "developer writing code" slice.

Lineage: a ground-up successor to [CCPM](https://github.com/automazeio/ccpm) (MIT), incorporating the yolo-afk-dev / yolo-pr-review autonomous execution engines and the Matt Pocock skills ecosystem (grilling, domain-modeling, diagnosing-bugs, tdd).

## Positioning

Personal system first, built with product-grade hygiene: open source, documented, defensible decisions — a portfolio artifact (LinkedIn, resume) that could become a product if it earns it. When personal-fit and general-product conflict, personal-fit wins.

---

## Locked architectural decisions

### 1. State lives in files + git; every frontend is a client
- All durable state is markdown-with-frontmatter + JSON in a **committed repo-level directory** (`nahel/`), not `.claude/` (which is tooling-only, per-agent).
- Any UI, CLI agent, or chat bot is a client over the same files. State travels via git.
- Remote (phone) is a **transport, not a tier**: Claude Code remote sessions / OpenClaw / Hermes are host agents receiving prompts over a wire. Nothing executes "on the phone."

### 2. Issue providers are mirrors, not peers
- Local files are canonical. GitHub/Linear/Jira/Trello/Obsidian sync is a **one-way projection** (push status out; pull comments as read-only annotations).
- Frontmatter carries `external_refs: [{provider, id}]` from day one so a `pull` capability can be added later. No two-way sync in v1 (it's a product in itself).

### 3. Prompts vs. program — the b+c split
- **Judgment work** (PRD authoring, decomposition, grilling, review) = canonical agent-neutral workflow docs in `nahel/workflows/*.md`, versioned with the project.
- **Mechanical work** (state mutation, validation, dependency graphs, sync, log rotation) = a real CLI. **An agent never hand-edits frontmatter; it calls the CLI.**
- CLI: **TypeScript on Bun**, dual-distributed (npm package + `bun build --compile` standalone binaries).
- **Shims**: per-agent slash commands (`.claude/commands/`, `~/.codex/prompts/`, `.cursor/commands/`, `.opencode/command/`, …) are generated 3-liners pointing at canonical workflows: `nahel install --agent claude,codex --prefix nd`. Default slash prefix `/nd:` (configurable). ccpm's `/context:*` commands are absorbed by the knowledge layer (`/nd:brief`, inception, compaction) rather than ported as-is. Chat agents with no command system enter via natural language + AGENTS.md — every workflow is drivable through pure conversation.

### 4. Four-layer state model (kills the 15 MB progress.md)
1. **Hot state** — `state.json` per run/epic: phase, statuses. Small, overwritten.
2. **Journal** — append-only JSONL via `nahel log`; CLI enforces rotation/archiving. `progress.md` is a *rendered view* (`nahel progress`), never canonical.
3. **Knowledge** — durable, curated: ADRs (`docs/adr/`), `CONTEXT.md` glossary, claude-mem-style **observations** (one fact per record, provenance link to journal, searchable via `nahel recall`).
4. **Briefing** — `nahel brief` generates the "fresh agent, here's the project" pack (2–4 KB) from layers 1–3. This is cross-tool session start.

**CLI is 100% deterministic** — no LLM calls, no API keys. Semantic work (compaction, observation extraction, summarization) happens in workflows run by host agents. `nahel validate` warns when compaction is overdue.

### 5. Work-item taxonomy — type × size
`feature | bug | chore | plan | prototype | qa` — type picks the workflow; size (yolo lanes: Direct / Epic-lite / Full) scales ceremony within it.

- **bug**: diagnosis-first (diagnosing-bugs skill → tdd skill). Durable `investigation.md` (symptoms, repro status, hypotheses tested, root cause) — the PRD-analog for multi-day bugs. **Hard rule: failing repro test before fix**, waivable only via a logged `repro-waived: <reason>` observation surfaced in PR body + briefings; waiver valid only if investigation doc shows failed repro attempts. Closed bugs distill root cause into an observation.
- **plan**: virtual product owner. Deliverable = 1–N PRDs in `draft` status, no code. Human (or delegated governance) flips to `approved` → eligible for feature work. Subsumes spikes.
- **prototype**: `--variants N` → parallel worktrees, each a mini-PRD (approach statement) + running throwaway impl. Ceremony stripped (no TDD/review/consensus). **Hard invariant: prototype code never merges.** Promotion = variant's mini-PRD → full PRD → feature lane, with prototype worktree as reference.
- **qa**: hybrid-with-ratchet. (1) Exploratory agent-as-tester pass drives the real app against charters from PRD acceptance criteria; findings become typed bug items with repro steps captured. (2) The ratchet: everything scriptable gets written as deterministic e2e tests (Playwright/API), committed, CI-run forever. Agentic judgment spent once per flow; regression protection permanent. Durable `qa-plan.md` (charters, coverage map, scripted-vs-judgment).

### 6. Run contract
Per-repo config: how to launch, seed, and test the app (commands, ports, test credentials). Prerequisite for QA lane and any cold-start execution by any agent. Verified by `nahel doctor`.

### 7. Roles & governance — constitution vs. legislation
- **Knowledge first, persona second.** `PRODUCT.md` (value prop, users, differentiators, explicit non-goals) + `ARCHITECTURE.md` + `CONTEXT.md` + ADRs ground everything; all load into `nahel brief`.
- **Role charters** (`nahel/roles/product-owner.md`, `architect.md`) — agent-neutral markdown (Intent-style specialists, portable). Review **at artifact gates**, not continuously: PO gates PRD `draft→approved`, scope changes, acceptance criteria; Architect gates epic plans and ADR compliance.
- **Constitution** (human-seeded, immutable without human signature in every mode): project goal, domain facts (e.g. "how speed counting works"), hard constraints, non-goals.
- **Legislation** (delegable per project): priorities, PRD approvals, new ADRs, architecture evolution.
- Per-project: `governance: {product: human|delegated, architecture: human|delegated}`.
  - `human`: agents propose, human approves.
  - `delegated`: 2-of-N **cross-vendor consensus** (Claude proposes / Codex verifies pattern generalized), append-only decision records, and `nahel digest` (audit, not gate). Constitution disagreements park to `human-review-needed`; run continues elsewhere.
- AFK reviews are **advisory-with-teeth**: a reject parks the item, never stalls the run, never gets overridden.

### 8. Inception — tiered founding workflow
- `nahel init` (CLI): scaffold only. **Inception workflow** (grill-with-docs style interview): constitution, governance config, seed glossary/ADRs, run contract, initial plan items.
- **Tiers**: `seed` (~5 min, for quick prototype ideas) / `standard` / `full` (blackjack-training-app grade). Ratchet: graduating to delegated governance or promoting a prototype demands inception upgrade.
- **Brownfield**: mine first (draft constitution/architecture from code, README, git history), interview second (human corrects drafts).
- **Gate for autonomy only**: interactive work needs no artifacts; AFK lanes and delegated governance hard-block without constitution + run contract ("run inception first").

### 9. Skills as versioned dependencies
- `skills.yaml` + lockfile: `{repo, ref, use: [...]}`, pinned commits. v1 = dumb clone-and-symlink; delegate fetch/placement to the existing `skills` CLI (`npx skills add …`) where possible.
- `kind: markdown` (clone/symlink) vs `kind: tool` (codegraph, Understand-Anything — binaries/servers/indexes: declared install command + healthcheck via `nahel doctor`; their generated artifacts are environment, gitignored, never project state).
- Every skill-invoking workflow carries a one-paragraph inline fallback for degraded environments.

### 10. Intervention is a first-class state operation
`pause` / `claim` (human takes over mid-flight) / `handback` (agent resumes, human changes journaled) — in the state schema from v1, headless. The future workspace UI only renders capabilities the state machine already has. (Generalizes yolo-afk-dev halt/resume.)

### 11. New repo, not a refactor
Fresh skeleton; port ccpm's templates/prose and yolo's state-machine patterns piece by piece. ccpm stays as reference with MIT attribution. yolo-afk-dev becomes the AFK runner; yolo-pr-review becomes the review workflow — folded in, not bolted on.

---

## Phases

Ordering principle: **AFK-first** — the autonomous team is the priority; human-step-in UX deepens later. Each phase ships something usable.

### Phase 0 — Foundation (the skeleton)
- New repo `nahel`. Bun + TypeScript CLI scaffold.
- State schema v1: work items (type/status/frontmatter incl. `external_refs`), `state.json`, journal JSONL, knowledge dirs, pause/claim/handback ops.
- Core commands: `init`, `log`, `progress`, `brief`, `validate`, `status`.
- Canonical workflow doc format (frontmatter: name/description/args) + shim generator (`nahel install`) for **Claude Code first**.
- AGENTS.md template so chat agents can drive everything conversationally.
- **Exit test**: a Claude Code session and a bare `codex` session can both read the same project state and advance it.

### Phase 1 — Core loop, interactive (port ccpm's soul)
- Port + rewrite workflows: prd-new, prd-parse, epic-decompose, task lifecycle — all state ops through the CLI.
- **Run contract** (`nahel doctor`): how to launch/seed/test the app — required here so Phase 2 can verify by driving.
- Inception workflow (seed/standard/full; greenfield + brownfield mining).
- Bug lane: investigation.md, diagnosing-bugs + tdd integration, repro-test rule + waiver.
- Compaction workflow (journal → observations) + `nahel recall`.
- Skills dependency v1 (`skills.yaml` + lockfile + clone/symlink).
- **Exit test**: run a real feature and a real bug end-to-end interactively on a side project; second session in a different tool resumes from `nahel brief` alone.

### Phase 2 — AFK engine (port the yolo skills)
- yolo-afk-dev rebuilt on Nahel state: scope discovery, lanes (Direct/Epic-lite/Full), Codex consensus, halt/resume → pause/claim/handback, draft-PR-per-epic.
- yolo-pr-review rebuilt as the review workflow.
- plan + prototype types (parallel variant worktrees, never-merge invariant, promotion path).
- **Verify-by-driving invariant**: every AFK run must satisfy the run contract, launch the app, and exercise the changed flow before its draft PR opens (yolo's adversarial-verify made concrete). No lane skips it.
- Autonomy gate enforcement (no constitution + run contract → refuse).
- **Exit test**: one-line kickoff at 9am ("add X to project Y"), verified-by-driving draft PR with review trail by evening, zero human turns — from desktop *and* from a remote transport.

### Phase 3 — QA lane
- Charter generation from PRD acceptance criteria, exploratory agent pass (browser/API driving), the deterministic-script ratchet, qa-plan.md.
- QA findings auto-spawn typed bug items.
- Ordered before governance: QA improves every AFK run; delegated governance only matters once you start walking away from product decisions.
- **Exit test**: QA sweep of an existing app produces committed passing e2e tests + at least one real bug item with captured repro.

### Phase 4 — Roles & governance
- PRODUCT.md / ARCHITECTURE.md conventions; role charters (PO, architect); artifact gates wired into feature/plan lanes.
- Delegated governance: cross-vendor consensus protocol, append-only decisions, `nahel digest`.
- **Exit test**: the blackjack project runs a week of delegated legislation; the digest is coherent; the constitution was never touched.

### Phase 5 — Ecosystem breadth
- Provider mirror plugin API; **GitHub mirror first** (recovering ccpm's team-visibility story), then Linear/Trello/Obsidian as demand appears.
- Shim targets: codex, opencode, cursor-agent, pi, Gemini CLI.
- Tool-skill (`kind: tool`) support: codegraph, Understand-Anything healthchecks.
- Hardening for public release: docs site, install script, versioning, examples. **This is the LinkedIn/launch moment.**

### Phase 6 — UI
- **6a — Review inbox** (`nahel review`): local web app; cross-project inbox of pending human decisions (PRD approvals, prototype judgments, waivers, digests, parked items, diff review); approve/reject/comment = frontmatter edits + journal events. Tailscale tunnel ⇒ phone approvals.
- **6b — Orchestration workspace** (Intent-class): spaces over worktrees, live agent progress, step-in/step-out (claim/handback buttons), spec + changes + context views. Built entirely on the state model — a rendering layer, not a second brain.

---

## Deferred / open questions

- **Two-way provider sync** — only if a human teammate materializes who lives in Linear/Jira.
- **Consensus vendor set** — Codex is today's verifier; the consensus protocol should treat "which second vendor" as config, not architecture.
- **Skills registry ambitions** — v1 is a manifest + lockfile; a real registry only if the ecosystem asks.
- **Recurring exploratory QA sweeps** (agent-as-tester on a schedule) — deliberately not in v1; revisit after the ratchet proves itself.
- **Work queue / desktop daemon** — not needed while remote = transport to an always-on host agent; revisit if kickoff-while-truly-offline becomes real.
- **Name/IP** — README attribution line for the Sanderson inspiration; rename only if Dragonsteel ever objects.
