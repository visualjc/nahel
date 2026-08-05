---
name: planning-partner
created: 2026-08-05T00:59:37Z
updated: 2026-08-05T03:54:33Z
---

# PRD: planning-partner

Roadmap node: `planning-partner` (ntej9rtr) · Map: gp4sycwm · Plan item: yy2tzkjm

This PRD was authored from the node's charted map: every settled decision
below cites the resolved decision ticket that holds its full rationale
(`nahel roadmap ticket show <id>`, or `nahel recall <terms>` for the
reasoning). Per the closed-delta doctrine, it states decisions and points —
it does not re-argue them. The six design decisions (DD1–DD6) and the
D3 refinement (dx5wkzq7) are open grilling tickets on the map; PRD
approval is their ratification, at which point they are resolved citing
the approval and the corresponding fog lines clear.

## Goal

Phase 4 shipped the planning *substrate* — maps, four ticket types, advisory
blocking, the frontier, derived decisions — and the chart-map/work-map
workflows. Nothing yet *conducts* it: no entry point starts a planning
conversation, nothing runs research or prototype tickets autonomously and
returns with findings, nothing makes delegated judgment calls, and nothing
walks a finished-enough map into a PRD. This feature builds the conductor:
a planning partner that works at three altitudes — roadmap shaping (5k ft,
mind-map-style node editing), ideation (10k ft, "wouldn't it be cool if"),
and feature definition (PRD level) — with granularity to match, so a human
(or an agent acting as product owner) can plan without waterfall and say
"that is enough to start" at any point.

## Decisions (from the map — settled, cited)

- **D1 — Entry point** (ticket a39jhccx): one front door, `nahel plan
  [ref]` — a deterministic CLI verb emitting the planning briefing; the
  agent, via the `/nd:plan` shim and `plan.md` workflow, supplies all
  judgment. Agent-starts-nahel; the bash-launcher shape is deferred
  (node `plan-launcher`, 8qtfdcxz).
- **D2 — Granularity gradient** (ticket cphjdnrp): ticket ceremony scales
  down as altitude goes up. PRD level = full map discipline; roadmap level
  = node mutations are the record plus one journaled session note; ideation
  level = blessed ideas graduate to later-horizon nodes, rejects land as
  out-of-scope lines.
