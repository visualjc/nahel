---
id: 2ds7zgc4
map: z5atxgw6
type: grilling
state: resolved
blockers: []
decision: "The dispatch command itself writes the handoff document: it accepts
  the task as today (argv after --, plus a --task-file alternative), writes it
  with the orientation context to nahel/runs/<run-id>/task.md, and spawns the
  worker with a short pointer prompt (run nahel brief, read task.md, write
  result.md). CLI-enforced — every dispatch gets the mechanism, workflows change
  nothing. Answered live by Jim 2026-08-19."
resolution: nch4hjrz
created: 2026-08-20T16:08:26Z
updated: 2026-08-20T16:17:46Z
---
Who writes task.md — the dispatch command itself (every dispatch gets a handoff doc, CLI-enforced) or the calling workflow (afk-run etc. write it and pass the path)?
