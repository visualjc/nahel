---
name: phase-4-roadmap-layer
created: 2026-08-01T20:10:22Z
updated: 2026-08-01T20:10:22Z
---

# Phase 4 — Roadmap layer

> PRD authored by plan item `roadmap-layer` (`sp2yf32m`). Grounded in the
> 2026-08-01 grill session with Jim (journal note on that item), Matt
> Pocock's wayfinder skill, PRODUCT.md, and Jim's three rulings of
> 2026-08-01 (journal event `wf87dkyx`) — which also set this phase's
> number, shifting Roles & governance to Phase 5 in `docs/roadmap.md`.
> Lifecycle (draft→approved) lives on the work item, never here (ADR-0013).

## Goal

Nahel builds software without a human in the loop (Phase 2) and tests it
(Phase 3), but nothing in the store says **what should be built next, or
why**. The layer above work items — product intent → feature intent → the
work itself — lives today in a hand-written `docs/roadmap.md` and in six
backlog items filed as `feature` because that is the only roadmap surface
that exists. A fresh agent can answer "what is item 2 doing"; it cannot
answer "where are we with the product".

Phase 4 makes the roadmap first-class state: a **three-generation tree**
(product nodes → feature nodes → work items) whose statuses are all
**derived** from what the store already records, a **wayfinder-adapted
mapping method** for charting foggy efforts as decision tickets before and
*during* build, and the **lifecycle tail** — deploy and release events, PRD
archival — that closes the loop from intent to shipped.

The layer is **fully in-store**. Jim explicitly re-scoped GitHub out of this
round: he works agent-only, and cross-agent sharing is the git-committed
store itself. Tracker mirrors stay one-way views for later (HC4;
`roadmap-pm-tool-adapters`, `c31rnb9k`).

Hard constraints inherited unchanged: the CLI stays deterministic (HC1) — it
derives and renders, it never judges; state is committed repo files (HC2);
agents mutate through the CLI (HC3); workflows are drivable by pure
conversation (HC5); nothing quality-bearing is silently skipped (HC6). Every
decision this layer makes lands in the append-only journal — which is what
lets ticket bodies be thrown away without losing the decision they produced.

The stated design principle of the phase is **anti-waterfall**: blocking is
advisory everywhere, build may start before a map is finished, and multiple
parallel "nows" are the intended shape — agentic development makes
concurrency cheap, so the layer must never impose a single front.

## Non-goals

- **No tracker integration.** No GitHub Issues, no Linear, Jira, or Trello.
  Mirrors are a later, one-way, read-only projection (`c31rnb9k`).
- **No visualization.** No mindmap, graph, or web rendering
  (`roadmap-mindmap-visualization`, `64p2tza6`). Output is deterministic
  plain text from the CLI.
