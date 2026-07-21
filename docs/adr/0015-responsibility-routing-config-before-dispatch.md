# 0015 — Responsibility routing: committed config in Phase 1, dispatch in Phase 2

Date: 2026-07-21
Status: accepted

## Context

Different responsibilities are best served by different agent CLIs and models
(the working policy: Fable-class models for architecture, review, and store
semantics; Opus-class for tightly spec'd implementation). That policy lived in
per-agent memory — invisible to other tools, unenforceable, and lost on a
fresh machine. Prior art: Cursor pstack's setup writes a role→model rule
(code / judgment / review) from detected models. Alternatives considered:
free-form responsibility keys (unvalidatable vocabulary), routing by work-item
type or lane (cannot express "Fable plans it, Opus codes it" within one item),
deferring everything to Phase 2, or anchoring routing to Phase 4 role charters.

## Decision

A `routing` section in schema-validated `nahel/config` maps a small fixed
enum of responsibilities — `architecture | implementation | review` — to
optional `{agent, model}` pairs, plus a default. A setup workflow detects
available agent CLIs and models and writes the section.

Phase 1 the map is **advisory**: `nahel brief` surfaces it and sessions are
expected to honor it (e.g. spawning implementation subagents on the mapped
model). Phase 2's AFK dispatcher **enforces** it when nahel launches
executors itself.

## Consequences

- The routing policy is committed, portable state — any tool reads the same
  map; a fresh clone inherits it.
- The responsibility vocabulary is shared and validated; extending the enum
  is a schema change, deliberate rather than accidental.
- Advisory-first means Phase 1 compliance depends on host agents reading the
  brief; violations are journal-auditable but not blocked.
- Role charters (Phase 4) will reference responsibilities rather than
  redefine executor selection.
