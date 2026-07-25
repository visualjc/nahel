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
   and get explicit sign-off. That sign-off is RECORDED, not remembered — it
   is written with the tier (step 8, or step 13 at standard tier), and the
   HUMAN runs that command themselves. An agent-attributed signature gates
   nothing: the autonomy gate reads the actor of the act that wrote it.
3. Governance: ask who owns product and architecture legislation — `human`
   (agents propose, the human approves) or `delegated` (agent consensus:
   cross-vendor approval, journaled). The written default is
   `{product: delegated, architecture: human}`, and it matches what a project
   with NO governance config does: pushing forward is the default unless the
   human says otherwise. `governance.product: human` is the explicit brake —
   choose it when the human wants to approve every PRD personally, and expect
   Full-lane items to park at that gate. Architecture stays `human` until the
   architect slice ships. Record the answer explicitly, so the posture is
   state rather than an inferred default:

       nahel config set governance \
         --data product=delegated --data architecture=human

4. Merge authority: ask who merges a reviewed PR — `human` (the default
   everywhere: the PR waits for a person) or `on-approve` (reviewer sign-off
   merges). `on-approve` is an opt-in to use SPARINGLY —
   small items, or changes QA testing covers well; when the founder shrugs,
   the answer is `human`. Record it explicitly, so the authority is state
   rather than an inferred default:

       nahel config set merge --data authority=<human|on-approve>

   For `on-approve` the HUMAN runs that command themselves: the committed
   flip IS their standing authorization, so an agent-run set authorizes
   nothing — `nahel brief` renders it inert, the review loop behaves as
   `merge: human`, and `nahel validate` warns (`merge.unauthorized`).

5. Glossary seed: put the domain terms the interview surfaced (aim for 3–10)
   into the glossary document (config `knowledge.context`, CONTEXT.md by
   convention) — exact meanings, not prose.
6. Run contract stub: how does the app launch, seed, and test? Best-known
   commands are fine at seed tier — `nahel doctor` proves them later, and a
   wrong stub found by doctor beats no stub at all:

       nahel config set contract \
         --data launch="<command>" --data seed="<command>" --data test="<command>"

7. First work: capture what founding surfaced as at least one `plan` item —
   backlog truth beats memory:

       nahel item new plan <slug> direct

8. Record the tier — and the constitution signature with it. Both go
   in the SAME command: `config set` replaces the whole section, so a later
   tier write that omits the signature erases it. The human runs this
   themselves; their actor on the journaled act is what the autonomy gate
   reads:

       nahel config set inception \
         --data tier=seed --data constitution_signed_by=<the human's id>

## Standard tier

Steps 1–7 at full depth (constitution grilled hard, contract complete, no
stubs), then:

9. ADR seeding: record each founding architecture decision — context,
   decision, consequences, one document per decision — under the config
   `knowledge.adr` directory, numbered sequentially.
10. Routing: run the setup-routing workflow (`nahel/workflows/setup-routing.md`)
    to detect the available agent CLIs and write the responsibility map.
11. Run contract, proven: complete launch/seed/test plus healthcheck, ports,
    and required env var NAMES (values stay in gitignored env files, never in
    state), then prove it — `nahel doctor` must exit 0 on this machine.
12. Initial decomposition: turn the goal into first real work items with
    `parent`/`depends_on` edges (`nahel item new`, `nahel item update`) so
    the backlog is actionable, not one vague item.
13. Record the tier and the signature together, as in step 8 — the human runs
    it:

        nahel config set inception \
          --data tier=standard --data constitution_signed_by=<the human's id>

## Tier ratchet

Stated now, enforced by later phases: graduating any governance area to
`delegated`, or promoting a prototype to a product, REQUIRES an inception
upgrade — re-run this workflow at `standard` (or `full` once it ships) and
record the new tier via `nahel config set inception` — carrying the
constitution signature through in that same command, or the ratchet erases it.
The tier only ratchets up; never record a lower tier than the committed one.
Interactive work needs no inception artifacts at all — the recorded tier, the
signature, and the run contract gate autonomy, nothing else.

Fallback (degraded environment): if the `nahel` CLI is unavailable, hold the
interview and draft the knowledge documents (constitution, glossary, ADRs),
but make NO config or item mutations — those are CLI-maintained state.
Record what remains undone so a CLI-equipped session can finish founding.
