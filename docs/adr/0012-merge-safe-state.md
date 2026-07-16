# ADR-0012: State is merge-safe across parallel worktrees

Status: accepted · Date: 2026-07-15 · Source: schema v1 domain-modeling session

## Context

Nahel's execution model runs multiple AFK agents in parallel git worktrees whose branches merge later (ADR-0002: git is the transport). Any state design that assumes a single writer — sequential ID counters, one append-only journal file — produces merge conflicts or silent corruption exactly in the flagship scenario. ccpm inherited both problems from GitHub issue numbers and monolithic progress files.

## Decision

Three interlocking choices, all serving merge-safety:

1. **Work item IDs are short random identifiers**, generated at creation, never sequential. The slug is display; mirrors carry the pretty number (e.g. GitHub issue #). All internal references use the ID.
2. **The journal is segmented per run** (plus segments for non-run events): each run appends only to its own JSONL segment file, so concurrent branches touch disjoint files and merge cleanly. Reading merges segments by timestamp. Every event carries a unique ID stable across rotation, so observation provenance links never rot.
3. **Hot state is scoped to the run** (`state.json` per run record), never shared per-item, so concurrent runs cannot clobber each other.

Alternatives rejected: sequential IDs with merge-time renumbering (breaks every existing reference), single journal with a `.gitattributes` union merge driver (driver not guaranteed on every clone/host; a broken merge corrupts the canonical record).

## Consequences

Parallel worktrees merge without state conflicts by construction. Costs: IDs are not human-memorable (humans use slugs; mirrors provide friendly numbers), and reading the journal requires a CLI merge step instead of `cat` — acceptable since prose views are rendered anyway (ADR-0006).
