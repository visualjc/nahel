---
id: n6rsem9e
name: qa-red-by-mutation
created: 2026-08-20T20:32:41Z
tags:
  - qa
  - tdd
  - mutation-testing
  - doctrine
sources:
  - cg5hczem
  - avftpzxq
---
For a QA item testing already-shipped code, the red half of red-first cannot be a failing-first test without breaking product code. The doctrine used for the dispatch-handoff exit test: earn red by MUTATION — introduce deliberate product defects, confirm the new test catches each, revert. Three mutations proved the 320KB exit test: task-doc body truncation (caught by the stub worker's own truncation guard), journaling task content instead of the path (caught by the sentinel assertion), and re-inlining the task into the prompt (caught by the argv bound). A QA test whose red was never earned proves only that it passes.
