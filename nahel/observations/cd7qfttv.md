---
id: cd7qfttv
name: decision-4hfjsa0x
created: 2026-08-20T16:17:46Z
tags:
  - decision
  - grilling
sources:
  - fccr7mb7
  - erpnja5a
---
result.md is frontmatter + free prose: required frontmatter keys (run id, item, status/verdict enum, one-line summary) that review-loop and afk-run parse mechanically, free markdown body for the actual findings — mirroring the store's existing frontmatter-file idiom. Answered live by Jim 2026-08-19.

Decided by resolving grilling ticket 4hfjsa0x, charting: A dispatch of any size travels as a pointer prompt plus a run-dir handoff document, a worker's output comes back as a document the journal references by path, and no nahel workflow ever tells an agent to inline large context into an agent CLI invocation.

Question:
result.md conventions: what shape must a worker's result document have (frontmatter? verdict field? free prose?) for review-loop and afk-run to consume it mechanically?
