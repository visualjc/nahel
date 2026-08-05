---
id: gehpkptf
name: decision-e77g2yge
created: 2026-08-05T00:43:07Z
tags:
  - decision
  - grilling
sources:
  - zv51g6by
---
Pin grilling + domain-modeling from mattpocock/skills at a SHA via the existing skills.yaml/lock machinery; his repo is canonical, not local copies. Do NOT vendor wayfinder, grill-with-docs, research, or prototype. Requires the locateSkill fix for the skills/engineering/ subdir.

Decided by resolving grilling ticket e77g2yge, charting: Wayfinder-style planning works at three altitudes with granularity to match: (1) roadmap shaping — 5k ft, create/edit/move roadmap nodes like a mind map without going deep; (2) ideation — 10k ft, 'wouldn't it be cool if' PO/CEO-level brainstorm of new features; (3) feature definition — PRD-level, how a feature works and its sub-features. Each altitude gets the partner posture: grills the human for decisions only they can make, runs research/prototype tickets AFK and returns with findings, makes delegated judgment calls, and hands off to build the moment the human says 'enough to start' — no full de-fogging required.

Question:
Which external skills get vendored, from where, and whose copy is canonical?

Rationale:
chart-map and work-map ARE our wayfinder — vendoring his would put two competing conductors in the repo. grill-with-docs is one line delegating to the two skills we do pin. His research/prototype skills would fight our stricter research posture and prototype lane (prototypes never merge). Pinning from his repo keeps a fresh clone reproducible with zero dependence on anyone's home directory; locateSkill today searches only the repo root and skills/, so restore against skills/engineering/<name> fails without the fix.
