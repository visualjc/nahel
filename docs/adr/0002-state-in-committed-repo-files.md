# ADR-0002: State lives in committed repo-level files; git is the transport

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

Agentic development fails when project state is trapped in one tool or conversation. ccpm hid state in `.claude/` (typically gitignored, Claude-specific). Remote use (phone → OpenClaw/Hermes/remote sessions) means many hosts must see identical state.

## Decision

All durable state (work items, journal, knowledge, config) lives in a committed repo-level directory. Per-agent directories (`.claude/`, `.cursor/`, …) hold tooling only, never state. Every frontend — CLI agent, chat bot, future UI — is a client over the same files; state moves between machines and tools via git.

## Consequences

Cross-tool resumability by construction; remote is a transport, not a tier; the future UI is a rendering layer. Cost: state changes create commits/diffs — acceptable, and auditable.
