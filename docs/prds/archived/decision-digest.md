---
name: decision-digest
created: 2026-08-09T00:29:14Z
updated: 2026-08-09T00:57:51Z
---

> **Archived — the delta this PRD stated is closed.**
>
> - Release: released 0.4.2 2026-08-18T04:26:00Z
> - Epic: 9qskgzv1 — roadmap node decision-digest (0f07w6gn)
> - Journal: archived by event xx52dzmz
>
> The code and tests are the truth now — this PRD is never reopened and
> never edited. Further work on this feature is a new node with a new PRD,
> which may name this one as its predecessor.

# PRD: Decision Digest

Roadmap node: `decision-digest` (0f07w6gn) · Map: 0ty003v6 · Plan item: 4318wy9h

This PRD is authored from the node's charted map. Each settled product
decision below cites the resolved ticket that carries its rationale; use
`nahel roadmap ticket show <id>` or `nahel recall <id>` to zoom to that
record. The cut check found no unresolved question inside this delta.

## Goal

Give humans and agents a deterministic, read-only, store-wide ledger of
resolved map decisions through `nahel decisions`. The default view stays
compact enough for orientation, while filters and executable zoom paths expose
more history and provenance without filling model context with the whole store.

## Settled decisions

- **Command placement** (tkbbn029): expose the ledger as the top-level
  `nahel decisions` command.
- **Output contract** (qgpkxfj2): v1 emits stable, compact, human-readable text
  only. Row semantics remain clean enough for a later machine format, but JSON
  is not part of this delta.
- **Default slice** (jfj0hpre): retain the newest 10 matching decisions when
  more than 10 exist.
- **Ordering** (kq1k56ey): select the newest compact slice first, then render
  that slice chronologically oldest to newest, using `ts → seq → id` ties.
- **Existing conventions** (t7rhbg53): reuse Nahel's relative/ISO time-window
  parsing, actor spelling, canonical ordering, positive limits, top-level read
  verbs, stable IDs, and executable zoom hints.
- **Read-cost boundary** (zf0n1nbp): use a bounded newest-N collector, while
  acknowledging that v1 still scans lifetime journal history and pays segment
  fan-out cost. The limit is a presentation bound, not a performance guarantee.
- **Included records** (p2mre2cg): include resolved map tickets only. Exclude
  out-of-scope, invalidated, and all other closure dispositions because they
  are not ledger decisions.
- **Durable row source** (fvb6ceqv): reconstruct rows from durable ticket,
  resolution-event, decision-observation, and source-event facts that survive
  ticket distillation and journal compaction.
- **Provenance presentation** (cykaxggr): display exact resolver identity
  separately from multiple additive provenance badges, and render a badge only
  when structured store facts prove it.
- **Incomplete provenance** (e9g4rasr): retain incomplete rows, mark them, show
  only durable facts, and never invent a missing resolver, time, or category.
- **Filters** (y509q4e5): v1 supports `--since`, `--by`, `--map`,
  `--provenance`, and `--limit`. Ticket-type filtering is deferred.
- **Recall help** (16h326qp): ship the small quoted-phrase usage hint for
  `nahel recall` because recall is a ledger source-zoom path.

## Cut check

All 12 map tickets are resolved, the map has no remaining fog, and its frontier
is empty. No unresolved question remains inside this delta.

Three former fog lines are outside this delta and have separate later-horizon
feature nodes linked back through `predecessor=decision-digest`:

- Large-history ergonomics after real usage evidence —
  `decision-digest-large-history-ergonomics` (2p91x87w), covering indexing,
  reverse selection, segment fan-out reduction, or another measured approach.
- Cross-store/project aggregation — `decision-digest-cross-store-ledger`
  (as05a50f), covering discovery, authorization, deterministic cross-source
  ordering, and source zoom.
- Historical-name rendering after roadmap renames —
  `decision-digest-historical-name-rendering` (7bwb9j1f). V1 instead renders
  current human-readable titles with canonical stable IDs and source zoom
  (human scope note 68wkd2vp; supported by t7rhbg53 and fvb6ceqv).

