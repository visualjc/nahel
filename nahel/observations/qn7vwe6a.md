---
id: qn7vwe6a
name: decision-qgpkxfj2
created: 2026-08-08T23:49:24Z
tags:
  - decision
  - grilling
sources:
  - 7gwpjaze
  - 2sfx4c8t
---
Ship stable compact human-readable text only in v1; defer machine-readable output.

Decided by resolving grilling ticket qgpkxfj2, charting: A human can scan every map decision in one deterministic, read-only store-wide ledger, filter it by time, actor, provenance, or map, and zoom from each row to the canonical ticket, map, and cited source records.

Question:
Does v1 require machine-readable output, or is stable human-readable text the complete first-delta contract?

Rationale:
The human chose compact-first/query-more: users and LLMs obtain depth through filters and source zoom instead of receiving the whole history. The row model must keep clean semantics so a later machine-readable format can reuse it, but JSON is not part of this delta. This agent-attributed resolution relays that human product decision without claiming a human actor.
