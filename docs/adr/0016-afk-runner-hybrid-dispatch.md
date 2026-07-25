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

## Addendum — invocation-config shape (2026-07-25)

Resolves PRD `phase-2-afk-engine` open question 3, decided while building F1.

**Shipped defaults in code, overridable per entry in config.** Invocation
knowledge is a table keyed by a fixed agent-kind enum
(`claude | codex | cursor-agent`, `schema/enums.ts`): each kind ships the real
headless form of its CLI — `claude -p --model <model> <prompt>`,
`codex exec --model <model> <prompt>`,
`cursor-agent -p --model <model> <prompt>` — and the optional `config.dispatch`
section replaces any entry wholesale (`{binary, args, model_flag?}`), matching
`config set`'s replace-the-section semantics. Pure config with no defaults was
rejected: every project would have to hand-write the same three entries before
its first dispatch, and a typo would surface as a mis-spawn rather than as a
missing route.

The prompt is always the TRAILING argument — true of all three CLIs — so there
is deliberately no prompt-delivery field (no stdin mode) until a real agent CLI
needs one.

`config.dispatch` is a strict object over the kind enum, so an unknown agent
kind is a schema error from `nahel validate` and from dispatch itself, as the
PRD bounds require. Routing's `agent` stays a free string (Phase 1 schema,
unchanged), which makes dispatch the second gate: a routing map naming an agent
CLI with no invocation entry is refused at dispatch time, listing the kinds
nahel knows. Teaching nahel a new agent CLI is therefore a deliberate schema
change (enum + default), never an accidental config key — ADR-0015's
vocabulary discipline applied to executors.