## Non-goals

- Editing, resolving, ratifying, or otherwise mutating decisions from the
  ledger.
- Non-map decisions such as ADR approvals, PRD approvals, merges, and
  deployment events.
- Out-of-scope, invalidated, or other closed ticket dispositions in the
  decision row set.
- JSON or another machine-readable output mode in v1.
- `--ticket-type` filtering or a `cross-agent-grilled` provenance filter.
- LLM-generated summaries, semantic clustering, or inferred provenance.
- Repeating full rationale or source bodies in each row.
- Large-history indexing, reverse selection, or segment fan-out optimization.
- Aggregation across multiple Nahel stores or projects.
- Historical display-name reconstruction after roadmap node or map renames.
- External tracker mirrors or a web UI.
- Restructuring global help, changing existing commands' help, adding a new
  workflow/shim, or broadening `nahel brief`, README, or agent instruction
  files. Discovery work is limited to the new command's registry line and its
  own help/output surfaces.

## Functional requirements

### F1 — Read-only `nahel decisions` surface and minimal discovery

Add `nahel decisions` as a top-level deterministic read command. Its successful
and refused invocations must not append journal events or mutate any store
record. Register exactly one concise `decisions` line in `nahel help` so an
agent scanning the existing command list can discover the compact, read-only
decision ledger. Do not reorganize, rename, or rewrite any other global-help
entry (tkbbn029, qgpkxfj2, y509q4e5).

*Acceptance:* CLI tests pin top-level registration and the new registry
description. The existing global-help golden changes only by insertion of the
`decisions` row. A fixture store's files and journal event count are
byte-for-byte unchanged after default, filtered, empty-result,
`--help`/`-h`, and invalid-argument invocations. Output is stable
human-readable text; no JSON flag exists.

### F2 — Decision row reconstruction and compact rendering

Build one candidate row for each resolved map ticket. A healthy row renders its
one-line decision, ticket ID, current map/node title with canonical stable ID,
resolution time, exact resolver actor, and provable provenance badges. Closed
tickets of every disposition are excluded. Row reconstruction must still work
after the ticket body is distilled and its resolution event is archived because
the materialized ticket, resolution event, embedded decision observation, and
source graph retain the canonical facts (p2mre2cg, fvb6ceqv).

Reconstruct every candidate from the current durable store on every invocation;
the ledger has no cached/materialized row lifecycle of its own. The resolved
ticket ID is the row identity. If a previously missing event or join becomes
available after repair, the next invocation enriches that same ticket's row
with the newly provable actor, time, title, source, and provenance facts and
removes `incomplete` when no required join remains missing. It never emits an
old incomplete snapshot beside a second "complete" row for the same ticket.

Use a compact shared footer—not repeated prose on every row—to give executable
zoom commands for `nahel roadmap ticket show`, `nahel roadmap map show`, and
`nahel recall`. Follow the existing roadmap-view convention: each hint is
`↳ <command>  — <what it shows>`, uses concrete IDs or safe refs from a rendered
row rather than placeholders, and succeeds when copied verbatim.

*Acceptance:* fixture coverage includes resolved research, prototype, grilling,
and task tickets; every close disposition; a distilled ticket body; archived
resolution events; and multiple maps. Golden output proves only resolved rows
appear, current titles are paired with stable IDs, and each footer command can
be executed verbatim against the shown ticket/map. The recall hint uses the
concrete ticket ID, which deterministically reaches its `decision-<ticket>`
observation and source-event IDs.

A two-pass fixture first renders one resolved ticket with a missing join as
exactly one `incomplete` row, then restores that durable event/link and invokes
the command again. The second output contains exactly one row with the same
ticket ID, now carrying the repaired provable fields/badges and no stale
duplicate. `--provenance incomplete` matches it before repair and not after.

### F3 — Compact newest slice and deterministic order

