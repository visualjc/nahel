# ADR-0005: Canonical workflows + generated per-agent shims

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

Every host agent has a different command format (`.claude/commands/`, `~/.codex/prompts/`, `.cursor/commands/`, `.opencode/command/`, TOML for Gemini). Maintaining parallel ports guarantees drift. Chat agents (OpenClaw, Hermes) have no command system at all.

## Decision

All procedure logic lives once, in agent-neutral canonical workflow docs (`workflows/*.md`, frontmatter: name/description/args), versioned with the project. `nahel install --agent <list> --prefix nd` generates per-agent shims — 3-line entry points that load the canonical doc. Default slash prefix `/nd:`. Every workflow must be drivable by pure conversation; shims are conveniences. ccpm's `/context:*` commands are absorbed by the knowledge layer (`nahel brief`, inception, compaction) rather than ported.

## Consequences

Zero-drift multi-agent support; adding an agent = adding a shim template. Dual-mode use (slash commands and natural language) falls out of the same artifact.

## Addendum — 2026-07-25 (PRD F8.2, codex target)

Shims are **not required to live in the repo**, and the generator's ownership is a *namespace*, not always a directory. Codex loads custom prompts only from `$CODEX_HOME/prompts` (default `~/.codex/prompts`), scanning top-level markdown files; repo-level `.codex/prompts` is an open upstream request (openai/codex #4734, #9848), not a feature. Rather than invent a location codex will not read, the `codex` target is home-rooted (`~/.codex/prompts/<prefix>-<name>.md` → `/prompts:nd-brief`), flat, and owns only the `<prefix>-` file-name namespace inside a directory that belongs to the user — pruning never touches the user's own prompts. Agent table entries therefore carry a root (`repo` | `home`) and a file-name prefix alongside their directory and renderer; the home directory is injected at the cli.ts entry point like every other ambient value.

Consequence: codex shims do not travel with a clone — each machine runs `nahel install --agent codex` once. That is acceptable because shims were always conveniences: what travels is AGENTS.md (which `nahel init` now merges into, F8.3) plus the canonical workflows themselves.