- **No multi-product stores.** One product per store is assumed; a second
  product node is out of scope (and not refused — see F1's soft rules).
- **No ranks, scores, or priorities.** Horizons are `now | next | later`;
  no sequencing number is ever stored.
- **No enforcement governance.** Trust + visibility; nothing gates a scribe,
  and no approval gates beyond those the plan lane already has.
- **No deployment or marketing lane.** Phase 4 ships the two *recording*
  events (F9) so the stage view can derive; the workflows that perform
  deploys and announcements are a later phase.
- **No initiative rollup semantics.** `kind: initiative` ships as a linking
  flag; what its status means waits for a real one.
- **No new state for standup.** `nahel standup` is a pure journal view.

## Functional requirements

### F1 — The roadmap node: one record, three generations

A single new record type, the **roadmap node**, with `kind: product |
feature | initiative`. The tree is by `parent`; every node has a
slug-shaped `name` (unique in the store) so every view and command can be
addressed by name, not by bare id.

- **Product node** — light intent (a paragraph, not a PRD), a pointer to a
  permanent **product design doc**, and ADR cross-references.
- **Feature node** — the roadmap-level statement of a feature: the node the
  grilling workflow turns into a PRD, which the existing pipeline
  (`prd-new` → `prd-parse` → `epic-decompose`) turns into an epic and work
  items. It carries its `prd` path and its epic work-item id once each
  exists, and may name a **predecessor** feature node: once a feature is
  released its delta is closed (F10), so further work on it is a new node
  with a new PRD, linked back for lineage.
- **Initiative** — a `kind` flag for a node linking sideways into several
  features (a theme, a campaign); rollup semantics deliberately undefined
  until a real initiative lands.
- **Work items are generation three and are unchanged.** Nodes point at
  items; nodes never duplicate item state.

**Reference direction is one-way and canonical: the roadmap node points at
the work item.** No work-item record is ever written to record a node
relationship — not at migration (F6), not at decomposition. Everything the
layer stores about the node↔item relationship lives on the node.

Every node carries a `horizon` of `now | next | later`. Per-kind structural
rules are **soft**: the authoring agent infers placement, and `nahel
validate` may WARN about an odd shape (a feature under a feature, a node
that should have been a work item) but nothing is ever refused.

**Acceptance criteria:**
- A node of each kind can be created, renamed, re-parented, re-horizoned,
  and read back entirely through the CLI — no hand-editing anywhere (HC3),
  every mutation journaled with actor attribution.
- Slugs are unique per store; `nahel roadmap <slug>` and `nahel roadmap
  <id>` resolve to the same node; a duplicate slug is refused at creation.
- A feature node records its PRD path and its epic work-item id; a product
  node records its design-doc path; both paths are repo-relative and
  schema-hardened like every other path field (no absolute, no `..`).
- **ADR cross-references**: a product node records N ADR references through
  the CLI and reads them back in recorded order; a reference to a
  nonexistent ADR file is a `validate` **warning** naming the node and the
  path, never an error and never a refused mutation.
- **Initiative sideways links**: an initiative node links to two or more
  feature nodes through the CLI; both links read back on the initiative, and
  `nahel roadmap <feature>` shows that feature's initiative membership; a
  link to a missing node, or to a node whose kind is not `feature`, is a
  `validate` warning naming both ends.
- **Direction is provable**: linking a node to a work item, and the whole F6
  migration, leave every `nahel/items/*.md` record byte-identical — checked
  by `git diff`; a run that touched an item record fails this criterion.
- A feature node records a **predecessor** feature node and reads it back;
  `nahel roadmap <feature>` shows the lineage both ways (successor from the
  predecessor, predecessor from the successor); a predecessor link to a
  missing node is a `validate` warning.
- A structurally odd tree (feature parented to a feature; a node with no
  product ancestor) produces a `validate` **warning** with the node named —
  and the mutation that created it was not refused.
- All node state lives under `nahel/` in committed files (HC2); a fresh
  clone reads the same tree.

### F2 — Every status is derived; nothing is hand-set

No status field is ever written on a node. The CLI computes each column
deterministically (HC1) from state that already exists. The rules below are
**total** over the recorded vocabulary — every work-item status, every
missing-reference case, every tie has a stated outcome — so two
implementations reading identical store facts cannot render different
statuses.

**Feature dev status** — a rollup of the work items under the feature's
epic. `dropped` children are excluded entirely (dropped work is not work);
`blocked` and `in-review` count as **started**, never as their own
node-level status (blocking is advisory — F8 — not a roadmap state):

| epic state | dev status |
| --- | --- |
| no epic id recorded on the node | `planned` |
| epic id recorded but no such item record | `unknown` + `validate` warning |
| epic exists with **no descendants at all** | the epic item's OWN status: `backlog` → `planned`; `in-progress`/`blocked`/`in-review` → `in-flight`; `done` → `built`; `dropped` → `planned` + `validate` warning |
| epic has descendants, every one `dropped` | `planned` + `validate` warning |
| every non-dropped descendant `done` | `built` |
| every non-dropped descendant `backlog` | `planned` |
| anything else (any mix, any `in-progress`/`blocked`/`in-review`) | `in-flight` |

**The childless-epic row is a contract clarification** (PR #26 review,
superseding the earlier row "epic exists, zero children after excluding
`dropped` → `planned`"). A `direct`-lane epic never grows children, so that
row rendered a feature whose only work item was `in-progress` as `planned`,
and rendered it `planned` still once the item was `done`. With no descendants
the epic is not a container over the work — it **is** the work, and its own
status is the rollup. The moment **one** descendant exists the subtree rows
are authoritative again and the epic item's own status is excluded: a `done`
epic must not override backlog work still open underneath it, and must not
override the all-dropped row.

**Product status** — the count distribution of its feature children's dev
statuses, including `unknown` ("3 built · 2 in-flight · 6 planned · 1
unknown"), never one word that hides the shape. A product node with no
feature children renders `no features`.

**Event-sourced columns (QA, deploy, release)** share one **association
rule**, stored rather than inferred: an event covers a feature node iff its
`item` ref resolves to that feature's epic item **or to a descendant of it in
the item `parent` tree**. An event with no `item` ref, or whose `item`
resolves outside every feature's subtree, covers **no feature node** — it is
store-wide and renders only in `brief`'s existing QA line, exactly as today.
When more than one event covers a feature, the one that is **last in the
store's canonical total order (`ts` → `seq` → `id`)** wins.

Selecting the winning event is not enough — the **rendered value** is
specified too, or two implementations agree on the event and still print
different columns. `<ts>` is the winning event's `ts` verbatim; `?` is the
existing absent-payload-key convention (`brief`'s `payloadField`):

| column | store fact | rendered value |
| --- | --- | --- |
| QA | no covering `qa.sweep-completed` | `—` |
| QA | covering sweep, payload `failed` = 0 | `tested <ts>` |
| QA | covering sweep, payload `failed` > 0 | `tested <ts> (N failed)` |
| QA | covering sweep, `failed` absent or non-numeric | `tested <ts> (? failed)` |
| deploy | no covering `deploy.completed` | `—` |
| deploy | covering event with `environment` | `deployed <environment> <ts>` |
| deploy | covering event, `environment` absent or blank | `deployed ? <ts>` |
| release | no covering `release.announced` | `—` |
| release | covering event with `version` | `released <version> <ts>` |
| release | covering event, `version` absent or blank | `released ? <ts>` |

Before F9 ships, the deploy and release columns read `—` for every feature —
the no-event row, not a special case. The single-word **stage** these
columns roll into is F9's precedence table.

Anything not derivable reads `unknown` or `—`, explicitly, and is never
filled by judgment.

**Acceptance criteria:**
- Flipping a leaf work item to `done` changes the feature node's rendered
  dev status with **no node record write in between** — provable from the
  journal and from file mtimes/git status.
- Each row of the dev-status table is exercised by its own case, including:
  no epic id → `planned`; dangling epic id → `unknown` plus the named
  `validate` warning; a childless epic at each of its six own statuses
  (`backlog` → `planned`, `in-progress`/`blocked`/`in-review` → `in-flight`,
  `done` → `built`, `dropped` → `planned` plus warning); all-dropped epic →
  `planned` plus warning; a `blocked`-only epic and an `in-review`-only epic
  each → `in-flight`; done+backlog mix → `in-flight`. A `done` epic with a
  live descendant does NOT read `built` — the root never overrides a subtree.
- A product node renders the full distribution including any `unknown`
  count; with no feature children it renders `no features`.
- A `qa.sweep-completed` whose `item` is the feature's epic changes only
  that feature's QA column; one whose `item` is a grandchild of the epic
  does the same; one with **no** `item` ref changes no feature's QA column;
  and one whose `item` belongs to **another** feature's subtree **does not
  change the subject feature — it changes only the owning feature**.
- Every row of the render table is exercised, including the `?` rows: a
  sweep with `failed` absent renders `tested <ts> (? failed)`, a deploy with
  no `environment` renders `deployed ? <ts>`, a release with no `version`
  renders `released ? <ts>` — none of them blank, none of them omitted.
- Two sweep events covering the same feature in the same second resolve by
  `seq` then `id` — the same winner on every machine and on a fresh clone.
- There is no CLI verb, flag, or config that sets a node status; an attempt
  exits non-zero naming the derivation rule that owns that column.
- Derivation is pure: two consecutive renders, and a render on a fresh
  clone of the same commit, are byte-identical.

### F3 — `nahel roadmap [ref]`: the zooming view

One new read verb, deterministic plain text in the house style of `status`
and `progress`.

- **No ref** — the product level: the product node, then its feature
  children grouped by horizon (`now`, `next`, `later`) with derived status
  columns.
- **With a ref** (slug or id) — zooms to that node: a breadcrumb of its
  ancestors, its own intent line and doc pointers, its children, and — for a
  feature — the epic's work items with their statuses, so the third
  generation is reachable without a second command.
- **`nahel roadmap ack`** — the one write in the verb family: a
  human-attributed acknowledgement that clears the brief's
  awaiting-your-eyes line (F5). It mutates no node.
- Unknown refs exit non-zero and name the near-miss slugs.

**Acceptance criteria:**
- The three real orientation questions are each answered by one command,
  with no file reading: `nahel roadmap` → "where are we with the product";
  `nahel roadmap <feature-slug>` → "where is feature A"; the same output's
  work-item listing (or `nahel progress --item <id>` from it) → "where is
  feature A item 2".
- Output is deterministic across runs and machines and is doc-tested like
  the other views.
- Zooming a feature node with no epic yet renders the node and says so,
  rather than erroring.

### F4 — Orientation surfaces: brief block and `nahel standup --since`

- **`nahel brief` gains a roadmap block** with **deterministic elision**, not
  a completeness promise the cap cannot keep — many parallel `now`s are
  doctrine (F8), so the block must degrade predictably rather than lie. It
  lists at most **10** `now`-horizon nodes, one line each, in
  **horizon-entry order**: oldest first by the journaled event that set the
  node's current horizon (`ts` → `seq` → `id`), ties by slug. When more
  exist, a final `+K more — nahel roadmap` line states the remainder. Then
  one summary line for `next` and one for `later`. Block ≤ 13 lines, always.
- **`nahel standup --since <when>`** is a curated read over the journal for
  a time window — what moved, what shipped, what parked, what got blocked —
  grouped by node and item. It creates **zero new state**: no records, no
  events, no config. `--since` accepts an ISO timestamp and a relative form
  (`7d`, `24h`); relative cutoffs are computed **exclusively through the
  injected `Env`** (`env.now()`) like every other clock read in the codebase
  — no direct `Date` call anywhere on the path (HC1, ADR-0004).

**Acceptance criteria:**
- On a store with 40 `now` nodes the block lists exactly 10 plus the
  `+30 more` line and the two summary lines; the 10 are the earliest by
  horizon-entry order, and re-rendering after an unrelated mutation returns
  the same 10 in the same order. On a store with no nodes the block is
  absent, not empty scaffolding.
- `nahel standup --since 7d` on a real recent window of this repo's own
  journal renders the movement, with every rendered line traceable to
  journal events by id.
- Under a **fixed `Env`**, `--since 7d` and the equivalent absolute
  timestamp produce byte-identical output; the same fixed `Env` and store
  produce byte-identical output on any machine (determinism suite).
- Running `standup` leaves the store byte-identical (`git status` clean, no
  new journal events) — the pure-view property is tested, not assumed.
- Both surfaces are doc-tested.

### F5 — Governance: trust and visibility, not enforcement

Any agent may create and mutate roadmap nodes, maps, and tickets. Nothing
gates a scribe — a roadmap nobody can write is a roadmap nobody updates. The
control is **visibility**:

- `nahel brief` carries a **"roadmap changes since your last touch"** line
  for the reading actor: what moved since that actor's last recorded
  activity, capped and counted like F4's block.
- **`governance.product` gains a third value, `agent`** (Jim's ruling,
  journal event `wf87dkyx`) — **on the product side only**. Today
  `governance.product` and `governance.architecture` share one
  `GOVERNANCE_MODES` enum, so widening it in place would silently make
  `governance.architecture: agent` valid — which `docs/roadmap.md` §7 does
  not permit (architecture stays `human | delegated` until Phase 5 decides
  otherwise). The two fields therefore get **separate enums**:
  `PRODUCT_GOVERNANCE_MODES = human | delegated | agent` for `product`, with
  `GOVERNANCE_MODES` unchanged for `architecture`. Two enums beat a
  cross-field `refine` here because `governanceSchema` already declares each
  field independently (`records.ts`), so the refusal falls out of the field's
  own `z.enum` — no extra predicate, and the error names the offending field
  and its legal values for free. `delegated` keeps its Phase 2 meaning
  (cross-vendor consensus for PRD approval) untouched on both sides. The
  roadmap layer keys on `agent` versus not-`agent`:
  - **`agent`** — agent-as-PO owns the roadmap outright. Horizon changes and
    new feature nodes are journaled **as themselves**, under the agent's own
    authority, with **no awaiting-your-eyes surface** at all. This is the
    swarm mode Jim wants for full POC products built AFK.
  - **`human` and `delegated`** — agents still scribe freely and nothing is
    refused, but agent-authored roadmap acts surface in the brief as
    **awaiting your eyes**. (`delegated`'s consensus rule governs PRD
    approval, not roadmap scribing; the roadmap layer adds no consensus
    requirement of its own.)
- The awaiting-your-eyes line **clears on any human-attributed roadmap
  act** — a node created, re-horizoned, or linked by a human actor — and,
  when the human only wants to say "seen", by the lightweight verb
  **`nahel roadmap ack`**, which records a human-attributed acknowledgement
  and nothing else.

**Acceptance criteria:**
- Under `human`, an agent-authored horizon change succeeds, is journaled
  with agent attribution, and appears in the brief as awaiting the human; a
  refusal fails this criterion. Under `delegated`, the same behavior.
- Under `agent`, the same act carries on and the brief shows **no**
  awaiting-your-eyes surface for it — the act is journaled under the agent's
  own authority and appears only in the ordinary roadmap block.
- The awaiting line clears two ways, each exercised: (1) any
  human-attributed roadmap mutation clears it; (2) `nahel roadmap ack`
  clears it, journaling a human-attributed acknowledgement and mutating no
  node. After either, the next `brief` for that actor omits the line; a new
  agent act re-raises it.
- `nahel roadmap ack` under an agent actor does **not** clear the line
  (provenance is read from the journal, exactly as merge authority reads it).
- The "changes since your last touch" line appears for an actor with prior
  recorded activity, names counts and the nodes touched within the cap, and
  is absent (not an empty header) for a first-touch actor.
- `governance.product: agent` is accepted by the config schema and by
  `validate`; a store written before the value existed stays valid — and no
  CLI path refuses a roadmap mutation on governance grounds under any of the
  three values.
- A config carrying **`governance.architecture: agent` is REFUSED** by
  schema validation — `nahel config set` exits non-zero and `nahel validate`
  reports it as an error (not a warning), naming the field and its legal
  values `human | delegated`. The product side accepting `agent` in the same
  config does not rescue it.

### F6 — Migration: today's headlines become the first roadmap

The layer is proven by adopting the state that already exists, in **both
live stores**. The migration rule is **coverage, not a count**: *every
roadmap-shaped item in both stores at migration time* gets a node,
enumerated at build time from the stores themselves. (The grill note's "8
headline items" was a scribe miscount, corrected by Jim — journal event
`wf87dkyx`.)

**The candidate line** (revised by Jim in the PR #26 review, follow-up C1 —
the original text drew it at status `backlog`): a candidate is a
**top-level** item — one with **no parent** — at any status but `dropped`,
which puts `backlog`, `in-progress`, `blocked`, `in-review` **and `done`**
in scope. Done features are candidates because the roadmap's job is
built / in-flight / planned rather than planned alone: excluding them
migrates a delivered product to an empty roadmap and leaves it historyless
(speed-count, where the shipped work *is* the product, is the case that
proves it). A done feature's node needs no extra field to say so — its
columns derive `built` from the epic it names, by the childless-epic rule or
by its children's rollup. Only `dropped` is out: abandoned intent is not
intent the roadmap carries. The judgment rules are unchanged — roadmap-shaped
versus work-shaped, near-misses need reasons.

**Pre-store history is explicitly out of scope.** A capability that shipped
before the store existed carries no work item, so a node charted for it would
name no epic and would render `planned` while claiming shipped history —
false history, written by the one act whose purpose is an auditable record.
Bringing such capabilities in is a **historical import**, designed
separately; migration does not attempt it.

As recorded today the sets are:

- **nahel** — the roadmap-headline backlog items recorded today
  (`detached-state-repo` `aqz2bvav`, `architecture-docs-wiki` `x41wnrap`,
  `changelog-and-product-updates` `t4e4476a`, `deployment-devops-workflows`
  `9m38trg4`, plus the two deliberately-future ones,
  `roadmap-mindmap-visualization` `64p2tza6` and `roadmap-pm-tool-adapters`
  `c31rnb9k`) become feature nodes under a nahel product node, with
  `docs/roadmap.md` as the source of the product node's intent and design
  doc pointer.
- **speed-count-game** — its feature-shaped backlog
  (`ui-layout-refresh`, `dealer-soft-17-setting`, `reveal-hand-value-toggle`,
  `dealer-stays-on-soft-17`) becomes feature nodes under a speed-count
  product node.

These lists are illustrative of today's state, not the specification — the
build enumerates the stores at migration time. Migration writes **node
records only**: the node names the item it covers, per F1's canonical
direction; **no work-item record is touched at all**.

**"Roadmap-shaped" is a judgment, so it is journaled before it is acted
on.** Step one of each store's migration is a single event recording the
**complete selected set**: every included item id, **and** every excluded
near-miss with a one-line reason (why that backlog item is work, not
roadmap intent). It is written **before the first node is created**, so a
reviewer can audit the call from the journal rather than inferring it from
whatever nodes happen to exist afterwards.

**Acceptance criteria:**
- The **first** migration event in each store enumerates the complete
  selected set — included ids and excluded near-misses with reasons — and
  strictly precedes every node-creation event in that store (a set event
  written after the nodes fails this criterion — and so does one written in
  the same second; rendered journal order is a quick look, never the proof).
  **Strict precedence means strict timestamp inequality**: the selection
  event's `ts` is strictly earlier than every node-creation event's `ts`, and a
  same-second tie fails migration — segments are per-invocation and a
  same-second tie breaks on random event id, so rendered order alone proves
  nothing.
- Every id in that selected set has a node afterwards, and every node traces
  back to an id in it — the set and the result match exactly, with no
  orphans and nothing invented.
- After migration, `nahel roadmap` in each store shows every roadmap-shaped
  candidate recorded at migration time — top-level, any status but `dropped`
  — enumerated from the store rather than from this document.
- Each migration act is journaled naming the node and the item it covers.
- `git diff` over `nahel/items/` across the whole migration is **empty** in
  both stores — a single modified item record fails this criterion (F1's
  direction rule).
- `nahel roadmap` in each store answers "where are we with the product" on
  one screen.

### F7 — Maps and decision tickets (wayfinder, hosted on nahel state)

Matt Pocock's wayfinder method, adapted onto in-store records — no issue
tracker anywhere:

- A **map** is a lightweight record attached to a node (usually a feature or
  initiative), showing: **Destination**, **Notes**, **Decisions so far** (a
  one-line index, not a store), **Not yet specified** (the fog — in-scope
  questions not yet sharp enough to ticket), and **Out of scope** (ruled
  beyond the destination; never graduates).
- A **decision ticket** is a lightweight child record of the map with
  `type: research | prototype | grilling | task`, a question body, and
  advisory blocking edges to sibling tickets.

**The index sections are DERIVED, and the map record stores neither**
(contract clarification, PR #26 review, superseding the earlier reading in
which `resolve` appended to a `decisions` array on the map and an
out-of-scope `close` appended to its `out_of_scope` array). **Decisions so
far** and the ticket-earned part of **Out of scope** are composed at read
time from the map's own tickets, which already carry the decision and the
ruling — storing a second copy made every resolution and every out-of-scope
close rewrite the one record that every ticket on the map shares: a hot spot
two concurrent sessions contend for, holding facts that were already written
down. The map still **stores** what it charted with no ticket behind it: its
fog, and the out-of-scope lines ruled before any ticket existed
(`--out-of-scope` at `map new` / `map update`). Ruling something beyond the
destination needs no ticket; a decision always does. Both derived sections
order by the **journal event** that resolved or closed each ticket, in the
store's canonical `ts → seq → id` total order — never by the ticket's
`updated`, which `distill` moves long after the decision was made. A closed
ticket therefore records its close event id (`closure`) exactly as a resolved
one records its `resolution`.

**Ticket lifecycle** — four states, and every transition is a CLI mutation
(HC3), journaled:

| from → to | operation |
| --- | --- |
| — → `open` | `nahel roadmap ticket new --map <ref> --type <t>` |
| `open` → `claimed` | `nahel roadmap ticket claim <ref>` |
| `claimed` → `open` | `nahel roadmap ticket release <ref>` |
| `open`/`claimed` → `resolved` | `nahel roadmap ticket resolve <ref> --decision <one-liner>` |
| `open`/`claimed` → `closed` | `nahel roadmap ticket close <ref> --reason <why> --out-of-scope`, or `… --invalidated-by <ticket-or-event>` |
| `resolved`/`closed` → body distilled | `nahel roadmap ticket distill <ref>` |

A close **states which disposition it is**, because the two the row covers are
different facts: `--out-of-scope` means ruled beyond the destination and earns
the reason a line in that section, while `--invalidated-by` means another
decision answered the question out of existence — it was never beyond the
destination, so it records the invalidating ref on the ticket and earns no
Out-of-scope line, rendering beside Decisions so far instead. Both readings
are derived from the closed ticket; neither writes the map.

**Claim semantics** are advisory assignment, deliberately NOT the
intervention claim (`nahel intervene claim` keeps its freeze semantics for
work items): the claim records the claiming actor id so concurrent sessions
skip the ticket, claiming a claimed ticket refuses naming the holder, and
release is always permitted. An `open` ticket with no claimant is unclaimed
— the whole test F8's frontier applies.

**Resolution and distillation.** `resolve` journals the decision **and
distills an observation** (`nahel observe`'s record type, tagged, sourcing
the resolution event id) so `nahel recall` finds decisions by search —
wayfinder's decisions-are-permanent principle on nahel's existing recall
design. `distill` then **empties the ticket body through the CLI** — body
deletion is a state mutation, never a raw file delete.

Both are **multi-record sequences**, so each step rides the existing
write-ahead choke point (`store/mutate.ts`: journal the event, then apply
the record write) — no step invents its own write path. A sequence
interrupted between any two steps is therefore a **recoverable partial
state**, not corruption: `validate` names it and `validate --repair`
(`replayPending`) rolls it forward.

- **Two workflow docs** ship: charting a map (name the destination, grill
  breadth-first, create tickets then wire blocking in a second pass, sketch
  the fog) and working a map (claim one ticket, resolve it with the existing
  `grilling` / `domain-modeling` / prototype-lane / research surfaces,
  record the decision, graduate fog).

**Acceptance criteria:**
- A map can be charted end-to-end through the CLI plus its workflow on a
  real feature node, with all five sections populated and tickets of at
  least three of the four types created and blocking-wired.
- Every transition in the table is exercised through its named verb and
  produces a journal event with actor attribution: new, claim, release,
  resolve, close, distill.
- Claiming a claimed ticket exits non-zero naming the holder; release by any
  actor succeeds and returns the ticket to the frontier (F8).
- `resolve` writes the decision event **and** an observation whose `sources`
  include the resolution event id; `nahel recall <decision terms>` returns it,
  and `map show` renders the index line derived from the resolved ticket.
- `distill` empties the body **through the CLI** and journals it; afterwards
  the decision is still fully readable from `nahel recall` and `nahel
  progress` alone — exercised by actually distilling one. A ticket body
  removed by a raw file edit is reported by `validate` as a finding (no
  distill event for an emptied body).
- **Crash-shape**: with the process killed between **any two** steps of
  `resolve` (decision event → ticket state → observation), of `close`
  (close event → ticket state → observation) and of `distill`, `validate`
  names the partial state, `validate --repair` completes it, and re-running
  the original verb afterwards is idempotent — no duplicate observation, no
  second index line. Exercised at every interruption point, not just the
  first. The map is at no interruption point in any of them, because no
  terminal verb writes it.
- An out-of-scope ruling `close --out-of-scope`s the ticket, earns one line
  under Out of scope with its reason, and never appears in Decisions so far;
  a `close --invalidated-by <ref>` records the invalidating ref on the ticket
  instead, earns NO Out-of-scope line, and never appears in Decisions so far
  either — and a close naming neither disposition (or both) is refused.
- Both workflow docs pass the workflow-format doc tests and are installed by
  the existing shim generator like every other workflow (HC5: drivable by
  conversation alone).

### F8 — The frontier and the anti-waterfall rule

- **`nahel roadmap frontier`** lists the takeable edge — everything that can
  start *now* rather than what comes next in a plan. It spans **both**
  record kinds, because a ticket-only frontier would answer "what can I
  decide" while going silent on "what can I build", and mapping and building
  run concurrently by design (the anti-waterfall rule below). The two kinds
  have different vocabularies, so eligibility is defined once per kind:
  - **Tickets** — state `open` (F7), no claimant, and every blocking ticket
    in `resolved` or `closed`.
  - **Work items** — status `backlog`; **not covered by an intervention
    claim** (its own `claimed_by`, or an ancestor's — a claim covers the
    whole subtree, per the glossary); and every `depends_on` target at
    `done` or `dropped`.
  Both predicates are read-only renderings: nothing here refuses anything,
  and an item failing either predicate can still be started deliberately.
- **Blocking is advisory, everywhere.** No command refuses work because a
  blocker is open. An agent may deliberately start a blocked item; doing so
  journals a **"started with open blocker"** event naming every open
  blocker, so the choice is visible rather than prevented.
- **Build may start before a map is complete.** A feature can carry an
  in-flight epic and an unfinished map at the same time, and no view or
  check calls that an error.
- **Multiple parallel `now`s are correct**, never warned about.

**Acceptance criteria:**
- `frontier` lists exactly the eligible tickets: claiming one removes it and
  releasing it restores it; resolving *or* closing a blocker adds its
  dependents.
- `frontier` lists exactly the eligible work items, each sub-predicate
  exercised: a `backlog` item with all `depends_on` targets `done` (and one
  with a `dropped` target) is listed; the same item with an `in-progress`
  dependency is not; an item claimed **through an ancestor's** intervention
  claim is not; an `in-progress`/`in-review`/`blocked`/`done`/`dropped` item
  is not.
- Starting a blocked item succeeds and journals the deliberate-start event
  naming every open blocker — any refusal anywhere in the path fails this
  criterion.
- A store with three `now`-horizon nodes produces no `validate` warning and
  no view that claims a single current focus.
- A feature with an unfinished map and an in-flight epic renders coherently
  in `nahel roadmap <feature>` — both facts shown, neither flagged.

### F9 — Deploy and release: two new events, and the stage view

Two new journal event types, recorded by workflows through `nahel log` (open
extension, like the QA types):

- **`deploy.completed`** — environment, the deployed ref/commit, and what
  went out.
- **`release.announced`** — version, channel, and a pointer to the
  announcement.

From these plus F2's derivations, a feature renders a single-word **stage**
by **precedence** — first matching row wins, evaluated top-down. Precedence,
not history, is what makes the stage stable: a deploy recorded after a
release does not regress the feature to `deployed`.

| condition (F2's association rule throughout) | stage |
| --- | --- |
| a covering `release.announced` exists | `released` |
| else a covering `deploy.completed` exists | `deployed` |
| else a covering `qa.sweep-completed` whose payload `failed` is `0` exactly | `tested` |
| else dev status is `built` | `built` |
| else dev status is `in-flight` | `in-flight` |
| else dev status is `planned` | `planned` |
| else (dev status `unknown`, no covering events) | `unknown` |

Nothing about the stage is hand-set; it is a pure function of recorded
events and F2's dev rollup.

**The QA row advances on a clean sweep only** (contract clarification, PR
#26 review, superseding the earlier reading in which any covering sweep read
`tested`). A `failed` count greater than zero, missing, non-numeric or
negative all fall through to the dev-status rows: a stage is what a reader
scans a column of, `tested` beside four failures reads as a feature that
passed, and a count nobody can read is not a pass either — otherwise a
workflow reaches `tested` by logging nothing at all. An unreadable count
(absent, non-numeric, negative — **not** a legitimate count above zero) is a
`validate` warning naming the sweep, because holding the feature back
silently is the failure mode. F2's **render table is unchanged**: the QA
column still prints `tested <ts> (N failed)` and `tested <ts> (? failed)`
verbatim, so one line carries both where the feature stands and what the
sweep found.

**Acceptance criteria:**
- Both types are documented vocabulary with defined payload shapes, and are
  recordable through `nahel log` with node/item attribution.
- A feature with epic done + `qa.sweep-completed` + `deploy.completed` +
  `release.announced` renders `released`; removing any one of those events
  from the read renders the corresponding earlier stage — each row of the
  precedence table exercised, including the `unknown` row.
- A `deploy.completed` recorded **after** a `release.announced` leaves the
  stage at `released` — precedence, not recency (regression check).
- The stage is a pure function of the store: same commit, same stage, on any
  machine; no stage field exists to write.
- Neither type is CLI-self-recorded and neither carries mutation payload
  keys — a logged event can never masquerade as a record mutation.

### F10 — PRD lifecycle: live until released, then archived

- A feature's PRD lives at `docs/prds/<name>.md` and is **live** — edited as
  the feature evolves — until the feature is **archival-qualified**.
- **Stage `released` and archival-qualified are different facts** (contract
  clarification, PR #26 review). The stage is a **view** of what the store
  holds and stays permissive by design: any covering `release.announced` reads
  `released`, and one recording nothing still renders `released ? <ts>` (F2's
  render table, F9's precedence table — both unchanged). Archival is not a
  view. It stamps a document closed **forever** on a header that **cites the
  release**, so it demands a release a reader can follow back: the winning
  unretracted `release.announced` must carry a **nonblank `version`,
  `channel` and `announcement`**. Without all three the verb refuses, naming
  the release event and every missing key, and the PRD stays live.
- On archival the PRD is **moved** to `docs/prds/archived/` with a stamped
  header — released date, epic/item link, the **journal-pointer line** (the id
  of the archival event), and the line that the **code and tests are the truth
  now**. The archival event **names the release event it rests on**, so the
  pointer reads both ways. **No PRD is ever deleted.**
- **Every stored reference to the moved path is updated in the same act,
  through the CLI** (HC3). The complete set: (1) the **feature node's** PRD
  link; (2) the **owning plan item's** `prd` field — the item that authored
  the PRD (ADR-0013); (3) the **referencing feature work item's** `prd`
  field — the epic parsed from it; and (4) as a catch-all, **any other
  record whose `prd` field equals the old path**. A dangling `prd` path
  after archival is a bug, not a warning.
- **Product design docs are permanent** — updated in place on release, never
  archived. They state what the product is; a PRD stated one delta.
- **An archival-qualified release means the delta is closed.** An archived PRD
  is never reopened and never edited. Further development on a released feature is a **new
  feature node with a new PRD**, which may link the predecessor node for
  lineage — that is what keeps an archived PRD an honest record of what
  shipped rather than a document that quietly drifts after the fact.
- Archival is a **multi-record sequence**, so every step rides the existing
  write-ahead choke point (`store/mutate.ts`: journal the event, then apply
  the record write) and an interruption leaves a **recoverable partial
  state** that `validate --repair` rolls forward. The writes, in order:
  (1) the archival event plus the PRD file move-and-stamp; (2) the feature
  node's PRD link; (3) the owning plan item's `prd`; (4) the referencing
  feature/epic item's `prd`; (5) **each** catch-all record sharing the old
  path — **N separate writes**, not one; (6) the product design doc update.

**Acceptance criteria:**
- Archiving a released feature's PRD leaves the file at
  `docs/prds/archived/<name>.md` whose header carries all four stamped
  elements, including the **journal-pointer line naming the archival
  event's id** — a header missing the pointer fails this criterion.
- Each of the four reference kinds is updated in the same act and exercised
  by its own case: the feature node's link; the plan item's `prd`; the
  feature/epic item's `prd`; and a fourth record sharing the same path.
  After archival, **zero** records in the store hold the old path
  (`rg`-checkable), and every update went through the CLI (journaled, no
  hand-edited frontmatter).
- The archival journal event names the old and the new path, **and the id of
  the `release.announced` the archival rests on**.
- A feature that has not reached `released` is never archived, and neither is
  one whose winning release lacks a nonblank `version`, `channel` or
  `announcement`: the refusal **names the release event and every missing
  key**, and each of the three keys is exercised by its own case, blank
  counting as missing. A **retracted** release is no release at all and earns
  the ordinary stage refusal instead.
- `validate` and the verb read the **same eligibility predicate**, so the
  report can never name a command that then refuses:
  `roadmap.prd-unarchived` fires on exactly the nodes archival accepts, while
  a feature at stage `released` on a release too thin to carry an archival
  gets `roadmap.release-incomplete` — naming the event and the missing keys,
  with a fix that is **re-logging the release**, never archiving. A `prd` path
  pointing at a missing file warns as before.
- The product design doc referenced by the product node is updated in the
  same act (diffable), not archived.
- **Crash-shape**: the process is killed at **every** boundary of the write
  sequence above — after the event-and-move, after the feature node's link,
  after the plan item, after the feature/epic item, **after any prefix of
  the N catch-all updates** (all N+1 sub-boundaries, not just before and
  after the batch), and after the product design doc update. At each one,
  `validate` names the partial state — including a `prd` path pointing at
  neither location, and a design doc left stale while every reference has
  moved — `validate --repair` completes it, and re-running archival
  afterwards is idempotent (the header is stamped once, not twice; no
  reference is rewritten a second time).
- **Closed delta**: a feature node whose PRD link points **into
  `docs/prds/archived/`** while the node is **not** released is a `validate`
  **warning** naming the node and the archived path — the signal that
  someone is continuing work against a closed delta instead of opening a new
  feature node. A new feature node linking the predecessor for lineage
  produces no warning.
- Zero PRD deletions across the phase, and zero edits to any file under
  `docs/prds/archived/` after its archival commit — both checkable from git
  history.

## Delivery order — three slices, one phase

**S1 — Orientation** (F1–F6). The tree, the derivations, the verbs, the
brief block, standup, and the migration of both live stores. This slice
alone makes "where are we with the product" a command instead of an
archaeology session.

**S2 — Mapping** (F7, F8). Maps, decision tickets, the frontier, the
anti-waterfall rule, the two grilling workflow docs. Depends on S1 — tickets
hang off nodes and the frontier is a view over the same tree.

**S3 — Lifecycle tail** (F9, F10). Deploy and release events, the stage
view, PRD archival. Depends on F2's derivation machinery; independent of S2,
so it can land in parallel if the mapping work stretches.

## Exit test (the phase bar)

One concrete, checkable exit per slice; all three required to close the
phase.

1. **S1 — orientation.** In both migrated stores, a fresh session answers
   Jim's three real questions with three commands and no file reading:
   `nahel roadmap` ("where are we with the product"), `nahel roadmap
   <feature-slug>` ("where is feature A"), and that output's item listing
   ("where is feature A item 2"). Plus: `nahel standup --since 7d` renders a
   **real** recent week of the nahel journal, every line traceable to
   events, and leaves the store byte-identical; `nahel brief`'s roadmap
   block is within its cap on both stores.

2. **S2 — mapping.** One real foggy feature (candidate:
   `deployment-devops-workflows` `9m38trg4`) is charted as a map with a
   named destination, fog, an out-of-scope entry, and tickets spanning at
   least three of the four types; one session resolves **exactly one**
   ticket, records the decision, and graduates fog into a new ticket;
   `nahel roadmap frontier` changes accordingly. In the same slice, one item
   is deliberately started while blocked and the journal shows the
   "started with open blocker" event — with no command having refused
   anything.

3. **S3 — lifecycle tail.** One feature walks the whole tail on a real
   release (nahel's own next version release is the subject): epic done →
   `qa.sweep-completed` → `deploy.completed` → `release.announced` → the
   stage view renders `released` with nothing hand-set → its PRD is archived
   with the stamped header and journal pointer, and the product design doc
   is updated in the same act.

Pass = all three, judged by Jim. Anything that misses feeds the backlog
before the phase closes.

## Open questions

These are implementation-time decisions, not reopenings of the grill.

1. **Record file layout.** Whether roadmap nodes, maps, and tickets live in
   new directories under `nahel/` (e.g. `nahel/roadmap/`, `nahel/maps/`) or
   as additional record kinds beside `nahel/items/` — a store-layout call to
   make when F1 lands, constrained only by HC2 and by merge-safety
   (disjoint-file writes, ADR-0012).
2. **Initiative rollup.** What `kind: initiative` derives as its status is
   deliberately undefined until a real initiative exists. The kind flag and
   the sideways links ship; the semantics wait.

Three earlier open questions were **ruled on by Jim** (2026-08-01, journal
event `wf87dkyx`) and are folded into the requirements above:
`governance.product` gains a new third value `agent` (F5); migration is
coverage, not a count (F6); and the roadmap layer **is** Phase 4, with
`docs/roadmap.md` amended and Roles & governance shifted to Phase 5.