Apply all requested filters before limiting. With no explicit `--limit`, retain
the newest 10 matching dated decisions. Select newest N using a bounded
collector, then render the selected rows oldest to newest. Dated ordering is the
store's canonical `ts → seq → id` total order (jfj0hpre, kq1k56ey, zf0n1nbp).

An eligible row lacking its resolution event or timestamp remains in the
selection. Undated rows sort after dated rows and tie by ticket ID. When the
newest-10 boundary contains incomplete undated rows, this same ordering defines
the retained slice rather than silently dropping them (e9g4rasr).

*Acceptance:* tests cover 0, 1, 10, and more than 10 matches; same-timestamp
`seq`/`id` ties; filter-before-limit behavior; explicit limits; and multiple
undated rows. More than 10 candidates produce exactly the newest 10 under the
settled order and display those 10 oldest to newest.

### F4 — Filter semantics

- `--since` accepts the relative whole-hour/day and ISO UTC forms already used
  by Nahel timeline reads.
- `--by` accepts exact `kind:id[:session]` actor spelling and the kind-level
  `human` or `agent` selectors required for aggregation.
- `--map` accepts the map's stable ID or its roadmap node's stable ID/slug,
  following existing roadmap reference resolution.
- `--provenance` accepts only `direct-human`, `delegated`, `ratified`, `agent`,
  and `incomplete`.
- `--limit` requires a positive integer and overrides the default 10.

Filters combine by intersection. Invalid windows, actors, references,
provenance values, and limits refuse with actionable usage text. No
`--ticket-type` or `cross-agent-grilled` option exists in v1 (t7rhbg53,
y509q4e5). Every usage refusal ends with the focused usage line and a
`nahel decisions --help` pointer; it does not dump or alter unrelated help.

*Acceptance:* table-driven CLI tests cover each filter alone, intersections,
empty results, exact and kind-level actors, both accepted time forms, map
reference forms, every provenance value, and each invalid input class.

### F5 — Exact actor and proof-backed provenance

Resolver identity comes only from the resolution event actor and renders as the
exact actor string. Provenance badges are additive and use these predicates
(cykaxggr, fvb6ceqv):

- `direct-human`: resolution actor is human.
- `delegated`: an agent resolution cites a human-attributed source event.
- `ratified`: a strictly later human note names the exact ticket.
- `agent`: resolution actor is an agent and no cited-human delegation is
  proved.
- `incomplete`: any required join for otherwise expected row/provenance facts
  fails; this badge may coexist with another proved badge.

Never infer human authorship, delegation, ratification, or cross-agent grilling
from prose, actor counts, or different-agent source references.

*Acceptance:* provenance fixtures prove each predicate, additive combinations,
strictly-later ratification, a same/earlier human note that does not ratify,
agent prose claiming a human decision that remains `agent`, and different-agent
sources that do not create an unsupported badge. `--provenance` matches rows
carrying the selected badge without hiding their other badges.

### F6 — Incomplete rows remain visible

If joins fail, preserve any durable ticket ID, map ID, and decision fact. Add
`incomplete`; omit unproved resolver, timestamp, title, or other category rather
than guessing. Supply compact zoom toward the ticket, recall observation, and
`nahel validate` so users can inspect or repair the missing link (e9g4rasr).
`incomplete` is a derived description of the current read, not sticky ledger
state: repaired durable evidence upgrades the row on the next invocation.

*Acceptance:* corruption-boundary fixtures independently remove the resolution
event, map/node join, observation, actor, and timestamp where the store model
permits. Each surviving decision remains visible with only proved fields,
`incomplete`, deterministic placement, and working inspection guidance; healthy
rows in the same read still render normally. A repair-and-reread test proves the
row becomes healthy without any Decision Digest mutation, persisted cache, or
duplicate row.

### F7 — Recall quoted-phrase help

The `nahel recall` usage/help path includes a short example showing how a quoted
phrase narrows source zoom from a decision row (16h326qp).

