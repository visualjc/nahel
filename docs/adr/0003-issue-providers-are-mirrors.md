# ADR-0003: Issue providers are one-way mirrors, never peers

Status: accepted · Date: 2026-07-15 · Source: founding grilling session

## Context

ccpm hardcoded GitHub Issues as its database — vendor lock. True two-way sync (conflict resolution, webhooks, ID mapping) is an entire product category (Unito, Exalate). No actor in current workflows edits remotely who couldn't edit local files through an agent or git.

## Decision

Local files are canonical. Providers (GitHub, Linear, Jira, Trello, Obsidian) are one-way projections for human visibility. Work-item frontmatter carries `external_refs: [{provider, id}]` from day one. The only inbound flow: comments/mentions pulled as read-only annotations.

## Consequences

Each provider is ~a day of work; offline-safe; impossible to corrupt local truth. Revisit only if a human teammate materializes who lives in an external tracker; the interface leaves room for a `pull` capability.
