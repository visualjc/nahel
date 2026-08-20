---
id: p6m4hftn
name: decision-jc5x1hs7
created: 2026-08-20T16:17:46Z
tags:
  - decision
  - grilling
sources:
  - jc5167z0
  - wqkdgrkt
---
Review rounds chain by fresh task.md per round with path references: each round gets its own run dir, and round N's task.md cites round N-1's result.md by repo-relative path (reference-don't-duplicate), keeping per-round provenance separate. Answered live by Jim 2026-08-19.

Decided by resolving grilling ticket jc5x1hs7, charting: A dispatch of any size travels as a pointer prompt plus a run-dir handoff document, a worker's output comes back as a document the journal references by path, and no nahel workflow ever tells an agent to inline large context into an agent CLI invocation.

Question:
How do review rounds chain documents — does round N's brief reference round N-1's result.md by path, one growing document, or a fresh task.md per round?
