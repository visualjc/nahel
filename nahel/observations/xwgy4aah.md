---
id: xwgy4aah
name: decision-tkbbn029
created: 2026-08-08T23:54:16Z
tags:
  - decision
  - grilling
sources:
  - y8mjt01d
  - be7a8pb9
---
Expose the ledger as the top-level nahel decisions command.

Decided by resolving grilling ticket tkbbn029, charting: A human can scan every map decision in one deterministic, read-only store-wide ledger, filter it by time, actor, provenance, or map, and zoom from each row to the canonical ticket, map, and cited source records.

Question:
Should the public command be top-level nahel decisions, nested nahel roadmap decisions, or reserved for a future digest surface?

Rationale:
The human explicitly chose top-level placement rather than a roadmap subcommand. This matches Nahel conventions found by research ticket t7rhbg53: cross-store read views are top-level, while roadmap nesting is for node, map, and ticket scoped operations. This agent-attributed resolution relays that human product decision without claiming a human actor.
