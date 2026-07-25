# 0016 — AFK runner: deterministic dispatch verb, judgment in a host-agent workflow

Date: 2026-07-24
Status: accepted

## Context

Phase 2 builds the AFK engine. The Phase 1 exit test was orchestrated by hand:
a host agent (Fable session) made every judgment call — scoping, lane picks,
review timing, acceptance — while spawning worker agents per the routing map.
That pattern shipped four reviewed PRs. The alternatives for codifying it:
a pure CLI process-supervisor (`nahel afk` plans waves, spawns and restarts
agents — a scheduler inside the deterministic CLI, with per-agent-CLI
invocation quirks baked into nahel code), or a pure workflow document with no
new CLI surface (routing stays advisory; kickoff is manual).

## Decision

Hybrid. A new deterministic CLI verb — `nahel dispatch` — owns the MECHANICS:
resolve the routing map for a responsibility, compose the correct agent-CLI
invocation (binary, model flags, actor env), spawn it, and record the run.
The LOOP and all judgment — scope discovery, lane selection, wave ordering,
when to review, when to stop, when to park — live in a canonical afk-run
workflow executed by a host agent. Any capable agent can be the runner; the
CLI never decides, only executes decided dispatches.

Companion Phase 2 requirements decided in the same session (PRD-bound, not
architecture): the review loop codifies the two-reviewer cross-vendor pattern
with HEAD validation and a 3-iteration cap; merge authority is per-project
config (`merge: human` default, `merge: on-approve` opt-in); verify-by-driving
uses host browser tooling with journaled evidence and PARKS when the host
cannot drive; the runner respects claims/pauses at every checkpoint boundary.

## Consequences

- Process-spawning stays within the store layer's existing exclusive-privilege
  discipline (the baseline/healthcheck/skills precedent) — dispatch joins the
  allowlist deliberately.
- Routing enforcement (ADR-0015's Phase 2 half) lands in dispatch, one place.
- A long-lived host session is required for an AFK run; scheduling/restart of
  the host itself stays outside nahel (transport concern, not state concern).
- Per-agent-CLI invocation knowledge concentrates in dispatch and is config,
  not scattered workflow prose.
