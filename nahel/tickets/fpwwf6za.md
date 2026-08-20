---
id: fpwwf6za
map: z5atxgw6
type: grilling
state: resolved
blockers: []
decision: "Run dirs are committed store state with the distill-then-prune
  lifecycle: nahel/runs/<run-id>/ travels via git, its findings are distillable
  into observations via the existing compact/distill machinery, and only
  distilled run dirs become prunable — journal paths never dangle before
  distillation. Answered live by Jim 2026-08-19."
resolution: vhk3m5mp
created: 2026-08-20T16:08:26Z
updated: 2026-08-20T16:17:46Z
---
Run-dir retention: what is the lifecycle of nahel/runs/<run-id>/ (task.md, result.md) — kept forever as journal-adjacent state, distilled-then-pruned like journal segments, or gitignored ephemera?
