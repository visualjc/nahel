---
id: ezbwb49v
name: decision-amr4evsg
created: 2026-08-05T04:04:22Z
tags:
  - decision
  - grilling
sources:
  - e26f2cfa
  - 6chta256
---
plan-frontier.md is a STANDALONE lane invoked directly against one map (human, cron/harness scheduler, or future orchestrator) — not dispatched by afk-run this delta; attribution needs no Run: every act is a journaled CLI mutation under the lane's agent:* actor, research notes carry ticket=<id>. afk-run/ticket-scoped dispatch is the recorded successor delta.

Decided by resolving grilling ticket amr4evsg, charting: Wayfinder-style planning works at three altitudes with granularity to match: (1) roadmap shaping — 5k ft, create/edit/move roadmap nodes like a mind map without going deep; (2) ideation — 10k ft, 'wouldn't it be cool if' PO/CEO-level brainstorm of new features; (3) feature definition — PRD-level, how a feature works and its sub-features. Each altitude gets the partner posture: grills the human for decisions only they can make, runs research/prototype tickets AFK and returns with findings, makes delegated judgment calls, and hands off to build the moment the human says 'enough to start' — no full de-fogging required.

Question:
How does the AFK plan-frontier lane run — standalone or dispatched, and what owns/attributes its work given dispatch is item-scoped?

Rationale:
Full design in PRD DD4. Dispatch and Runs are work-item-scoped by construction (ADR-0016) and product/initiative maps may have no item; extending dispatch scope is real machinery deferred deliberately. Scheduling is the harness's job (PRD F5 Scheduling section) — nahel has no daemon. Ratified by PRD approval.