*Acceptance:* a focused help-output test pins the quoted-phrase hint, and the
shown invocation successfully finds a matching decision observation in a test
store.

### F8 — Feature-local agent orientation and command help

`nahel decisions --help` and `nahel decisions -h` are the complete
agent-facing instruction surface for this read command. They exit 0 without
opening a store and explain, in this order:

1. The full usage line with only the five v1 flags.
2. The safety contract: this command is read-only, writes nothing, and journals
   nothing.
3. The compact starting behavior: bare `nahel decisions` selects the newest 10
   matching decisions and displays that retained slice oldest to newest.
4. Each flag's accepted values and purpose, including relative/ISO `--since`,
   exact or kind-level `--by`, map ref forms, the closed provenance-badge set,
   and positive `--limit`.
5. Copyable examples for starting compact, narrowing by time/actor/map/
   provenance, and widening with `--since` and `--limit`.
6. The evidence path: run the command, then follow its concrete ticket, map,
   and recall `↳` hints; use `nahel validate` when a row is `incomplete`.

Every successful rendering begins with a compact summary that states how many
matching decisions are shown, the active limit, the oldest-to-newest display
direction, and whether older matches were omitted. It ends with one executable
`↳ nahel decisions --help  — filter or widen this ledger` hint plus the concrete
evidence-zoom hints from F2 when at least one row exists. An empty result says
that no decisions matched and points to the same focused help for relaxing or
widening filters; it never fabricates a ticket/map zoom target.

This feature does not add an agent workflow or installed shim: existing Nahel
conventions reserve those for judgment workflows, while Decision Digest is a
deterministic read. The global registry line, focused command help, summary,
and runnable output hints are sufficient discovery and instruction.

*Acceptance:* golden CLI tests pin `--help` and `-h` as byte-identical, focused,
store-independent, exit-0 output; the compact default summary; an omitted-older
summary; filtered output; incomplete-row guidance; and the empty-result path.
Tests execute every example/hint against a fixture store. A global-help golden
proves only the new registry row changed, and existing help/workflow/shim
goldens remain byte-identical.

## Exit test

Create a fresh store with at least two charted maps and more than 10 resolved
tickets, including direct-human, delegated, later-ratified, ordinary-agent, and
incomplete provenance cases; add closed out-of-scope and invalidated tickets;
distill one resolved ticket body; archive its resolution segment; and include a
same-timestamp ordering tie.

Assemble this comprehensive fixture from named, modular setup helpers rather
than one opaque snapshot or monolithic fixture builder. Keep the scenario's
arrangement explicit and ordered in the test: create the store and maps; create
and resolve tickets; add each provenance shape and excluded closure; distill and
archive; introduce the incomplete join and later repair it; and create the
ordering tie. Helpers should each own one setup concern and be reusable by the
focused acceptance tests where applicable. The end-to-end exit test composes
these helpers; it does not replace the focused tests that independently pin
each rule in F1–F8, including reconstruction/repair, filters, ordering,
provenance, incomplete rows, help, and zoom behavior.

Run bare `nahel decisions` and prove it selects the newest 10 eligible decisions
then renders those 10 oldest to newest with stable IDs, current titles, exact
resolver actors, proof-backed badges, the compact/omission summary, and
executable zoom hints. Starting from `nahel help`, discover the command, read
`nahel decisions --help`, run its compact example, narrow with each filter and a
combined query, then widen with the documented `--since`/`--limit` examples.
Execute the printed ticket, map, and recall zoom commands, follow incomplete
guidance to `nahel validate`, and prove the closed tickets never appear,
incomplete data does not hide healthy rows or invent facts, the recall
quoted-phrase hint works, and no help/read invocation changed the store or
journal. Confirm unrelated global/command help and installed workflow/shim
outputs remain byte-identical.

## Open questions

None — by construction. The map-fed cut check resolved every inside-delta
question and moved all three former fog lines into linked future roadmap
features.