- **D3 — Delegation line** (ticket 4pvfrdzy, as refined by open ticket
  dx5wkzq7 — ratified with the DD set at approval): ticket type is the
  line and governance mode moves it. Research/task tickets the partner
  always resolves itself; prototype tickets it always STARTS, with
  resolution following prototype-lane's verdict rules per governance
  (D4's "started, not awaited", made precise by DD5's bridge — the
  partner alone never outruns the lane's human-judgment park; this
  refines 4pvfrdzy's looser "always resolves itself" wording); grilling
  tickets wait for the human under `human` governance and may be
  self-resolved under `delegated` or `agent` — plus a per-ticket
  human-only flag that no mode overrides.
- **D4 — AFK moments** (ticket x5d2tmn0): both mid-session (fire research
  subagents as tickets are cut; prototypes get started, not awaited) and
  between sessions (AFK work on the map's frontier, decision tickets only).
  The plan briefing always opens with "since your last session".
- **D5 — Handoff** (ticket 6efeqsmd): "enough to start" triggers a cut
  check — every fog line and open ticket sorted into outside-this-delta
  (stays, keeps resolving, sharpens into a `--predecessor`-linked successor
  node) or inside-this-delta (resolve now, or re-cut the delta smaller).
  The PRD is fully settled by construction, thinner than a from-scratch
  PRD, the map stays open, and PRDs are archived after release.
- **D6 — Vendoring** (ticket e77g2yge): pin `grilling` + `domain-modeling`
  from `mattpocock/skills` at a SHA via the existing skills.yaml/lock
  machinery; his repo is canonical. Do NOT vendor wayfinder,
  grill-with-docs, research, or prototype. Requires skill-location support
  for nested category directories (see F7 — `grilling` lives under
  `skills/productivity/`, `domain-modeling` under `skills/engineering/`).
- **D7 — Two-lens research** (ticket 5gwg4xrg): one `research` ticket type;
  the posture covers outside-in (agent web tools: competitors, prior art,
  user demand, examples) and inside-out (our codebase and store), each lens
  journaled as separate notes, resolution citing both. Question wording
  drives the weighting — no hard-coded taxonomy.
- **D8 — v1 scope** (ticket 6dw2kyjg): all three postures ship, ideation
  thin. One workflow, one verb, three postures, the AFK frontier lane, the
  cut-check handoff, the skills pinning + location fix.

## Design decisions (proposed — tickets open, ratified by PRD approval)

- **DD1 — "Since your last session" baseline** (ticket wmaqcyak). A NEW
  derivation, actor- and subject-scoped — deliberately not a reuse of
  `awaitingRoadmapReview`, which is human-only, store-global, and
  roadmap-node-only. The subject event set for a node's briefing:
  roadmap-node events on that node, map events on its map, ticket events
  of that map's tickets, and journal notes carrying a `ticket=<id>` data
  key naming one of those tickets (the linkage F3/F5 workflows are
  required to write when researching a claimed ticket). The baseline is
  the READER's latest event in that set — and the reader is not simply
  the invoking actor, or an AFK lane sharing the session's agent id
  would bury its own findings: the default reader is the store's human
  side (latest HUMAN-attributed subject event, the same reader semantics
  `awaitingRoadmapReview` uses), because the debrief exists to catch the
  human up, and AFK agent work must therefore always land inside the
  window. `nahel plan --reader <actor>` overrides for agent-as-PO
  sessions, where the driving agent names itself and the AFK workers run
  under distinct actor ids per NAHEL_ACTOR discipline. Fallback when the
  reader has no subject event: the map's creation; the window is everything
  strictly after the baseline in the store's total order (ts → seq → id),
  so same-second edges are deterministic and the baseline event itself is
  excluded. Rendering the briefing journals nothing — reads stay reads;
  acting in the session advances the baseline naturally.
- **DD2 — Human-only flag** (ticket 5rb9n6ep). A new optional boolean
  `human_only` on ticket frontmatter (absent = false, back-compat), set by
  `ticket new --human-only`, toggled by `ticket update --human-only` /
  `--clear-human-only` — riding the existing ticket record events, no new
  event type. Enforcement is real and closes the obvious hole: under any
  `agent:*` actor, `ticket resolve` and `ticket close` on a human-only
  ticket are REFUSED, and so is `ticket update --clear-human-only` —
  otherwise an agent could clear-then-resolve. Any actor may SET the flag
  (restricting a ticket is always safe); only a human actor may clear it.
  The frontier, `map show`, and `ticket show` render the flag so AFK
  sessions skip these without trying.
- **DD3 — Research in flight, and who decides to wait** (ticket
  xnmj8j9j). Preference order for running research: subagent fan-out when
  the harness has it; inline research when the session judges it short;
  otherwise leave the ticket unclaimed for the AFK lane. When pending
  research is LOAD-BEARING for the next question, the partner neither
  silently stalls nor silently guesses past it — it ASKS: wait for the
  findings, or continue, and on continue it reorganizes the remaining
  question order around what is answerable without them, returning to
  the research-dependent branch when the findings land (this session or
  next, via the briefing's debrief).
- **DD4 — AFK lane shape** (ticket amr4evsg). `plan-frontier.md` is a
  STANDALONE lane: a session (human-started, cron-started, or a future
  orchestrator) invokes it directly against one map, exactly as chart-map
  and work-map are invoked — it is not dispatched by afk-run this delta.
  Rationale: `nahel dispatch` and Runs are work-item-scoped by
  construction (ADR-0016), and product/initiative maps may have no item
  at all; extending dispatch scope is real machinery and belongs to a
  successor delta, recorded on the map as outside-this-delta. Attribution
  needs no Run: every act the lane performs is a journaled CLI mutation
  under its `agent:*` actor, and its research notes carry the `ticket=`
  key (DD1), which is exactly the provenance the briefing derives from.
- **DD5 — Briefing layout and the prototype bridge** (ticket khhcj8fb).
  Briefing order, because a fresh agent reads top-down: (1) node identity
  and destination (bare-form: the product list), (2) since your last
  session — resolved/closed tickets with their one-line decisions, new
  tickets, fog changes, node field changes, linked research notes,
  (3) decisions so far, (4) the frontier, (5) fog and out-of-scope,
  (6) altitude hints and the workflow pointer, (7) the governance line
  (mode + what the partner may self-resolve here). Degraded bare-bash
  form prints the same briefing plus "run this with your agent".
  **Prototype bridge:** a prototype ticket is answered THROUGH the
  existing prototype lane, not around it: the lane (or mid-session
  partner) creates the prototype work item, journals a note carrying
  `ticket=<id>` linking item to ticket, and runs prototype-lane as
  written — including its human-judgment park under `human` governance.
  So AFK "resolves" a prototype ticket only as far as building the
  variants; the ticket stays open (claimed released, note pointing at the
  waiting prototype) until the verdict lands — the human's under `human`
  governance, the partner's under `delegated`/`agent` where
  prototype-lane's own rules already allow it. D4's "started, not
  awaited" made literal.
- **DD6 — In-session delegation: "use your default recommendations"**
  (ticket wmgcj1fh, refining 6efeqsmd's cut check). At any point — and as
  the cut check's THIRD door beside "resolve now" and "re-cut smaller" —
  the human may delegate named unresolved grilling tickets to the
  partner. The act is recorded, not conversational: the workflow journals
  a delegation note naming the tickets, and each consequent resolution is
  made by the agent actor with its stated default recommendation and
  rationale, citing that note via `--source` — so the audit trail reads
  "delegated here, answered so, because." Bounds: per-ticket and
  per-delegation, never a standing mode change; human-only tickets are
  non-delegable (F4's agent-actor refusal stands regardless, making the
  bound CLI-enforced, not just workflow discipline). Under
  `delegated`/`agent` governance the partner already holds this
  authority; DD6 is the explicit, auditable exception path under `human`
  governance — what makes "enough to start" practical without the human
  personally answering every remaining question.

## Non-goals

- The bash launcher (`nahel plan` spawning an agent CLI) — node
  `plan-launcher` (8qtfdcxz).
- Rich ideation / proactive recommendation engine — node
  `recommendation-engine` (t96cbcnh).
- PM-tool adapters (GitHub Issues, Linear, Trello, Jira) — recorded
  separately (c31rnb9k); planning stays fully in-store.
- Vendoring wayfinder, grill-with-docs, research, or prototype skills (D6).
- New research ticket subtypes (D7).
- afk-run dispatching plan-frontier / ticket-scoped dispatch (DD4) — a
  successor delta.
- Any LLM call inside the nahel CLI (HC1 — permanent, not a this-round
  deferral).

## Functional requirements

### F1 — `nahel plan [ref]` briefing verb

A read-only deterministic verb rendering the DD5 briefing, with the
optional `--reader <actor>` override from DD1. With `<ref>`
(node slug or id): that node's briefing. Bare in a single-product store:
the product node's briefing. Bare in a multi-product store: the product
list plus the instruction to pick or name a new one. Unknown ref: refused
with the near-miss hint the roadmap verbs already use. A node with no map
yet: the briefing says so and points at charting.

*Acceptance:* golden-pinned briefing output for: focused feature node,
bare single-product, bare multi-product, no-map node, unknown-ref refusal.
Byte-identical under replay; journals nothing.

### F2 — since-your-last-session derivation (DD1)

Implements DD1's subject event set, actor-scoped baseline, and
strictly-after total-order window. Empty window renders "nothing new since
your last touch".

*Acceptance:* unit tests over a synthetic journal — baseline seeding from
each event kind in the subject set, the `ticket=` note linkage, fallback
to map creation, empty window, same-timestamp edge (two subject events
sharing the baseline event's exact timestamp, one earlier and one later
in seq/id order, proving the strictly-after total-order cut), the default
human reader vs `--reader` override (an agent's own prior acts excluded
only when it names itself), and a multi-actor case proving one reader's
acts do not advance another's baseline.

### F3 — `plan.md` workflow (the conductor)

One canonical workflow: altitude placement first (ask, or take the
ref/hint as the answer), then the posture for the placed altitude —
roadmap shaping (node mutations as the record, one journaled session note
at the end, per D2), ideation (bless → later-horizon nodes, rejects →
out-of-scope lines), feature definition (chart-map/work-map discipline).
Encodes: grilling tickets are HITL under `human` governance — the
partner never answers its own interview questions except under a
recorded DD6 delegation (or `delegated`/`agent` governance); mid-session
research
fan-out with DD3's preference order and its wait-or-reorganize ask when
pending research is load-bearing; research notes carry the `ticket=`
data key (DD1); the D5 cut check — now three doors (resolve now, re-cut
smaller, delegate per DD6) — at "enough to start", handing off to
prd-new; the DD6 delegation recording (journaled note, agent resolutions
citing it); the D7 two-lens research posture; the DD5 prototype bridge.
Registered in workflow routing and shipped as the `/nd:plan` shim by
`nahel install`.

*Acceptance:* the workflow file exists, is registered exactly like its
siblings (routing table, install shim), and states each behavior above in
words an agent can execute; the shim round-trips through
`nahel install --agent claude,codex`.

### F4 — human-only ticket flag (DD2)

Schema field, CLI flags on `ticket new`/`ticket update`, CLI-enforced
refusals under `agent:*` actors (resolve, close, AND clear-human-only),
rendered in `map show`, `ticket show`, and the frontier.

*Acceptance:* refusal tests — agent actor resolve/close/clear each refused
with an actionable message; human actor succeeds at all three; any actor
may set the flag; flag round-trips create/update/clear; frontier, map
show, AND ticket show all render it; `validate` accepts stores with and
without the field.

### F5 — `plan-frontier.md` AFK lane (DD4)

A standalone lane working one map's frontier: claims a takeable decision
ticket, answers by type — research = D7 two-lens with `ticket=`-keyed
notes; prototype = the DD5 bridge (create item, link by note, run
prototype-lane, leave the ticket open for the verdict); task = do it,
journal what it settled — resolves with journaled sources, releases what
it cannot finish. Grilling tickets: skipped under `human` governance,
self-resolvable under `delegated`/`agent` with defend-it-later rationale;
human-only tickets never touched (F4 enforces). Findings surface through
the next briefing (F2) — the lane writes no report file. The lane doc
carries a **Scheduling** section: nahel itself never schedules (a
deterministic CLI has no daemon — HC1), so scheduled AFK execution is
the harness's job, with concrete examples — cron invoking the agent
headlessly (`claude -p "/nd:plan-frontier <map>"`, `codex exec ...`) and
harness-native scheduled agents. afk-run dispatching this lane stays the
recorded successor delta (see Non-goals).

*Acceptance:* the lane file exists and is registered; a scripted dry-run
in a test store proves claim → resolve → release discipline, the
governance-mode skip matrix (human/delegated/agent × grilling/human-only),
and the prototype bridge leaving the ticket open with the linking note.

### F6 — prd-new pre-load amendment (D5)

prd-new gains the map-fed path: when the plan item's feature node has a
charted map, the interview STARTS from the map — decisions become cited
settled sections (the shape this PRD demonstrates), and the cut check is
run and recorded in the PRD. Under the map-fed path the PRD's open
questions section is empty BY CONSTRUCTION: an inside-delta question
resolves during writing or forces a smaller cut; an outside-delta
question stays on the map and never enters the PRD. The from-scratch
interview path is unchanged (its open-questions rule stands).

*Acceptance:* prd-new.md states the map-fed path, names both piles and
all three doors (resolve now / re-cut smaller / delegate per DD6), and
states the empty-by-construction rule; this PRD itself passes it.

### F7 — skills vendoring (D6)

`skills.yaml` at the repo root pinning `grilling` and `domain-modeling`
from `mattpocock/skills` at a locked SHA; `skills.lock` committed;
`nahel skills restore` places both. Two restore-path fixes: (a) the clone
fallback's locator gains one nested category level — searching the repo
root, `skills/`, and `skills/*/` in deterministic order, refusing on
ambiguity (the same skill name under two categories) rather than picking
silently; (b) `restoreViaSkillsCli` is corrected to the current upstream
CLI syntax (verified against vercel-labs/skills: `skills add <source>`
with repeated `--skill` selection and non-interactive flags), or — if the
upstream contract cannot pin our exact placement semantics — the CLI
delegation is dropped for the deterministic clone fallback, recorded as
an ADR-0009 amendment.

*Acceptance:* locator unit tests covering root, `skills/`, `skills/*/`,
and the ambiguity refusal; restore integration test against a local
fixture repo with the nested layout; whichever (b) path is taken is
tested against the real manifest, and the committed manifest + lock
restore both skills cleanly.

## Exit test

Two scenarios, one fresh test store each.

**Feature altitude, end to end:** a store with a product and one feature
node → `nahel plan <feature>` renders the no-map briefing → a charting
session records a map with one ticket of each type, the grilling ticket
flagged human-only → the plan-frontier lane resolves the research ticket
two-lens (notes carrying `ticket=`), executes a task ticket, bridges the
prototype ticket (item created, linking note, ticket left open), skips
the human-only grilling ticket — and the agent-actor refusal on it is
proven directly → a second `nahel plan` briefing opens with exactly those
movements under "since your last session" → the human resolves the
grilling ticket, says enough-to-start; the cut check sorts one remaining
fog line outside the delta → prd-new's map-fed path produces a PRD citing
the resolved tickets with an empty open-questions section → a successor
node is created with `--predecessor` naming this one → `nahel validate`
exits 0 errors throughout.

**Altitude coverage:** a roadmap-shaping session mutates nodes and ends
with one journaled session note (D2 proven); an ideation pass blesses one
idea into a later-horizon node and parks one reject as an out-of-scope
line; a `delegated`-governance store shows the partner self-resolving a
plain grilling ticket with rationale while the human-only ticket still
refuses (D3 + DD2 proven together); and under `human` governance the
human delegates one named grilling ticket ("use your defaults"), the
delegation note is journaled, the partner resolves citing it as
`--source`, and the provenance chain reads back (DD6 proven).

## Open questions

None — by construction (F6). DD1–DD6 and the D3 refinement (dx5wkzq7)
are open tickets ratified by this PRD's approval; everything else
settled is cited to its decision ticket.
