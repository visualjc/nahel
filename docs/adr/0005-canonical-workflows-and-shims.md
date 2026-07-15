# ADR-0005: Canonical workflows + generated per-agent shims

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

Every host agent has a different command format (`.claude/commands/`, `~/.codex/prompts/`, `.cursor/commands/`, `.opencode/command/`, TOML for Gemini). Maintaining parallel ports guarantees drift. Chat agents (OpenClaw, Hermes) have no command system at all.

## Decision

All procedure logic lives once, in agent-neutral canonical workflow docs (`workflows/*.md`, frontmatter: name/description/args), versioned with the project. `nahel install --agent <list> --prefix nd` generates per-agent shims — 3-line entry points that load the canonical doc. Default slash prefix `/nd:`. Every workflow must be drivable by pure conversation; shims are conveniences. ccpm's `/context:*` commands are absorbed by the knowledge layer (`nahel brief`, inception, compaction) rather than ported.

## Consequences

Zero-drift multi-agent support; adding an agent = adding a shim template. Dual-mode use (slash commands and natural language) falls out of the same artifact.
