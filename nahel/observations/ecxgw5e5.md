---
id: ecxgw5e5
name: decision-e9g4rasr
created: 2026-08-09T00:23:18Z
tags:
  - decision
  - grilling
sources:
  - z0g00j2a
  - 5d6f2m96
  - 8dj8k39f
  - tze63qqf
---
Retain incomplete rows, mark them explicitly, and never infer missing provenance facts.

Decided by resolving grilling ticket e9g4rasr, charting: A human can scan every map decision in one deterministic, read-only store-wide ledger, filter it by time, actor, provenance, or map, and zoom from each row to the canonical ticket, map, and cited source records.

Question:
How should the ledger surface a decision whose provenance chain is incomplete or ambiguous?

Rationale:
The human chose visibility over silent omission or whole-view failure. A decision with an incomplete or ambiguous provenance join remains a ledger row and receives the additive incomplete badge settled by cykaxggr. The row renders only durable ticket id, map id, and decision facts that actually exist; resolver identity, timestamp, and other provenance categories are omitted when unproved rather than guessed. Compact zoom guidance points to the canonical ticket, recall observation, and nahel validate so the initial row stays compact-first while repair evidence remains reachable. A row missing its resolution event or timestamp is still eligible for the newest-10 selection. For deterministic ordering it sorts after every dated row, with multiple undated rows tied by ticket id, matching the existing map terminal-act fallback. This agent-attributed resolution relays the human decision without claiming a human actor.
