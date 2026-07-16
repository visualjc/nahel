# Nahel — Product Constitution

> This is the constitution: human-owned, immutable without the maintainer's explicit sign-off, in every governance mode. Agents may propose amendments as observations; they may never edit this file autonomously.

## Goal

Enable a solo builder to run an AFK software development team: durable, tool-agnostic project state + workflows such that any capable agent (Claude Code, Codex, opencode, cursor-agent, OpenClaw, Hermes, …) or human can pick up any Nahel project at any point and advance it correctly — including fully autonomous plan→implement→verify runs that end in verified draft PRs.

## Domain facts

- Host agents differ in command systems, subagent models, and hooks; the only interfaces they all share are **the filesystem, the shell, and natural language**. Nahel builds only on those three.
- Project state must survive: tool switches, session ends, machine changes (via git), and months of inactivity (via briefings, not archaeology).
- The human is frequently AFK. Blocking on a human question is a failure mode; guessing visibly (logged assumptions, parked reviews) is the correct behavior.

## Hard constraints

1. The `nahel` CLI is **deterministic**: no LLM calls, no API keys, no network dependence for core operations. Semantic work happens in workflows executed by host agents.
2. All durable state lives in **committed repo-level files**. No state in `.claude/` or any per-agent directory; no state trapped in an app or database.
3. Agents never hand-edit state file internals (frontmatter, journals); they mutate state through the CLI.
4. External issue trackers are **one-way mirrors** of local state, never peers.
5. Every workflow must be drivable through **pure conversation** — slash commands are conveniences, never the only door.
6. Quality invariants are never silently skipped: failing repro test before bug fix (waiver = logged + surfaced), prototype code never merges, AFK runs verify-by-driving before opening a PR, PRs are merged by humans only.
7. Open source (MIT), TypeScript on Bun, dual-distributed (npm + compiled binaries).

## Non-goals

- **Not a two-way sync product** (no Unito/Exalate ambitions).
- **Not an agent or an LLM** — Nahel orchestrates and records; host agents think.
- **Not a hosted SaaS** — local-first; a UI, when it comes, is a client of the files.
- **Not an IDE or a chat app.**
- **Not a CI system** — it produces artifacts (tests, PRs) that existing CI consumes.
- **Not a general project-management tool for non-software work** (v1).

## Governance

```yaml
governance:
  product: human        # Jim Carter (visualjc)
  architecture: human   # Jim Carter (visualjc)
```

## Change log

Every change to this document is recorded here with the human sign-off that authorized it.

- **2026-07-15** — Drafted by the founding agent, transcribed from Jim Carter's decisions in the founding grilling session (2026-07-14/15).
- **2026-07-15** — Reviewed and blessed by Jim Carter; change-log section added under the same sign-off.
