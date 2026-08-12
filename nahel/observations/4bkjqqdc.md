---
id: 4bkjqqdc
name: decision-p2mre2cg
created: 2026-08-09T00:16:55Z
tags:
  - decision
  - grilling
sources:
  - f2tne3qk
  - a6cbkqta
  - 8dj8k39f
---
Include resolved tickets only; exclude every closure disposition from the v1 ledger.

Decided by resolving grilling ticket p2mre2cg, charting: A human can scan every map decision in one deterministic, read-only store-wide ledger, filter it by time, actor, provenance, or map, and zoom from each row to the canonical ticket, map, and cited source records.

Question:
Should v1 include only resolved map tickets, or also closed out-of-scope and invalidated dispositions?

Rationale:
The human chose a strict decision boundary: a v1 ledger row exists only for a resolved ticket carrying a decision. Tickets closed as out of scope, invalidated, or by any other closure disposition are rulings about unanswered questions, not decisions for this ledger, so they remain available through their canonical ticket and recall surfaces but do not enter selection, ordering, or the newest-10 count. Research ticket fvb6ceqv supports this boundary: roadmap.ticket-resolved events and resolved ticket records carry the durable one-line decision and resolution source graph, while roadmap.ticket-closed records intentionally carry reason, closure, and optional invalidated_by with no decision. This agent-attributed resolution relays the human decision without claiming a human actor.
