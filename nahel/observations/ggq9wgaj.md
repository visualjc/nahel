---
id: ggq9wgaj
name: decision-wmaqcyak
created: 2026-08-05T04:04:21Z
tags:
  - decision
  - grilling
sources:
  - tdap36rs
  - 6chta256
---
New actor+subject-scoped derivation, not a reuse of awaitingRoadmapReview: subject set = node events, map events, the map's ticket events, and notes keyed ticket=<id>; default reader = the store's human side, --reader overrides for agent-as-PO; baseline = reader's latest subject event (fallback map creation); window = strictly after in total order (ts→seq→id); rendering journals nothing.

Decided by resolving grilling ticket wmaqcyak, charting: Wayfinder-style planning works at three altitudes with granularity to match: (1) roadmap shaping — 5k ft, create/edit/move roadmap nodes like a mind map without going deep; (2) ideation — 10k ft, 'wouldn't it be cool if' PO/CEO-level brainstorm of new features; (3) feature definition — PRD-level, how a feature works and its sub-features. Each altitude gets the partner posture: grills the human for decisions only they can make, runs research/prototype tickets AFK and returns with findings, makes delegated judgment calls, and hands off to build the moment the human says 'enough to start' — no full de-fogging required.

Question:
How does the briefing compute 'since your last session' — what is the baseline, what events count, and how are same-second edges ordered?

Rationale:
Full design in PRD DD1 (docs/prds/planning-partner.md). The human-reader default exists because an AFK lane sharing the session's agent id would otherwise bury its own findings — the debrief serves the human. Ratified by PRD approval.
