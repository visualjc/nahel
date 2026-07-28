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

## Install

Nothing is published yet — no npm package, no release binaries (both land in Phase 5). Until then, one command compiles the standalone binary and puts `nahel` on your PATH. Needs [Bun](https://bun.sh) and git:

```sh
git clone https://github.com/visualjc/nahel.git && cd nahel && bun install && bun run install:local
```

That installs to `~/.local/bin/nahel`, overwriting anything already there — including the machine-local wrapper script that used to `exec bun <checkout>/src/cli.ts`, now retired. Set `NAHEL_BIN_DIR` to install elsewhere; if the directory isn't on your `PATH`, the command tells you so.

The compiled binary carries its own runtime: once installed, neither Bun nor the checkout is needed to run it.

```sh
bun run build      # current platform only → dist/nahel-<os>-<arch>
bun run build:all  # macOS + Linux, arm64 + x64
```

Then, in any repo:

```sh
nahel init                          # scaffold state (merges its section into an existing AGENTS.md)
nahel brief                         # orient
nahel install --agent claude,codex  # slash-command shims for the canonical workflows
```

Claude Code shims land in the repo (`.claude/commands/nd/`, committed); codex prompts land in `~/.codex/prompts/nd-*.md`, since codex reads custom prompts from your home directory only — so that one is per machine, not per clone.

## Lineage & attribution

- Ground-up successor to [CCPM](https://github.com/automazeio/ccpm) (MIT) by [Automaze](https://automaze.io) — Nahel inherits its spec-driven spirit and several templates, and departs from it on state model, vendor coupling, and agent-agnosticism.
- Name inspired by Brandon Sanderson's Nahel bond. Not affiliated with Dragonsteel Entertainment.

## License

[MIT](LICENSE)
