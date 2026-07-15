# Nahel

> *nahel* — in Brandon Sanderson's Stormlight Archive, the bond between a human and a spren that makes both more capable, deepened through progressive oaths.

**Nahel is a durable, tool-agnostic project state model — plus the workflows that read and write it — for agentic software development.**

A project advanced from Claude Code today is seamlessly resumable from Codex, OpenClaw, or Hermes tomorrow, by a human, an agent, or an autonomous team of agents. Nahel models the whole software shop — product ownership, architecture, planning, prototyping, implementation, bug fixing, QA — not just the "developer writing code" slice.

## Why

Agentic software development fails not because agents write bad code, but because **project state is trapped inside single tools and single conversations**. Nahel's answer:

- **State lives in committed repo files** (markdown + frontmatter + JSON). Git is the transport. Every tool — CLI agent, chat bot, future UI — is a client.
- **A deterministic CLI** (`nahel`) performs every state mutation. It never calls an LLM. Judgment lives in canonical, agent-neutral workflow docs any capable agent can execute.
- **AFK-first, human step-in always**: autonomous runs with hard quality invariants (repro test before bug fix, prototypes never merge, verify-by-driving, humans merge PRs), and intervention (`pause` / `claim` / `handback`) as first-class state operations.

## Status

**Pre-alpha — being built in the open, and building itself.** See [docs/roadmap.md](docs/roadmap.md) for the full design and phase plan, and [docs/bootstrap-plan.md](docs/bootstrap-plan.md) for how this repo is being bootstrapped (currently: scaffolded by [CCPM](https://github.com/automazeio/ccpm) + yolo-afk-dev until Nahel can manage itself — see [docs/scaffolding.md](docs/scaffolding.md)).

## Lineage & attribution

- Ground-up successor to [CCPM](https://github.com/automazeio/ccpm) (MIT) by [Automaze](https://automaze.io) — Nahel inherits its spec-driven spirit and several templates, and departs from it on state model, vendor coupling, and agent-agnosticism.
- Name inspired by Brandon Sanderson's Nahel bond. Not affiliated with Dragonsteel Entertainment.

## License

[MIT](LICENSE)
