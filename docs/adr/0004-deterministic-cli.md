# ADR-0004: The CLI is deterministic — judgment lives in workflows

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

Mechanical operations (state mutation, validation, dependency graphs, log rotation, sync, rendering) must be identical regardless of which LLM runs them. Semantic operations (summarization, observation extraction, authoring) require judgment. Mixing them puts API keys and vendor coupling into a tool meant to be agent-agnostic.

## Decision

The `nahel` CLI never calls an LLM and holds no credentials beyond provider mirrors. Agents never hand-edit state internals — they call the CLI. All semantic work (compaction, PRD authoring, review) happens in canonical workflows executed by host agents. `nahel validate` flags overdue semantic maintenance (e.g. uncompacted journal growth).

## Consequences

CLI is fully testable and vendor-free; degraded environments still get correct mechanics. Knowledge quality depends on workflow discipline — mitigated by validate warnings surfacing in every briefing.
