---
id: 8qtfdcxz
name: plan-launcher
kind: feature
horizon: later
parent: kyeb086y
adrs: []
features: []
created: 2026-08-04T21:04:26Z
updated: 2026-08-04T21:04:26Z
---
From bare bash, 'nahel plan' (and sibling verbs) can detect an installed agent CLI (claude, codex, ...) and launch it with the right workflow prompt — nahel as conversation starter, still zero LLM inside its own state operations. Thin exec wrapper over the agent-starts-nahel shape.
