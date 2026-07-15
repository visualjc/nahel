# ADR-0006: Four-layer state model; prose is rendered, never canonical

Status: accepted · Date: 2026-07-15 · Source: founding grilling session (motivated by a real 15 MB progress.md)

## Context

ccpm's progress/context files conflate record (machine-queryable events), narrative (human prose), and knowledge (durable decisions) in append-forever markdown. They grow without bound and become unreadable by every audience.

## Decision

1. **Hot state** — `state.json` per run/epic; small, overwritten.
2. **Journal** — append-only JSONL via `nahel log`; CLI enforces rotation/archiving.
3. **Knowledge** — curated: ADRs, CONTEXT.md, PRODUCT.md, ARCHITECTURE.md, observations (one fact + provenance, `nahel recall`).
4. **Briefing** — `nahel brief` renders the fresh-agent onboarding pack from layers 1–3.

Prose progress reports are rendered views (`nahel progress`), never sources of truth. Compaction (journal → observations) is a workflow (per ADR-0004).

## Consequences

Bounded file sizes; every audience gets its view; cross-tool session start is a generated 2–4 KB briefing instead of archaeology.
