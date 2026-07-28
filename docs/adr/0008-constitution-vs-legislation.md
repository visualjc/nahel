# ADR-0008: Governance — constitution vs. legislation, delegable per project

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

A persona without durable knowledge is vibes with a title. The maintainer wants to be the product owner on some projects and fully hand off PO/architect roles on others — but domain facts and project goals must never be "improved" by agents.

## Decision

Product/architecture truth splits: **constitution** (goal, domain facts, hard constraints, non-goals — human-seeded, immutable without human sign-off in every mode) vs. **legislation** (priorities, PRD approvals, ADRs, architecture evolution). Per-project config: `governance: {product: human|delegated, architecture: human|delegated}`. Delegated legislation requires 2-of-N cross-vendor consensus, append-only decision records, and human-audit digests. Roles (PO, architect) are agent-neutral charters reviewing at artifact gates, not continuously; in AFK runs a reject parks the item, never stalls the run, never gets overridden. Inception is tiered (`seed|standard|full`, brownfield mines first) and gates autonomy only.

## Consequences

Walk-away projects are possible without agents drifting product identity; the constitution is the alignment anchor every briefing loads.

## Addendum — 2026-07-25: constitution composition under a hands-off founding

Phase 2 F9.5 adds a founding mode in which the human's entire input is one paragraph (`nahel init --hands-off "<paragraph>"`, recorded as `config.founding`). The constitution/legislation split above is unchanged; this addendum states where the line falls when the constitution document is DRAFTED by an agent:

- The human-signed constitutional content is the paragraph, **verbatim**, and nothing else. The human-attributed `config.updated` act that recorded it is its signature — an agent-run founding act signs nothing.
- The agent's elaboration (domain facts, hard constraints, non-goals derived from the paragraph) lives in the constitution document below the signed paragraph, explicitly marked **UNCONFIRMED**. It is agent-drafted knowledge and **never constitutional text**: AFK work may rely on it as a parkable assumption, never as an un-overridable rule.
- The human promotes any of it into the constitution later **by signing** it. Until then it is amendable through the ordinary legislation path; the signed paragraph is not — constitution amendments stay undelegable in every governance mode.
- The elaboration is verified with the delegated-legislation provenance shape (cross-vendor, separately actor-attributed, bound to an exact revision of the founded artifact set). Consensus authorizes legislation-layer content only; it can neither sign the paragraph nor amend it. A failed or missing verification, or a paragraph too thin to yield a coherent goal, refuses the `standard` tier rather than papering over the gap.

Procedure: `nahel/workflows/inception.md`.
