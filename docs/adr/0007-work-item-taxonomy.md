# ADR-0007: Work-item taxonomy — type picks workflow, size scales ceremony

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

ccpm's only pipeline was PRD→epic→tasks — feature-shaped, wrong for bugs (need diagnosis, not requirements), prototypes (need speed, not process), planning (needs PRDs out, no code), and QA. Intent by Augment has the same blind spot.

## Decision

Types: `feature | bug | chore | plan | prototype | qa`. Type selects the workflow; verified scope selects the lane (`direct | epic-lite | full`, from yolo-afk-dev) which scales ceremony within the type.

- **bug**: diagnosis-first; durable `investigation.md`; failing repro test before fix (waivable only via logged, surfaced `repro-waived` observation backed by failed repro attempts).
- **plan**: virtual PO; deliverable = draft PRDs, no code.
- **prototype**: N parallel worktree variants, mini-PRD each, ceremony stripped.
- **qa**: hybrid-with-ratchet (see ADR-0011).

## Consequences

Bugs and QA become first-class; a one-line bug still gets the bug lifecycle without PRD theater.
