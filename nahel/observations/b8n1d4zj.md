---
id: b8n1d4zj
name: decision-y509q4e5
created: 2026-08-09T00:24:23Z
tags:
  - decision
  - grilling
sources:
  - yky4tf05
  - bctg1fp1
  - 89k0x0a1
  - 8dj8k39f
  - tze63qqf
  - z0g00j2a
---
Support --since, --by, --map, --provenance, and --limit in compact v1; defer ticket-type filtering.

Decided by resolving grilling ticket y509q4e5, charting: A human can scan every map decision in one deterministic, read-only store-wide ledger, filter it by time, actor, provenance, or map, and zoom from each row to the canonical ticket, map, and cited source records.

Question:
Which v1 filters are required beyond the intent examples of time and deciding actor?

Rationale:
The human fixed the complete compact-v1 query surface: --since for time, --by for exact or kind-level deciding actor, --map for map scope, --provenance for the settled proof-backed badges, and --limit for explicit slice control over the default newest 10. The --provenance value set is closed in v1 to direct-human, delegated, ratified, agent, and incomplete, using the predicates settled by cykaxggr and e9g4rasr. cross-agent-grilled is not offered because fvb6ceqv found no typed proof marker; prose or multiple agent sources cannot establish it. Ticket type is durable but --ticket-type is deferred from compact v1 because no current human query need justifies another control. This preserves compact-first/query-more without promising semantics the store cannot prove. This agent-attributed resolution relays the human decision without claiming a human actor.
