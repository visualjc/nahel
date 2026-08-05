---
id: akyh3egs
name: decision-5rb9n6ep
created: 2026-08-05T04:04:22Z
tags:
  - decision
  - grilling
sources:
  - sqpf1mjn
  - 6chta256
---
Optional boolean human_only on ticket frontmatter (absent=false), set by anyone via --human-only, cleared only by a human; under any agent:* actor, resolve, close, AND clear-human-only are CLI-refused; rendered in frontier, map show, ticket show; rides existing ticket events.

Decided by resolving grilling ticket 5rb9n6ep, charting: Wayfinder-style planning works at three altitudes with granularity to match: (1) roadmap shaping — 5k ft, create/edit/move roadmap nodes like a mind map without going deep; (2) ideation — 10k ft, 'wouldn't it be cool if' PO/CEO-level brainstorm of new features; (3) feature definition — PRD-level, how a feature works and its sub-features. Each altitude gets the partner posture: grills the human for decisions only they can make, runs research/prototype tickets AFK and returns with findings, makes delegated judgment calls, and hands off to build the moment the human says 'enough to start' — no full de-fogging required.

Question:
What is the schema and enforcement shape of the human-only ticket flag — including who may clear it?

Rationale:
Full design in PRD DD2. Restricting a ticket is always safe so anyone may set; the clear-restriction closes the clear-then-resolve hole codex found in round 1. Ratified by PRD approval.
