# Nahel — Agent Instructions

You are working in the **Nahel** repo: a durable, tool-agnostic project state model + workflows for agentic software development, currently **building itself** (pre-alpha).

## Read first, in order

1. [PRODUCT.md](PRODUCT.md) — the constitution. Human-owned; never edit it autonomously.
2. [CONTEXT.md](CONTEXT.md) — the ubiquitous language. Use these terms exactly.
3. [docs/roadmap.md](docs/roadmap.md) — locked architectural decisions + phases. Do not relitigate locked decisions; propose changes as ADR drafts instead.
4. [docs/adr/](docs/adr/) — binding decisions with rationale.
5. [docs/bootstrap-plan.md](docs/bootstrap-plan.md) — how this repo gets built (stages A–E).

## Current stage

**Stage A/B (scaffolded)**: project management runs on ccpm under `.claude/` (`/pm:*` commands) + yolo-afk-dev for AFK runs — see [docs/scaffolding.md](docs/scaffolding.md) for the rules. PRDs/epics must keep import-friendly frontmatter (`name`, `status`, `depends_on`).

## House rules

- TypeScript on Bun. TDD for all CLI code (`bun test`).
- Quality invariants of ADR-0011 apply to work on Nahel itself: repro test before bug fix, verify-by-driving before PRs, humans merge.
- Every ccpm/tooling annoyance you hit becomes a Nahel work item, never a ccpm fix.
- Record decisions the moment they crystallize: ADR drafts in `docs/adr/`, glossary updates in CONTEXT.md.

## Run contract

- Install: `bun install`
- Test: `bun test`
- Run CLI: `bun run src/cli.ts <args>`
