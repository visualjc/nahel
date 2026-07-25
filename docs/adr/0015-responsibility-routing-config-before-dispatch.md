# 0015 — Responsibility routing: committed config in Phase 1, dispatch in Phase 2

Date: 2026-07-21
Status: accepted

## Context

Different responsibilities are best served by different agent CLIs and models
(the working policy: Fable-class models for architecture, review, and store
semantics; Opus-class for tightly spec'd implementation). That policy lived in
per-agent memory — invisible to other tools, unenforceable, and lost on a
fresh machine. Prior art: Cursor pstack's setup writes a role→model rule
(code / judgment / review) from detected models. Alternatives considered:
free-form responsibility keys (unvalidatable vocabulary), routing by work-item
type or lane (cannot express "Fable plans it, Opus codes it" within one item),
deferring everything to Phase 2, or anchoring routing to Phase 4 role charters.

## Decision

A `routing` section in schema-validated `nahel/config` maps a small fixed
enum of responsibilities — `architecture | implementation | review` — to
optional `{agent, model}` pairs, plus a default. A setup workflow detects
available agent CLIs and models and writes the section.

Phase 1 the map is **advisory**: `nahel brief` surfaces it and sessions are
expected to honor it (e.g. spawning implementation subagents on the mapped
model). Phase 2's AFK dispatcher **enforces** it when nahel launches
executors itself.

## Consequences

- The routing policy is committed, portable state — any tool reads the same
  map; a fresh clone inherits it.
- The responsibility vocabulary is shared and validated; extending the enum
  is a schema change, deliberate rather than accidental.
- Advisory-first means Phase 1 compliance depends on host agents reading the
  brief; violations are journal-auditable but not blocked.
- Role charters (Phase 4) will reference responsibilities rather than
  redefine executor selection.

## Addendum — the second review slot (2026-07-25)

Resolves PRD `phase-2-afk-engine` F3.1's design call ("a reviewer list under
the `review` responsibility or a second review slot"), decided while building
the review loop's config surface.

**A `review2` routing KEY, not a fourth responsibility.** The review loop needs
two reviewer VENDORS and one `review` key names one, so `config.routing` gains
an optional `review2` entry of the same `{agent, model}` shape. It sits beside
`default` as a key that is deliberately not dispatchable: `nahel dispatch
review2` is refused, because slot 2 is reviewed by the loop's DRIVER under its
own actor and nothing spawns it. The responsibility enum is therefore
unchanged, and the vocabulary discipline above holds.

A reviewer LIST under `review` was rejected: it reads as "dispatch these two",
which is exactly what slot 2 is not, and it would make `resolveRoute`'s single
answer ambiguous. Optionality is load-bearing — maps written before this key
existed stay valid, and the workflow falls back to its runtime rule (the other
vendor the map already names under `implementation`/`default`).

Consequence: the reviewer pairing is checkable from committed state.
`nahel validate` warns (`routing.review-same-vendor`) when both resolved slots
land on one vendor, moving a refusal that used to land mid-loop to setup time.

## Amendment — slot 2 is dispatchable (2026-07-25, final review)

"Nothing spawns slot 2" was too strong, and it cost agent-neutrality: pinning
the slot to the loop's DRIVER meant only `routing.review2`'s own vendor could
run the review loop at all, and every other capable host had to park —
contradicting the any-agent-can-run premise the workflow opens with.

Slot 2 is therefore dispatchable, through the `review` responsibility on its
own resolution chain: `nahel dispatch review --slot 2`. The decision above is
unchanged in substance — `review2` remains a routing KEY, the responsibility
enum still carries exactly one `review`, and `nahel dispatch review2` is still
refused. What `--slot` selects is which chain `review` resolves through
(`review2` → `implementation` → `default` for slot 2), so each chain still has
one unambiguous answer. The chains live in one place
(`REVIEW_SLOT_CHAINS`), shared by the dispatch route and the
`routing.review-same-vendor` warning, so the check can never predict a pairing
the dispatch would not produce. A driver whose own vendor IS the slot's agent
still reviews in-session under its own actor; any other driver dispatches it,
which is what keeps the second verdict attributed to the vendor the map names.
