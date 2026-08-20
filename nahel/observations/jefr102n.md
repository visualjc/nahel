---
id: jefr102n
name: decision-fpwwf6za
created: 2026-08-20T16:17:46Z
tags:
  - decision
  - grilling
sources:
  - vhk3m5mp
  - g7ss8d7p
---
Run dirs are committed store state with the distill-then-prune lifecycle: nahel/runs/<run-id>/ travels via git, its findings are distillable into observations via the existing compact/distill machinery, and only distilled run dirs become prunable — journal paths never dangle before distillation. Answered live by Jim 2026-08-19.

Decided by resolving grilling ticket fpwwf6za, charting: A dispatch of any size travels as a pointer prompt plus a run-dir handoff document, a worker's output comes back as a document the journal references by path, and no nahel workflow ever tells an agent to inline large context into an agent CLI invocation.

Question:
Run-dir retention: what is the lifecycle of nahel/runs/<run-id>/ (task.md, result.md) — kept forever as journal-adjacent state, distilled-then-pruned like journal segments, or gitignored ephemera?
