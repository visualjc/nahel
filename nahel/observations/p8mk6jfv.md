---
id: p8mk6jfv
name: handoff-design-rulings
created: 2026-08-20T20:32:21Z
tags:
  - dispatch
  - handoff
  - design
  - retention
  - result-doc
sources:
  - y0bm1v5m
  - g7ss8d7p
  - erpnja5a
  - wqkdgrkt
  - gbmpwayh
  - 8aq25wex
---
The four dispatch-handoff design questions were answered by Jim live (structured dialog, 2026-08-19), all four with the agent's recommendation: (1) the dispatch COMMAND writes task.md — CLI-enforced so every caller is fixed with zero workflow changes; (2) run dirs are COMMITTED store state on the distill-then-prune lifecycle, same as journal segments, so journaled paths never dangle before distillation (prune tooling deliberately unbuilt); (3) result.md is frontmatter + free prose — required keys run/item/status(success|failure|partial)/summary(one line), body unconstrained; (4) review rounds chain by FRESH task.md per round referencing the prior round's result.md by path, reference-don't-duplicate. Canonized in afk-run, review-loop, inception, and plan-frontier prose in the same change that shipped the mechanism.
