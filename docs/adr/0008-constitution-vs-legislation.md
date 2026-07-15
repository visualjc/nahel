# ADR-0008: Governance — constitution vs. legislation, delegable per project

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

A persona without durable knowledge is vibes with a title. The maintainer wants to be the product owner on some projects and fully hand off PO/architect roles on others — but domain facts and project goals must never be "improved" by agents.

## Decision

Product/architecture truth splits: **constitution** (goal, domain facts, hard constraints, non-goals — human-seeded, immutable without human sign-off in every mode) vs. **legislation** (priorities, PRD approvals, ADRs, architecture evolution). Per-project config: `governance: {product: human|delegated, architecture: human|delegated}`. Delegated legislation requires 2-of-N cross-vendor consensus, append-only decision records, and human-audit digests. Roles (PO, architect) are agent-neutral charters reviewing at artifact gates, not continuously; in AFK runs a reject parks the item, never stalls the run, never gets overridden. Inception is tiered (`seed|standard|full`, brownfield mines first) and gates autonomy only.

## Consequences

Walk-away projects are possible without agents drifting product identity; the constitution is the alignment anchor every briefing loads.
