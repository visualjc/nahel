---
id: frndre4f
name: decision-fvb6ceqv
created: 2026-08-09T00:14:40Z
tags:
  - decision
  - research
sources:
  - 8dj8k39f
  - af8y8ywf
  - c65fw1w5
---
Resolution events and embedded observations preserve the core row and source graph; provenance labels must stay actor- and source-backed.

Decided by resolving research ticket fvb6ceqv, charting: A human can scan every map decision in one deterministic, read-only store-wide ledger, filter it by time, actor, provenance, or map, and zoom from each row to the canonical ticket, map, and cited source records.

Question:
Which existing ticket, journal, and observation fields can deterministically reconstruct one decision row and its provenance after ticket distillation and journal compaction?

Rationale:
The canonical resolution event is the strongest row anchor. Its envelope supplies the deciding actor and canonical ts-seq-id order; its sequence payload supplies the ticket id, map id, ticket type, state, one-line decision, resolution id, full original question, and the generated decision observation. That observation supplies the decision fact, destination, rationale, type tags, and ordered source event ids. The materialized ticket remains a durable index after ticket distillation because every frontmatter field survives and only its body is emptied. Archived journal compaction does not remove the resolution event: it creates observations and marker files while readJournal continues reading both active and archived segments. Stable map identity is therefore provable; a current display name can be joined from map/node records, but historical rename rendering remains the map fog already recorded. For p2mre2cg, recommend resolved tickets only: close events intentionally carry a reason/disposition and no decision, and current Decisions so far derives only state=resolved plus decision. For cykaxggr, recommend separate exact resolver identity from additive proof badges: direct-human when the resolution actor is human; delegated when an agent resolution cites a human-attributed event, matching validate DD6; ratified when a later human logged note names the ticket; agent otherwise; incomplete when required joins fail. Ticket type is a separate fact. Existing fields cannot truthfully prove cross-agent grilling: different-agent source refs can equally be research, and arbitrary note payload prose is not typed proof. If that badge/filter is required, the later design must add or bless a typed deterministic marker rather than infer it. For e9g4rasr, recommend rendering a compact incomplete row from whatever durable ticket facts exist, never inventing actor, time, or provenance, and pointing to ticket/recall/validate; silently dropping it violates the all-decisions destination, while failing the whole read hides healthy rows. The human still must decide how an undated incomplete row interacts with newest-10 selection; existing map ordering puts missing terminal events after dated rows and ties by ticket id. For y509q4e5, recommend required v1 controls --map, --provenance, and --limit beside settled --since and --by; provenance filters must use only the provable categories above. --ticket-type is supported by durable data but optional for compact v1, and cross-agent must not be exposed until proof is typed. Live evidence strengthens the caution: all 23 current resolution actors are agents and none cites a human-attributed source, even though several agent-written notes say they relay human decisions; reporting those as human-made would impersonate provenance the store does not carry.
