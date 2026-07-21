---
name: inception
description: Found a project — tiered interview producing constitution, governance, glossary, run contract, and first plan items
args: "[seed|standard]"
---

# Workflow: inception

Load and follow this workflow to found a project on nahel, or to re-found one
whose recorded tier no longer covers what it is asked to do. Inception is
judgment work: you interview, draft, and let the human decide; the CLI does
every state mutation. Never hand-edit anything under `nahel/`.

Before any `nahel` command: if you are an agent, set
`NAHEL_ACTOR=agent:<your-id>` so every journal event carries your identity.

## Pick the tier

- `seed` (~5 minutes): quick prototype ideas — the minimum grounding for
  honest interactive work.
- `standard`: seed at full depth, plus ADRs, routing, a doctor-proven run
  contract, and an initial decomposition — the bar for delegating anything.
- `full`: deferred — its procedure does not ship yet. If asked for it, run
  `standard` and say so; never record a tier whose work was not done.

The argument, if given, names the tier; otherwise ask. The tier is recorded
as the LAST step of its section — recording is a claim the work above it
happened.

## Brownfield: mine first

If the repo already has code: MINE FIRST, interview second. Draft the
constitution, architecture notes, and glossary from the code, README, existing
docs, and git history, then present the drafts for correction — the human
corrects concrete drafts instead of answering blank questions. Wrong guesses
are fine; they surface the truth faster than empty prompts. Then run the tier
steps below with the drafts as your starting answers.

## Seed tier (~5 minutes)

1. If `nahel/` does not exist yet, run `nahel init` — scaffold only; this
   workflow fills what init stubs.
2. Constitution: interview for the project goal, hard constraints, and
   non-goals — grill until each is concrete enough to refuse work with.
   Write them into the constitution document (config `knowledge.product`,
   PRODUCT.md by convention). The constitution is the human's: read it back
   and get explicit sign-off.
3. Governance: ask who owns product and architecture legislation — `human`
   (agents propose, the human approves) or `delegated` (agent consensus;
   enforced by a later phase). New projects almost always start all-human:

       nahel config set governance --data product=human --data architecture=human

4. Glossary seed: put the domain terms the interview surfaced (aim for 3–10)
   into the glossary document (config `knowledge.context`, CONTEXT.md by
   convention) — exact meanings, not prose.
5. Run contract stub: how does the app launch, seed, and test? Best-known
   commands are fine at seed tier — `nahel doctor` proves them later, and a
   wrong stub found by doctor beats no stub at all:

       nahel config set contract \
         --data launch="<command>" --data seed="<command>" --data test="<command>"

6. First work: capture what founding surfaced as at least one `plan` item —
   backlog truth beats memory:

       nahel item new plan <slug> direct

7. Record the tier: `nahel config set inception --data tier=seed`.

## Standard tier

Steps 1–6 at full depth (constitution grilled hard, contract complete, no
stubs), then:

8. ADR seeding: record each founding architecture decision — context,
   decision, consequences, one document per decision — under the config
   `knowledge.adr` directory, numbered sequentially.
9. Routing: run the setup-routing workflow (`nahel/workflows/setup-routing.md`)
   to detect the available agent CLIs and write the responsibility map.
10. Run contract, proven: complete launch/seed/test plus healthcheck, ports,
    and required env var NAMES (values stay in gitignored env files, never in
    state), then prove it — `nahel doctor` must exit 0 on this machine.
11. Initial decomposition: turn the goal into first real work items with
    `parent`/`depends_on` edges (`nahel item new`, `nahel item update`) so
    the backlog is actionable, not one vague item.
12. Record the tier: `nahel config set inception --data tier=standard`.

## Tier ratchet

Stated now, enforced by later phases: graduating any governance area to
`delegated`, or promoting a prototype to a product, REQUIRES an inception
upgrade — re-run this workflow at `standard` (or `full` once it ships) and
record the new tier via `nahel config set inception`. The tier only ratchets
up; never record a lower tier than the committed one. Interactive work needs
no inception artifacts at all — the recorded tier and the run contract gate
autonomy, nothing else.

Fallback (degraded environment): if the `nahel` CLI is unavailable, hold the
interview and draft the knowledge documents (constitution, glossary, ADRs),
but make NO config or item mutations — those are CLI-maintained state.
Record what remains undone so a CLI-equipped session can finish founding.
