---
id: yxtmpkr9
name: decision-2ds7zgc4
created: 2026-08-20T16:17:46Z
tags:
  - decision
  - grilling
sources:
  - nch4hjrz
  - y0bm1v5m
---
The dispatch command itself writes the handoff document: it accepts the task as today (argv after --, plus a --task-file alternative), writes it with the orientation context to nahel/runs/<run-id>/task.md, and spawns the worker with a short pointer prompt (run nahel brief, read task.md, write result.md). CLI-enforced — every dispatch gets the mechanism, workflows change nothing. Answered live by Jim 2026-08-19.

Decided by resolving grilling ticket 2ds7zgc4, charting: A dispatch of any size travels as a pointer prompt plus a run-dir handoff document, a worker's output comes back as a document the journal references by path, and no nahel workflow ever tells an agent to inline large context into an agent CLI invocation.

Question:
Who writes task.md — the dispatch command itself (every dispatch gets a handoff doc, CLI-enforced) or the calling workflow (afk-run etc. write it and pass the path)?
