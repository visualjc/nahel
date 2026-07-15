# ADR-0010: Intervention is a first-class state operation

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

The end-state includes an Intent-class workspace where a human steps into any run at any point. If intervention semantics are bolted on later, the UI becomes a second brain instead of a rendering layer. yolo-afk-dev's halt/resume proved the pattern headlessly.

## Decision

The state schema supports `pause` (suspend a run), `claim` (human takes over a work item mid-flight), and `handback` (agent resumes; human changes journaled) from v1, exercised via CLI + workflows long before any UI exists.

## Consequences

"AFK-first, step-in later" is sequencing, not rewrite. The Phase 6 workspace UI only renders capabilities the state machine already has.
