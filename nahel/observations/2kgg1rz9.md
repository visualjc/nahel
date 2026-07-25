---
id: 2kgg1rz9
name: model-routing-prior-art
created: 2026-07-25T15:42:34Z
tags:
  - routing
  - models
  - prior-art
  - reference
sources:
  - m38k1f2j
---
Jim's proposal (2026-07-21): route responsibilities to different agents/models — e.g. Fable for architecture, Opus for implementation — spanning both agentic CLIs (claude, codex, cursor-agent) and per-model routing inside one harness. Prior art: Cursor pstack (https://github.com/cursor/plugins/tree/main/pstack) — /setup-pstack detects available models and writes an always-applied rule mapping each role to a model, defaults overridable per responsibility. Routing config shipped advisory in Phase 1 (ADR-0015); enforcement lands in nahel dispatch in Phase 2.
